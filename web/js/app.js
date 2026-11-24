/**
 * Main UI controller for tw-stock-public Phase 1.
 * Strict zero-innerHTML DOM construction (XSS-safe by construction).
 */
import {
  MAX_SERIES, MARKET_TICKER, TICKER_RE,
  assignColors, computeTrendComparison, orderCards, diffSummary,
  toggleFocus, rangeStartDate, encodeShareParams, decodeShareParams,
} from './model.js';
import { TrendChart, exportPngCard } from './chart.js';

const STORAGE_KEY = 'tw_stock_public_picks_v1';

const state = {
  manifest: null,
  calendar: [],
  catalog: null,
  seriesCache: new Map(),
  selected: ['0050', '0056', '00878', '2330'],
  includeMarket: true,
  benchmark: MARKET_TICKER,
  mode: 'total_return',
  startDate: '',
  endDate: '',
  customTitle: '',
  focused: new Set(),
  theme: 'light',
  activeTab: 'trend',
  snapshotMode: null,
  lastComputed: null,
};

const chart = new TrendChart(
  document.getElementById('trend-canvas'),
  document.getElementById('chart-tooltip'),
);

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else node.setAttribute(k, v);
  }
  if (text !== '') node.textContent = text;
  return node;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  return res.json();
}

async function loadSeries(ticker) {
  if (state.seriesCache.has(ticker)) return state.seriesCache.get(ticker);
  const url = `./${state.manifest.files.series_prefix}${ticker}.json`;
  const data = await fetchJson(url);
  state.seriesCache.set(ticker, data);
  return data;
}

function saveLocalPicks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      selected: state.selected,
      includeMarket: state.includeMarket,
      mode: state.mode,
    }));
  } catch { /* ignore private mode */ }
}

function loadLocalPicks(validSet) {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw || !Array.isArray(raw.selected)) return;
    const clean = raw.selected.filter((t) => validSet.has(t)).slice(0, MAX_SERIES - 1);
    if (clean.length) state.selected = clean;
    if (typeof raw.includeMarket === 'boolean') state.includeMarket = raw.includeMarket;
    if (raw.mode === 'price_only' || raw.mode === 'total_return') state.mode = raw.mode;
  } catch { /* ignore */ }
}

function renderPresets() {
  const bar = document.getElementById('preset-bar');
  bar.textContent = '';
  bar.appendChild(el('span', { class: 'muted' }, '觀察範本：'));
  const validSet = new Set(state.catalog.items.map((i) => i.ticker));
  for (const p of state.catalog.presets || []) {
    const b = el('button', { class: 'btn', type: 'button' }, p.label);
    b.addEventListener('click', () => {
      state.selected = p.tickers.filter((t) => validSet.has(t)).slice(0, MAX_SERIES - (p.include_market ? 1 : 0));
      state.includeMarket = Boolean(p.include_market);
      state.benchmark = state.includeMarket ? MARKET_TICKER : (state.selected[0] || '');
      state.focused.clear();
      document.getElementById('include-market').checked = state.includeMarket;
      saveLocalPicks();
      renderPicker();
      updateChart();
    });
    bar.appendChild(b);
  }
}

