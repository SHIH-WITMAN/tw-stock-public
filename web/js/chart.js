/**
 * Lightweight HiDPI Canvas 2D renderer for interactive trend charts and 2x PNG export.
 * Zero external charting libraries (< 10 KB); handles null halt gaps, auto Y-zoom,
 * right-side non-overlapping endpoint labels, and crosshair hover tooltip.
 */
import { resolveLabelPositions } from './model.js';

function themeTokens(theme) {
  if (theme === 'dark') {
    return {
      bg: '#111827',
      cardBg: '#1e293b',
      cardBorder: '#334155',
      text: '#f8fafc',
      muted: '#94a3b8',
      grid: 'rgba(148,163,184,0.16)',
      zero: 'rgba(248,250,252,0.45)',
      crosshair: 'rgba(248,250,252,0.35)',
      profit: '#f87171',
      loss: '#4ade80',
    };
  }
  return {
    bg: '#ffffff',
    cardBg: '#f8fafc',
    cardBorder: '#e2e8f0',
    text: '#1e293b',
    muted: '#64748b',
    grid: 'rgba(100,116,139,0.16)',
    zero: 'rgba(30,41,59,0.42)',
    crosshair: 'rgba(30,41,59,0.3)',
    profit: '#dc2626',
    loss: '#16a34a',
  };
}

function niceTicks(minVal, maxVal, count = 6) {
  const span = Math.max(1e-6, maxVal - minVal);
  const rawStep = span / Math.max(2, count - 1);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(minVal / step) * step;
  const hi = Math.ceil(maxVal / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 0.25; v += step) {
    ticks.push(Number(v.toFixed(4)));
  }
  return { lo, hi, ticks };
}

function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

export class TrendChart {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas;
    this.tooltipEl = tooltipEl;
    this.state = null;
    this.hoverIdx = null;
    this._bindEvents();
  }

  _bindEvents() {
    const move = (clientX) => {
      if (!this.state || !this.state.dates.length) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const { padLeft, plotW } = this.state.layout;
      if (x < padLeft || x > padLeft + plotW) {
        this.hoverIdx = null;
        this.tooltipEl.hidden = true;
        this._draw();
        return;
      }
      const ratio = (x - padLeft) / Math.max(1, plotW);
      const idx = Math.max(0, Math.min(this.state.dates.length - 1, Math.round(ratio * (this.state.dates.length - 1))));
      this.hoverIdx = idx;
      this._draw();
      this._renderTooltip(idx, clientX - rect.left, rect.width);
    };

    this.canvas.addEventListener('mousemove', (e) => move(e.clientX));
    this.canvas.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) move(e.touches[0].clientX);
    }, { passive: true });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverIdx = null;
      this.tooltipEl.hidden = true;
      this._draw();
    });
  }

  _renderTooltip(idx, relX, containerW) {
    const { dates, visibleSeries, colors } = this.state;
    const tip = this.tooltipEl;
    tip.textContent = '';

    const head = document.createElement('div');
    head.className = 'tt-date';
    head.textContent = dates[idx];
    tip.appendChild(head);

    const rows = visibleSeries
      .map((s) => ({ s, val: s.values[idx] }))
      .sort((a, b) => (b.val ?? -Infinity) - (a.val ?? -Infinity));

    for (const { s, val } of rows) {
      const row = document.createElement('div');
      row.className = 'tt-row';
      const dot = document.createElement('span');
      dot.className = 'tt-dot';
      dot.style.background = colors[s.ticker];
      const lbl = document.createElement('span');
      lbl.className = 'tt-name';
      lbl.textContent = s.is_market ? s.name : `${s.ticker} ${s.name}`;
      const num = document.createElement('span');
      num.className = 'tt-val';
      num.textContent = val === null ? '停牌' : fmtPct(val);
      row.append(dot, lbl, num);
      tip.appendChild(row);
    }

    tip.hidden = false;
    const placeLeft = relX > containerW * 0.58;
    tip.style.left = placeLeft ? `${Math.max(8, relX - 210)}px` : `${Math.min(containerW - 210, relX + 14)}px`;
  }

  render({ dates, visibleSeries, colors, benchmarkTicker, theme }) {
    this.state = { dates, visibleSeries, colors, benchmarkTicker, theme, layout: null };
    this.hoverIdx = null;
    if (this.tooltipEl) this.tooltipEl.hidden = true;
    this._draw();
  }

  _draw() {
    if (!this.state) return;
    const { dates, visibleSeries, colors, benchmarkTicker, theme } = this.state;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(280, this.canvas.parentElement.clientWidth || 720);
    const height = width < 520 ? 320 : 410;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const layout = drawPlot(ctx, {
      x0: 0, y0: 0, width, height,
      dates, visibleSeries, colors, benchmarkTicker, theme,
      hoverIdx: this.hoverIdx,
      showRightLabels: width >= 540,
    });
    this.state.layout = layout;
  }
}