function renderPicker() {
  const grid = document.getElementById('ticker-grid');
  const query = document.getElementById('ticker-search').value.trim().toUpperCase();
  const cat = document.getElementById('cat-filter').value;
  grid.textContent = '';

  const maxT = MAX_SERIES - (state.includeMarket ? 1 : 0);
  const totalSelected = state.selected.length + (state.includeMarket ? 1 : 0);
  document.getElementById('selected-counter').textContent = `已選 ${state.selected.length}/${maxT} 檔（含大盤共 ${totalSelected}/${MAX_SERIES}）`;

  const items = state.catalog.items.filter((item) => {
    if (cat !== 'all' && item.category !== cat) return false;
    if (query && !item.ticker.includes(query) && !item.name.toUpperCase().includes(query)) return false;
    return true;
  });

  for (const item of items) {
    const isSel = state.selected.includes(item.ticker);
    const chip = el('button', {
      type: 'button',
      class: `ticker-chip${isSel ? ' selected' : ''}`,
    });
    chip.appendChild(el('strong', {}, `${item.ticker} ${item.name}`));
    chip.appendChild(el('span', {}, `${item.category_label} · ${item.market}`));
    chip.addEventListener('click', () => {
      if (isSel) {
        state.selected = state.selected.filter((t) => t !== item.ticker);
        if (state.benchmark === item.ticker) state.benchmark = state.includeMarket ? MARKET_TICKER : '';
      } else {
        if (state.selected.length >= maxT) {
          alert(`單次最多比較 ${MAX_SERIES} 檔（目前${state.includeMarket ? '含大盤' : '不含大盤'}上限 ${maxT} 檔）。`);
          return;
        }
        state.selected = [...state.selected, item.ticker];
      }
      state.focused.clear();
      saveLocalPicks();
      renderPicker();
      updateChart();
    });
    grid.appendChild(chip);
  }

  // Update benchmark select options
  const bSel = document.getElementById('benchmark-select');
  bSel.textContent = '';
  bSel.appendChild(el('option', { value: '' }, '不設比較基準'));
  if (state.includeMarket) {
    bSel.appendChild(el('option', { value: MARKET_TICKER }, `基準：${state.mode === 'price_only' ? '加權股價指數' : '加權報酬指數'}`));
  }
  const byCode = new Map(state.catalog.items.map((i) => [i.ticker, i]));
  for (const t of state.selected) {
    const meta = byCode.get(t);
    bSel.appendChild(el('option', { value: t }, `基準：${t} ${meta ? meta.name : ''}`));
  }
  const validBench = state.benchmark === '' || (state.benchmark === MARKET_TICKER && state.includeMarket) || state.selected.includes(state.benchmark);
  if (!validBench) state.benchmark = state.includeMarket ? MARKET_TICKER : '';
  bSel.value = state.benchmark;
}

function renderTrendOutput() {
  const computed = state.lastComputed;
  if (!computed) return;
  const ordered = orderCards(computed.series, state.benchmark);
  const allTickers = ordered.map((s) => s.ticker);
  const colors = assignColors(ordered, state.benchmark, state.theme);
  const benchObj = ordered.find((s) => s.ticker === state.benchmark) || null;

  const visibleSeries = state.focused.size > 0
    ? ordered.filter((s) => state.focused.has(s.ticker))
    : ordered;

  document.getElementById('btn-reset-focus').classList.toggle('hidden', state.focused.size === 0);

  const modeLabel = state.mode === 'price_only' ? '純價差報酬' : '含息報酬（除息日收盤再投入）';
  const defaultTitle = state.customTitle || `${ordered.slice(0, 3).map((s) => (s.is_market ? s.name : s.ticker)).join('、')}${ordered.length > 3 ? ` 等 ${ordered.length} 檔` : ''}｜區間比較`;
  document.getElementById('result-heading').textContent = defaultTitle;
  document.getElementById('result-meta').textContent = computed.actualStart
    ? `${computed.actualStart} ～ ${computed.actualEnd}（${computed.dates.length} 交易日 · ${modeLabel}）`
    : '尚無可顯示曲線';

  // Cards
  const cardsGrid = document.getElementById('cards-grid');
  cardsGrid.textContent = '';
  for (const s of ordered) {
    const isFocused = state.focused.size === 0 || state.focused.has(s.ticker);
    const card = el('button', {
      type: 'button',
      class: `stat-card${state.focused.size > 0 ? (isFocused ? ' focused' : ' dimmed') : ''}`,
      style: `border-top-color:${colors[s.ticker]}`,
    });
    card.appendChild(el('div', { class: 'sc-code' }, s.is_market ? `${s.ticker} ---` : s.ticker));
    card.appendChild(el('div', { class: 'sc-name' }, s.name));
    const valStr = s.total_return_pct > 0 ? `+${s.total_return_pct.toFixed(2)}%` : `${s.total_return_pct.toFixed(2)}%`;
    card.appendChild(el('div', { class: 'sc-val', style: `color:${colors[s.ticker]}` }, valStr));

    if (benchObj && s.ticker === benchObj.ticker) {
      card.appendChild(el('div', { class: 'sc-diff flat' }, '比較基準（點選可聚焦）'));
    } else if (benchObj) {
      const d = diffSummary(s.total_return_pct, benchObj.total_return_pct);
      card.appendChild(el('div', { class: `sc-diff ${d.direction}` }, d.text));
    } else {
      card.appendChild(el('div', { class: 'sc-diff flat' }, '點選卡片複選比對'));
    }

    card.addEventListener('click', () => {
      state.focused = toggleFocus(state.focused, s.ticker, state.benchmark, allTickers);
      renderTrendOutput();
    });
    cardsGrid.appendChild(card);
  }

  // Chart
  chart.render({
    dates: computed.dates,
    visibleSeries,
    colors,
    benchmarkTicker: state.benchmark,
    theme: state.theme,
  });

  // Halt note
  const haltEl = document.getElementById('halt-note');
  if (computed.haltNote) {
    haltEl.textContent = computed.haltNote;
    haltEl.classList.remove('hidden');
  } else {
    haltEl.classList.add('hidden');
  }

  // Excluded box (with one-click earliest-date retry button)
  const exBox = document.getElementById('excluded-box');
  exBox.textContent = '';
  if (computed.excluded.length > 0) {
    const title = el('div', { class: 'muted', style: 'font-weight:700;margin-bottom:6px' }, `未列入圖表（${computed.excluded.length} 檔）：`);
    exBox.appendChild(title);
    for (const item of computed.excluded) {
      const row = el('div', { class: 'row muted', style: 'margin-bottom:4px' });
      row.appendChild(el('span', {}, `${item.ticker} ${item.name}：${item.reason}`));
      if (item.earliest_date) {
        const btn = el('button', { class: 'btn', type: 'button', style: 'padding:2px 8px;font-size:0.75rem' }, `改從 ${item.earliest_date} 起算重比`);
        btn.addEventListener('click', () => {
          state.startDate = item.earliest_date;
          document.getElementById('start-date').value = state.startDate;
          updateChart();
        });
        row.appendChild(btn);
      }
      exBox.appendChild(row);
    }
  }
}

async function updateChart() {
  const tickersToLoad = [...state.selected];
  if (state.includeMarket) tickersToLoad.unshift(MARKET_TICKER);
  if (tickersToLoad.length === 0) {
    state.lastComputed = { dates: [], series: [], excluded: [], actualStart: null, actualEnd: null, haltNote: null };
    renderTrendOutput();
    return;
  }
  const loaded = await Promise.all(tickersToLoad.map((t) => loadSeries(t)));
  state.lastComputed = computeTrendComparison(loaded, state.calendar, {
    startDate: state.startDate,
    endDate: state.endDate,
    mode: state.mode,
  });
  renderTrendOutput();
}