export function drawPlot(ctx, { x0, y0, width, height, dates, visibleSeries, colors, benchmarkTicker, theme, hoverIdx = null, showRightLabels = true }) {
  const tk = themeTokens(theme);
  const padLeft = 56;
  const padRight = showRightLabels ? 148 : 16;
  const padTop = 20;
  const padBottom = 34;
  const plotW = Math.max(60, width - padLeft - padRight);
  const plotH = Math.max(80, height - padTop - padBottom);

  ctx.fillStyle = tk.bg;
  ctx.fillRect(x0, y0, width, height);

  if (!dates.length || !visibleSeries.length) {
    ctx.fillStyle = tk.muted;
    ctx.font = '14px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('請選擇標的後檢視走勢圖', x0 + width / 2, y0 + height / 2);
    return { padLeft, plotW };
  }

  let minV = 0;
  let maxV = 0;
  for (const s of visibleSeries) {
    for (const v of s.values) {
      if (v !== null && v !== undefined) {
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
  }
  const margin = Math.max(1.5, (maxV - minV) * 0.08);
  const { lo, hi, ticks } = niceTicks(minV - margin, maxV + margin, 6);

  const xAt = (i) => x0 + padLeft + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * plotW);
  const yAt = (v) => y0 + padTop + ((hi - v) / Math.max(1e-6, hi - lo)) * plotH;

  // Horizontal grid + Y ticks
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of ticks) {
    const y = yAt(t);
    ctx.strokeStyle = Math.abs(t) < 1e-6 ? tk.zero : tk.grid;
    ctx.lineWidth = Math.abs(t) < 1e-6 ? 1.2 : 1;
    ctx.beginPath();
    ctx.moveTo(x0 + padLeft, y);
    ctx.lineTo(x0 + padLeft + plotW, y);
    ctx.stroke();
    ctx.fillStyle = tk.muted;
    ctx.fillText(`${t > 0 ? '+' : ''}${t}%`, x0 + padLeft - 8, y);
  }

  // X ticks (up to 6 evenly spaced dates)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = tk.muted;
  const xCount = Math.min(width < 520 ? 4 : 6, dates.length);
  for (let k = 0; k < xCount; k += 1) {
    const idx = Math.round((k / Math.max(1, xCount - 1)) * (dates.length - 1));
    ctx.fillText(dates[idx].slice(2).replaceAll('-', '/'), xAt(idx), y0 + padTop + plotH + 10);
  }

  // Series lines (benchmark drawn dashed on top or clearly distinct)
  const sortedForDraw = [...visibleSeries].sort((a, b) => (a.ticker === benchmarkTicker ? 1 : b.ticker === benchmarkTicker ? -1 : 0));
  for (const s of sortedForDraw) {
    const isBench = s.ticker === benchmarkTicker;
    ctx.save();
    ctx.strokeStyle = colors[s.ticker];
    ctx.lineWidth = isBench ? 2.4 : 2.1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (isBench) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < s.values.length; i += 1) {
      const v = s.values[i];
      if (v === null || v === undefined) continue; // bridge short halts cleanly
      const x = xAt(i);
      const y = yAt(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // Right-side collision-avoided endpoint labels
  if (showRightLabels) {
    const rawLabels = visibleSeries.map((s) => ({
      ticker: s.ticker,
      text: `${s.is_market ? '大盤' : s.ticker} ${fmtPct(s.total_return_pct)}`,
      color: colors[s.ticker],
      y: yAt(s.total_return_pct ?? 0),
    }));
    const placed = resolveLabelPositions(rawLabels, y0 + padTop + 8, y0 + padTop + plotH - 8, 16);
    ctx.font = 'bold 11.5px ui-monospace, SFMono-Regular, Menlo, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const item of placed) {
      ctx.fillStyle = item.color;
      ctx.fillText(item.text, x0 + padLeft + plotW + 10, item.labelY);
    }
  }

  // Hover crosshair + dots
  if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < dates.length) {
    const hx = xAt(hoverIdx);
    ctx.save();
    ctx.strokeStyle = tk.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, y0 + padTop);
    ctx.lineTo(hx, y0 + padTop + plotH);
    ctx.stroke();
    ctx.restore();
    for (const s of visibleSeries) {
      const v = s.values[hoverIdx];
      if (v === null || v === undefined) continue;
      ctx.fillStyle = colors[s.ticker];
      ctx.beginPath();
      ctx.arc(hx, yAt(v), 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { padLeft, plotW };
}

export function exportPngCard({ title, subtitle, modeLabel, dates, visibleSeries, colors, benchmarkTicker, theme, footerText }) {
  const tk = themeTokens(theme);
  const scale = 2;
  const W = 1200;
  const cardCols = Math.min(visibleSeries.length, 5);
  const cardRows = Math.ceil(visibleSeries.length / Math.max(1, cardCols));
  const cardsH = cardRows * 74 + Math.max(0, cardRows - 1) * 10;
  const plotH = 440;
  const H = 104 + cardsH + 24 + plotH + 54;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = tk.bg;
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = tk.text;
  ctx.font = 'bold 22px system-ui, -apple-system, "PingFang TC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title, 36, 28);

  ctx.fillStyle = tk.muted;
  ctx.font = '13px system-ui, -apple-system, "PingFang TC", sans-serif';
  ctx.fillText(`${subtitle} ｜ ${modeLabel}`, 36, 60);

  // Summary cards
  const gap = 10;
  const cardW = (W - 72 - gap * (cardCols - 1)) / Math.max(1, cardCols);
  visibleSeries.forEach((s, idx) => {
    const r = Math.floor(idx / cardCols);
    const c = idx % cardCols;
    const cx = 36 + c * (cardW + gap);
    const cy = 96 + r * 84;
    ctx.fillStyle = tk.cardBg;
    ctx.strokeStyle = tk.cardBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(cx, cy, cardW, 72, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = colors[s.ticker];
    ctx.fillRect(cx, cy + 10, 4, 52);

    ctx.fillStyle = tk.muted;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText(s.is_market ? s.name : `${s.ticker} ${s.name}`, cx + 14, cy + 12);

    ctx.fillStyle = colors[s.ticker];
    ctx.font = 'bold 21px ui-monospace, monospace';
    ctx.fillText(fmtPct(s.total_return_pct), cx + 14, cy + 36);
  });

  // Plot
  const plotY = 96 + cardsH + 18;
  drawPlot(ctx, {
    x0: 20, y0: plotY, width: W - 40, height: plotH,
    dates, visibleSeries, colors, benchmarkTicker, theme, showRightLabels: true,
  });

  // Footer
  ctx.fillStyle = tk.muted;
  ctx.font = '11.5px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(footerText, 36, H - 18);

  const link = document.createElement('a');
  link.download = `tw-return-trend-${dates[dates.length - 1] || 'chart'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