function renderEtfTable() {
  const cat = document.getElementById('etf-cat-filter').value;
  const sortBy = document.getElementById('etf-sort').value;
  const years = state.catalog.years || [];
  document.getElementById('survivorship-notice').textContent = state.catalog.survivorship_notice || '';

  // Show category median note for bond / foreign_equity
  const medBar = document.getElementById('category-median-bar');
  const medians = state.catalog.category_medians || {};
  if (cat === 'bond' || cat === 'foreign_equity') {
    const m = medians[cat] || {};
    const parts = years.map((y) => (m[String(y)] !== undefined ? `${y}年：${m[String(y)] > 0 ? '+' : ''}${m[String(y)].toFixed(2)}%` : null)).filter(Boolean);
    medBar.textContent = `同類別年度中位數參考（不與台股加權報酬指數比較）：${parts.join(' ｜ ') || '無'}`;
  } else {
    medBar.textContent = '註：「年度勝大盤」僅針對台股股票型 ETF 計算（不含今年 YTD），債券型與國外成分 ETF 不適用台股大盤基準。';
  }

  let rows = state.catalog.items.filter((i) => i.type === 'ETF' && (cat === 'all' || i.category === cat));
  rows = [...rows].sort((a, b) => {
    if (sortBy === '1y') return (b.rolling?.['1y'] ?? -Infinity) - (a.rolling?.['1y'] ?? -Infinity);
    if (sortBy === 'ytd') return (b.rolling?.ytd ?? -Infinity) - (a.rolling?.ytd ?? -Infinity);
    if (sortBy === 'wins') return (b.beat_wins ?? -1) - (a.beat_wins ?? -1) || a.ticker.localeCompare(b.ticker);
    return a.ticker.localeCompare(b.ticker);
  });

  const table = document.getElementById('etf-table');
  table.textContent = '';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['代號', '名稱', '類別', '今年以來', '近 1 年', '勝大盤（完整年）', ...years.map((y) => `${y} 年`)]) {
    hr.appendChild(el('th', {}, label));
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const fmtCell = (val) => {
    if (val === null || val === undefined) return el('td', { class: 'num-flat' }, '—');
    const cls = val > 0 ? 'num-pos' : val < 0 ? 'num-neg' : 'num-flat';
    return el('td', { class: cls }, `${val > 0 ? '+' : ''}${val.toFixed(2)}%`);
  };

  for (const item of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', {}, item.ticker));
    tr.appendChild(el('td', {}, item.name));
    tr.appendChild(el('td', { class: 'muted' }, item.category_label));
    tr.appendChild(fmtCell(item.rolling?.ytd));
    tr.appendChild(fmtCell(item.rolling?.['1y']));
    const winText = item.benchmark_eligible
      ? `${item.beat_wins ?? 0} / ${item.comparable_years ?? 0}`
      : '不適用台股基準';
    tr.appendChild(el('td', { class: 'num-flat' }, winText));

    const byY = new Map((item.calendar_returns || []).map((r) => [r.year, r]));
    for (const y of years) {
      const rec = byY.get(y);
      tr.appendChild(fmtCell(rec ? rec.total_ret_pct : null));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function renderStatus() {
  const box = document.getElementById('status-body');
  box.textContent = '';
  const m = state.manifest;
  const rows = [
    ['目前資料版本', m.version],
    ['最後收盤資料日期', m.data_date],
    ['管線建置時間', m.built_at],
    ['演算法版本', m.algorithm_version],
    ['資料模式', m.source_mode === 'synthetic_demo' ? '離線合成驗證模式（試跑示範）' : '官方 TWSE／TPEx 盤後衍生指數'],
    ['收錄標的數量', `${m.ticker_count} 檔（含 2 條大盤基準指數）`],
    ['交易日曆天數', `${m.calendar_days} 個交易日`],
    ['前端資料發布界線', '僅發布本站計算之衍生累積指數（TRI／PRI），不提供原始收盤價檔案下載'],
  ];

  const tbl = document.createElement('table');
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('th', {}, k));
    tr.appendChild(el('td', { style: 'text-align:left' }, String(v)));
    tbl.appendChild(tr);
  }
  box.appendChild(tbl);

  box.appendChild(el('h3', { style: 'margin:16px 0 6px;font-size:0.9rem' }, '資料來源顯名'));
  const ul = document.createElement('ul');
  for (const s of m.sources || []) {
    ul.appendChild(el('li', { class: 'muted' }, `${s.name}：${s.items}`));
  }
  box.appendChild(ul);

  box.appendChild(el('h3', { style: 'margin:16px 0 6px;font-size:0.9rem' }, '本版資料健檢警示'));
  if (!m.warnings || m.warnings.length === 0) {
    box.appendChild(el('div', { class: 'muted' }, '無異常警示（官方參考價閘門全數通過）。'));
  } else {
    const wul = document.createElement('ul');
    for (const w of m.warnings) wul.appendChild(el('li', { class: 'muted' }, w));
    box.appendChild(wul);
  }
}

function bindControls() {
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      ['trend', 'etf', 'status'].forEach((id) => {
        document.getElementById(`tab-${id}`).classList.toggle('hidden', id !== state.activeTab);
      });
      if (state.activeTab === 'trend') renderTrendOutput();
    });
  });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', state.theme);
    document.getElementById('theme-toggle').textContent = state.theme === 'dark' ? '淺色主題' : '深色主題';
    renderTrendOutput();
  });

  document.getElementById('ticker-search').addEventListener('input', renderPicker);
  document.getElementById('cat-filter').addEventListener('change', renderPicker);
  document.getElementById('include-market').addEventListener('change', (e) => {
    state.includeMarket = e.target.checked;
    const maxT = MAX_SERIES - (state.includeMarket ? 1 : 0);
    if (state.selected.length > maxT) state.selected = state.selected.slice(0, maxT);
    state.benchmark = state.includeMarket ? MARKET_TICKER : (state.benchmark === MARKET_TICKER ? '' : state.benchmark);
    state.focused.clear();
    saveLocalPicks();
    renderPicker();
    updateChart();
  });
  document.getElementById('btn-clear').addEventListener('click', () => {
    state.selected = [];
    state.focused.clear();
    saveLocalPicks();
    renderPicker();
    updateChart();
  });

  document.getElementById('start-date').addEventListener('change', (e) => {
    state.startDate = e.target.value;
    updateChart();
  });
  document.getElementById('end-date').addEventListener('change', (e) => {
    state.endDate = e.target.value;
    updateChart();
  });
  document.getElementById('calc-mode').addEventListener('change', (e) => {
    state.mode = e.target.value;
    saveLocalPicks();
    renderPicker();
    updateChart();
  });
  document.getElementById('benchmark-select').addEventListener('change', (e) => {
    state.benchmark = e.target.value;
    state.focused.clear();
    renderTrendOutput();
  });

  document.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const end = state.calendar[state.calendar.length - 1];
      state.endDate = end;
      state.startDate = rangeStartDate(end, btn.dataset.range);
      document.getElementById('start-date').value = state.startDate;
      document.getElementById('end-date').value = state.endDate;
      updateChart();
    });
  });

  document.getElementById('btn-reset-focus').addEventListener('click', () => {
    state.focused.clear();
    renderTrendOutput();
  });

  const copyShare = async (pinSnapshot) => {
    const qs = encodeShareParams({
      tickers: state.selected,
      includeMarket: state.includeMarket,
      startDate: state.startDate,
      endDate: state.endDate,
      mode: state.mode,
      benchmark: state.benchmark,
      title: state.customTitle,
      snapshotVersion: pinSnapshot ? state.manifest.version : null,
    });
    const url = `${window.location.origin}${window.location.pathname}?${qs}`;
    try {
      await navigator.clipboard.writeText(url);
      alert(pinSnapshot ? '已複製「固定快照」分享連結！' : '已複製「最新資料」分享連結！');
    } catch {
      prompt('請複製以下分享連結：', url);
    }
  };
  document.getElementById('btn-share-latest').addEventListener('click', () => copyShare(false));
  document.getElementById('btn-share-snap').addEventListener('click', () => copyShare(true));

  // Config export / import (cross-device sync without login/Firestore!)
  document.getElementById('btn-export-cfg').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({
      version: 1,
      selected: state.selected,
      includeMarket: state.includeMarket,
      mode: state.mode,
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tw-stock-public-picks.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const fileInput = document.getElementById('import-file');
  document.getElementById('btn-import-cfg').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file || file.size > 32768) {
      alert('設定檔無效或檔案過大。');
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      const validSet = new Set(state.catalog.items.map((i) => i.ticker));
      const clean = (parsed.selected || []).filter((t) => TICKER_RE.test(t) && validSet.has(t)).slice(0, MAX_SERIES - 1);
      if (!clean.length) throw new Error('empty');
      state.selected = clean;
      state.includeMarket = Boolean(parsed.includeMarket);
      state.mode = parsed.mode === 'price_only' ? 'price_only' : 'total_return';
      document.getElementById('include-market').checked = state.includeMarket;
      document.getElementById('calc-mode').value = state.mode;
      saveLocalPicks();
      renderPicker();
      updateChart();
    } catch {
      alert('無法解析設定檔，請確認為本站匯出之 JSON 格式。');
    } finally {
      fileInput.value = '';
    }
  });

  document.getElementById('etf-cat-filter').addEventListener('change', renderEtfTable);
  document.getElementById('etf-sort').addEventListener('change', renderEtfTable);
  window.addEventListener('resize', () => {
    if (state.activeTab === 'trend') renderTrendOutput();
  });
}

async function init() {
  bindControls();
  const latest = await fetchJson('./data/latest.json');
  const urlQuery = new URLSearchParams(window.location.search);
  const reqVer = urlQuery.get('ver');
  let manifestUrl = `./${latest.manifest_url}`;
  if (reqVer && /^[0-9]{8}-[0-9]{6}$/.test(reqVer)) {
    manifestUrl = `./data/v/${reqVer}/manifest.json`;
    state.snapshotMode = reqVer;
  }
  try {
    state.manifest = await fetchJson(manifestUrl);
  } catch {
    state.snapshotMode = null;
    state.manifest = await fetchJson(`./${latest.manifest_url}`);
  }

  const [calJson, catalogJson] = await Promise.all([
    fetchJson(`./${state.manifest.files.calendar}`),
    fetchJson(`./${state.manifest.files.catalog}`),
  ]);
  state.calendar = calJson.dates;
  state.catalog = catalogJson;

  const badge = document.getElementById('data-date-badge');
  badge.textContent = `資料截至 ${state.manifest.data_date}${state.manifest.source_mode === 'synthetic_demo' ? '（合成試跑）' : ''}`;

  if (state.snapshotMode) {
    const b = document.getElementById('snapshot-banner');
    b.textContent = `目前顯示固定快照版本 ${state.manifest.version}（資料截至 ${state.manifest.data_date}），不會隨後續盤後更新變動。`;
    b.classList.remove('hidden');
  }

  const validSet = new Set(state.catalog.items.map((i) => i.ticker));
  state.selected = state.selected.filter((t) => validSet.has(t));
  if (state.selected.length === 0) {
    state.selected = state.catalog.items.slice(0, 4).map((i) => i.ticker);
  }
  const latestDate = state.calendar[state.calendar.length - 1];
  state.endDate = latestDate;
  state.startDate = rangeStartDate(latestDate, '1y');

  loadLocalPicks(validSet);
  const shared = decodeShareParams(window.location.search, validSet);
  if (shared) {
    state.selected = shared.tickers;
    state.includeMarket = shared.includeMarket;
    state.mode = shared.mode;
    state.benchmark = shared.benchmark;
    if (shared.startDate) state.startDate = shared.startDate;
    if (shared.endDate) state.endDate = shared.endDate;
    state.customTitle = shared.title;
  }

  document.getElementById('include-market').checked = state.includeMarket;
  document.getElementById('calc-mode').value = state.mode;
  document.getElementById('start-date').value = state.startDate;
  document.getElementById('end-date').value = state.endDate;

  renderPresets();
  renderPicker();
  renderEtfTable();
  renderStatus();
  await updateChart();
}

init().catch((err) => {
  const badge = document.getElementById('data-date-badge');
  badge.textContent = `資料載入失敗：${err.message}`;
});
