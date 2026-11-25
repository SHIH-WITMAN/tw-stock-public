/**
 * Main UI controller for tw-stock-public Phase 1 (Layout A).
 * Strict zero-innerHTML DOM construction (XSS-safe by construction).
 */
import {
  MAX_SERIES, MARKET_TICKER,
  assignColors, computeTrendComparison, orderCards, diffSummary,
  toggleFocus, rangeStartDate, encodeShareParams, decodeShareParams,
} from './model.js';
import { TrendChart } from './chart.js';

const STORAGE_KEY = 'tw_stock_public_picks_v1';
const CATEGORY_GROUPS = [
  { key: 'tw_equity', label: '台股股票型 ETF' },
  { key: 'foreign_equity', label: '國外成分股 ETF' },
  { key: 'bond', label: '債券型 ETF' },
  { key: 'tw_stock', label: '台股權值股' },
  { key: 'all', label: '全部已收錄' },
];

const state = {
  manifest: null,
  calendar: [],
  catalog: null,
  seriesCache: new Map(),
  selected: ['0050', '0056', '00878', '2330'],
  includeMarket: true,
  benchmark: MARKET_TICKER,
  mode: 'total_return',
  lateMode: 'strict',
  allowAutoAlign: true,
  startDate: '',
  endDate: '',
  focused: new Set(),
  theme: 'light',
  activeTab: 'trend',
  drawerOpen: true,
  drawerCat: 'tw_equity',
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
      lateMode: state.lateMode,
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

function toggleTickerSelection(ticker) {
  const maxT = MAX_SERIES - (state.includeMarket ? 1 : 0);
  if (state.selected.includes(ticker)) {
    state.selected = state.selected.filter((t) => t !== ticker);
    if (state.benchmark === ticker) state.benchmark = state.includeMarket ? MARKET_TICKER : '';
  } else {
    if (state.selected.length >= maxT) {
      alert(`單次最多比較 ${MAX_SERIES} 檔（目前${state.includeMarket ? '含大盤' : '不含大盤'}上限 ${maxT} 檔）。`);
      return;
    }
    state.selected = [...state.selected, ticker];
  }
  state.focused.clear();
  saveLocalPicks();
  state.allowAutoAlign = true;
  renderPicker();
  updateChart();
}

function renderPresets() {
  const sel = document.getElementById('preset-select');
  sel.textContent = '';
  sel.appendChild(el('option', { value: '' }, '⚡ 快速組合 ▾'));
  const presets = state.catalog.presets || [];
  presets.forEach((p, idx) => {
    sel.appendChild(el('option', { value: String(idx) }, p.label));
  });
}

function renderSelectedChips(byCode) {
  const box = document.getElementById('selected-chips');
  box.textContent = '';

  if (state.includeMarket) {
    const mPill = el('button', {
      type: 'button',
      class: 'sel-pill market-pill',
      title: `點擊取消 ${state.mode === 'price_only' ? '加權股價指數' : '加權報酬指數'}`,
    });
    mPill.appendChild(el('code', {}, 'TAIEX'));
    mPill.appendChild(el('span', {}, '大盤'));
    mPill.appendChild(el('span', { class: 'pill-x' }, '✕'));
    mPill.addEventListener('click', () => {
      state.includeMarket = false;
      document.getElementById('include-market').checked = false;
      if (state.benchmark === MARKET_TICKER) state.benchmark = state.selected[0] || '';
      state.focused.clear();
      saveLocalPicks();
      renderPicker();
      updateChart();
    });
    box.appendChild(mPill);
  }

  for (const code of state.selected) {
    const meta = byCode.get(code);
    const pill = el('button', {
      type: 'button',
      class: 'sel-pill',
      title: meta ? `${code} ${meta.name}（點擊移除）` : `點擊移除 ${code}`,
    });
    pill.appendChild(el('code', {}, code));
    pill.appendChild(el('span', { class: 'pill-x' }, '✕'));
    pill.addEventListener('click', () => toggleTickerSelection(code));
    box.appendChild(pill);
  }

  if (!state.includeMarket && state.selected.length === 0) {
    box.appendChild(el('span', { class: 'muted' }, '尚未選取標的（請由下方分類卡片或右上角快速組合點選）'));
  }
}

function renderSearchDropdown() {
  const input = document.getElementById('ticker-search');
  const drop = document.getElementById('search-dropdown');
  const query = input.value.trim().toUpperCase();
  if (!query) {
    drop.classList.add('hidden');
    drop.textContent = '';
    return;
  }

  const matches = state.catalog.items.filter(
    (item) => item.ticker.includes(query) || item.name.toUpperCase().includes(query) || item.category_label.includes(query),
  ).slice(0, 12);

  drop.textContent = '';
  if (matches.length === 0) {
    drop.appendChild(el('div', { class: 'muted', style: 'padding:8px 10px' }, '找不到符合之已收錄標的'));
  } else {
    for (const item of matches) {
      const isSel = state.selected.includes(item.ticker);
      const row = el('button', {
        type: 'button',
        class: `search-item${isSel ? ' selected' : ''}`,
      });
      const left = el('span', {});
      left.appendChild(el('strong', { style: 'font-family:ui-monospace,monospace;margin-right:6px' }, item.ticker));
      left.appendChild(el('span', {}, item.name));
      const right = el('span', { class: 'muted' }, `${item.category_label} · ${isSel ? '已選 ✓' : '＋加入'}`);
      row.append(left, right);
      row.addEventListener('click', () => {
        toggleTickerSelection(item.ticker);
        input.value = '';
        drop.classList.add('hidden');
      });
      drop.appendChild(row);
    }
  }
  drop.classList.remove('hidden');
}

function renderCategoryDrawer() {
  const drawer = document.getElementById('category-drawer');
  const toggleBtn = document.getElementById('btn-toggle-drawer');
  const totalCount = state.catalog.items.length;
  toggleBtn.textContent = state.drawerOpen
    ? `▲ 收合`
    : `▼ 展開（共 ${totalCount} 檔）`;
  toggleBtn.setAttribute('aria-expanded', state.drawerOpen ? 'true' : 'false');
  drawer.classList.toggle('hidden', !state.drawerOpen);

  const tabsBox = document.getElementById('drawer-cat-tabs');
  tabsBox.textContent = '';
  const counts = {};
  for (const item of state.catalog.items) {
    counts[item.category] = (counts[item.category] || 0) + 1;
  }
  counts.all = totalCount;

  // Ensure active drawer category has items
  if (state.drawerCat !== 'all' && !counts[state.drawerCat]) {
    const firstNonEmpty = CATEGORY_GROUPS.find((g) => counts[g.key] > 0);
    state.drawerCat = firstNonEmpty ? firstNonEmpty.key : 'all';
  }

  for (const grp of CATEGORY_GROUPS) {
    const c = counts[grp.key] || 0;
    if (c === 0 && grp.key !== 'all') continue;
    const tBtn = el('button', {
      type: 'button',
      class: `cat-tab${state.drawerCat === grp.key ? ' active' : ''}`,
    }, `${grp.label} (${c})`);
    tBtn.addEventListener('click', () => {
      state.drawerCat = grp.key;
      renderCategoryDrawer();
    });
    tabsBox.appendChild(tBtn);
  }

  const grid = document.getElementById('ticker-grid');
  grid.textContent = '';
  const items = state.catalog.items.filter(
    (item) => state.drawerCat === 'all' || item.category === state.drawerCat,
  );
  for (const item of items) {
    const isSel = state.selected.includes(item.ticker);
    const chip = el('button', {
      type: 'button',
      class: `ticker-chip${isSel ? ' selected' : ''}`,
      title: `${item.ticker} ${item.name}（${item.category_label} · ${item.market}）`,
    });
    const main = el('span', { class: 'tc-main' });
    main.appendChild(el('strong', {}, item.ticker));
    main.appendChild(el('span', { class: 'tc-name' }, item.name));
    chip.appendChild(main);
    if (isSel) chip.appendChild(el('span', { class: 'tc-check' }, '✓'));
    chip.addEventListener('click', () => toggleTickerSelection(item.ticker));
    grid.appendChild(chip);
  }
}

function renderPicker() {
  const maxT = MAX_SERIES - (state.includeMarket ? 1 : 0);
  const totalSelected = state.selected.length + (state.includeMarket ? 1 : 0);
  document.getElementById('selected-counter').textContent = `已選 ${state.selected.length}/${maxT} 檔（含大盤共 ${totalSelected}/${MAX_SERIES}）`;

  const byCode = new Map(state.catalog.items.map((i) => [i.ticker, i]));
  renderSelectedChips(byCode);
  renderCategoryDrawer();
  renderSearchDropdown();

  // Update benchmark select options
  const bSel = document.getElementById('benchmark-select');
  bSel.textContent = '';
  bSel.appendChild(el('option', { value: '' }, '不設比較基準'));
  if (state.includeMarket) {
    bSel.appendChild(el('option', { value: MARKET_TICKER }, `基準：${state.mode === 'price_only' ? '加權股價指數' : '加權報酬指數'}`));
  }
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
  const defaultTitle = `${ordered.slice(0, 3).map((s) => (s.is_market ? s.name : s.ticker)).join('、')}${ordered.length > 3 ? ` 等 ${ordered.length} 檔` : ''}｜區間比較`;
  document.getElementById('result-heading').textContent = defaultTitle;
  document.getElementById('result-meta').textContent = computed.actualStart
    ? `${computed.actualStart} ～ ${computed.actualEnd} 盤後收盤（${computed.dates.length} 交易日 · ${modeLabel}）`
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
    } else if (benchObj && s.late_start_date) {
      card.appendChild(el('div', { class: 'sc-diff flat' }, '不同起算日，不計超額'));
    } else if (benchObj) {
      const d = diffSummary(s.total_return_pct, benchObj.total_return_pct);
      card.appendChild(el('div', { class: `sc-diff ${d.direction}` }, d.text));
    } else {
      card.appendChild(el('div', { class: 'sc-diff flat' }, '點選卡片複選比對'));
    }
    if (s.late_start_date) {
      card.appendChild(el('div', { class: 'sc-badge' }, `自 ${s.late_start_date} 上市起算`));
    } else if (s.start_carried_from) {
      card.appendChild(el('div', { class: 'sc-badge' }, `沿用 ${s.start_carried_from} 停牌前基準`));
    }

    card.addEventListener('click', () => {
      state.focused = toggleFocus(state.focused, s.ticker, state.benchmark, allTickers);
      renderTrendOutput();
    });
    cardsGrid.appendChild(card);
  }

  // Prominent top banners (between summary cards and chart)
  const bannersEl = document.getElementById('chart-banners');
  bannersEl.textContent = '';
  if (computed.autoAligned) {
    const b = el('div', { class: 'banner banner-info' });
    b.appendChild(el(
      'span',
      {},
      `ℹ️ ${computed.autoAligned.tickers.join('、')} 較晚掛牌，已自動改從 ${computed.autoAligned.alignedStart} 與大盤同起點公平比較`,
    ));
    const actions = el('div', { class: 'banner-actions' });
    const backBtn = el('button', { class: 'btn btn-sm', type: 'button' }, `切回原起算日 ${computed.autoAligned.originalStart}`);
    backBtn.addEventListener('click', () => {
      state.allowAutoAlign = false;
      updateChart();
    });
    actions.appendChild(backBtn);
    b.appendChild(actions);
    bannersEl.appendChild(b);
  }

  const lateExcluded = computed.excluded.filter((e) => !e.is_market && e.earliest_date);
  if (lateExcluded.length > 0 && computed.commonEarliestDate) {
    const b = el('div', { class: 'banner banner-warn' });
    const names = lateExcluded.map((e) => `${e.ticker} ${e.name}`).join('、');
    b.appendChild(el(
      'span',
      {},
      `⚠️ ${names} 較晚掛牌，目前起算日（${computed.actualStart}）未列入圖表`,
    ));
    const actions = el('div', { class: 'banner-actions' });
    const alignBtn = el('button', { class: 'btn btn-sm primary', type: 'button' }, `一鍵改從共同起點 ${computed.commonEarliestDate} 重比`);
    alignBtn.addEventListener('click', () => {
      state.startDate = computed.commonEarliestDate;
      state.allowAutoAlign = true;
      document.getElementById('start-date').value = state.startDate;
      updateChart();
    });
    actions.appendChild(alignBtn);
    b.appendChild(actions);
    bannersEl.appendChild(b);
  }

  if (computed.startHaltNote) {
    const b = el('div', { class: 'banner banner-info' });
    b.appendChild(el('span', {}, `ℹ️ ${computed.startHaltNote}`));
    bannersEl.appendChild(b);
  }
  if (computed.endAlignNote) {
    const b = el('div', { class: 'banner banner-info' });
    b.appendChild(el('span', {}, `ℹ️ ${computed.endAlignNote}`));
    bannersEl.appendChild(b);
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

  // Excluded box (detailed reasons + per-ticker button)
  const exBox = document.getElementById('excluded-box');
  exBox.textContent = '';
  if (computed.excluded.length > 0) {
    const title = el('div', { class: 'muted', style: 'font-weight:700;margin-bottom:6px' }, `未列入圖表（${computed.excluded.length} 檔）：`);
    exBox.appendChild(title);
    for (const item of computed.excluded) {
      const row = el('div', { class: 'row muted', style: 'margin-bottom:4px' });
      row.appendChild(el('span', {}, `${item.ticker} ${item.name}：${item.reason}`));
      if (item.earliest_date) {
        const btn = el('button', { class: 'btn btn-sm', type: 'button' }, `改從 ${item.earliest_date} 起算重比`);
        btn.addEventListener('click', () => {
          state.startDate = item.earliest_date;
          state.allowAutoAlign = true;
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
    state.lastComputed = {
      dates: [], series: [], excluded: [], actualStart: null, actualEnd: null,
      haltNote: null, startHaltNote: null, endAlignNote: null, autoAligned: null,
      lateEntryTickers: [], commonEarliestDate: null,
    };
    renderTrendOutput();
    return;
  }
  const loaded = await Promise.all(tickersToLoad.map((t) => loadSeries(t)));
  state.lastComputed = computeTrendComparison(loaded, state.calendar, {
    startDate: state.startDate,
    endDate: state.endDate,
    mode: state.mode,
    lateMode: state.lateMode,
    allowAutoAlign: state.allowAutoAlign,
  });
  renderTrendOutput();
}

function renderEtfTable() {
  const cat = document.getElementById('etf-cat-filter').value;
  const sortBy = document.getElementById('etf-sort').value;
  const years = state.catalog.years || [];
  const asOf = state.catalog.as_of || state.manifest?.data_date || '';
  const shortDate = asOf && asOf.length >= 10 ? asOf.slice(5).replace('-', '/') : '';
  const etfAsof = document.getElementById('etf-asof-badge');
  if (etfAsof && asOf) {
    etfAsof.textContent = `（依 ${asOf} 盤後收盤基準 · 含息再投入）`;
  }
  document.getElementById('survivorship-notice').textContent = state.catalog.survivorship_notice || '';

  const medBar = document.getElementById('category-median-bar');
  const medians = state.catalog.category_medians || {};
  const baseNote = '註：全表「年度勝大盤」均以「加權報酬指數（TAIEX）」為統一對照基準（不含今年 YTD）；國外成分股與債券型另涉匯率及資產波動差異，僅作跨類別機會成本對照參考。';
  if (cat === 'bond' || cat === 'foreign_equity') {
    const m = medians[cat] || {};
    const parts = years.map((y) => (m[String(y)] !== undefined ? `${y}年：${m[String(y)] > 0 ? '+' : ''}${m[String(y)].toFixed(2)}%` : null)).filter(Boolean);
    medBar.textContent = `${baseNote} 同類別年度中位數：${parts.join(' ｜ ') || '無'}`;
  } else {
    medBar.textContent = baseNote;
  }

  let rows = state.catalog.items
    .filter((i) => i.type === 'ETF' && (cat === 'all' || i.category === cat))
    .map((i) => ({ ...i, is_benchmark: false }));

  const bench = state.catalog.benchmark ? { ...state.catalog.benchmark, is_benchmark: true } : null;
  if (bench && (sortBy === '1y' || sortBy === 'ytd')) {
    rows.push(bench);
  }

  rows = [...rows].sort((a, b) => {
    if (sortBy === '1y') return (b.rolling?.['1y'] ?? -Infinity) - (a.rolling?.['1y'] ?? -Infinity);
    if (sortBy === 'ytd') return (b.rolling?.ytd ?? -Infinity) - (a.rolling?.ytd ?? -Infinity);
    if (sortBy === 'wins') return (b.beat_wins ?? -1) - (a.beat_wins ?? -1) || (b.rolling?.['1y'] ?? -Infinity) - (a.rolling?.['1y'] ?? -Infinity);
    return a.ticker.localeCompare(b.ticker);
  });

  if (bench && sortBy !== '1y' && sortBy !== 'ytd') {
    rows.unshift(bench);
  }

  const table = document.getElementById('etf-table');
  table.textContent = '';

  const priceColLabel = shortDate ? `收盤 (${shortDate})` : '最新收盤';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['排名', '代號', '名稱', '類別', priceColLabel, '今年以來', '近 1 年', '勝大盤', ...years.map((y) => `${y} 年`)]) {
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

  let rankNum = 0;
  for (const item of rows) {
    if (item.is_benchmark) {
      const tr = el('tr', { class: 'row-benchmark' });
      const rTd = el('td', { class: 'rank-cell' });
      rTd.appendChild(el('span', { class: 'bench-pill' }, '基準'));
      tr.appendChild(rTd);
      tr.appendChild(el('td', {}, item.ticker));
      tr.appendChild(el('td', {}, `★ ${item.name}`));
      tr.appendChild(el('td', { class: 'muted' }, item.category_label || '大盤對照'));
      const idxText = item.last_close != null ? `${Number(item.last_close).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
      tr.appendChild(el('td', {}, idxText));
      tr.appendChild(fmtCell(item.rolling?.ytd));
      tr.appendChild(fmtCell(item.rolling?.['1y']));
      tr.appendChild(el('td', { class: 'num-flat' }, '基準線'));
      const bByY = new Map((item.calendar_returns || []).map((r) => [r.year, r]));
      for (const y of years) {
        const rec = bByY.get(y);
        tr.appendChild(fmtCell(rec ? rec.total_ret_pct : null));
      }
      tbody.appendChild(tr);
      continue;
    }

    rankNum += 1;
    const tr = document.createElement('tr');
    tr.appendChild(el('td', { class: 'rank-cell' }, String(rankNum)));
    tr.appendChild(el('td', {}, item.ticker));
    tr.appendChild(el('td', {}, item.name));
    tr.appendChild(el('td', { class: 'muted' }, item.category_label));
    const pxText = item.last_close != null ? Number(item.last_close).toFixed(2) : '—';
    tr.appendChild(el('td', {}, pxText));
    tr.appendChild(fmtCell(item.rolling?.ytd));
    tr.appendChild(fmtCell(item.rolling?.['1y']));
    const winText = item.comparable_years != null
      ? `${item.beat_wins ?? 0} / ${item.comparable_years}`
      : '—';
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
    ['前端資料發布界線', '僅發布本站計算之衍生累積指數（TRI／PRI）與最新單日官方收盤價（不提供歷史原始收盤價序列下載）'],
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

  const searchInput = document.getElementById('ticker-search');
  searchInput.addEventListener('input', renderSearchDropdown);
  searchInput.addEventListener('focus', renderSearchDropdown);
  document.addEventListener('click', (e) => {
    const wrap = searchInput.closest('.search-wrap');
    if (wrap && !wrap.contains(e.target)) {
      document.getElementById('search-dropdown').classList.add('hidden');
    }
  });

  document.getElementById('btn-toggle-drawer').addEventListener('click', () => {
    state.drawerOpen = !state.drawerOpen;
    renderCategoryDrawer();
  });

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

  document.getElementById('preset-select').addEventListener('change', (e) => {
    const idx = Number(e.target.value);
    const presets = (state.catalog && state.catalog.presets) || [];
    const p = presets[idx];
    e.target.value = '';
    if (!p) return;
    const validSet = new Set(state.catalog.items.map((i) => i.ticker));
    state.includeMarket = p.include_market !== false;
    state.selected = p.tickers.filter((t) => validSet.has(t)).slice(0, MAX_SERIES - (state.includeMarket ? 1 : 0));
    state.benchmark = state.includeMarket ? MARKET_TICKER : (state.selected[0] || '');
    state.focused.clear();
    state.allowAutoAlign = true;
    document.getElementById('include-market').checked = state.includeMarket;
    saveLocalPicks();
    renderPicker();
    updateChart();
  });

  document.getElementById('start-date').addEventListener('change', (e) => {
    state.startDate = e.target.value;
    state.allowAutoAlign = true;
    updateChart();
  });
  document.getElementById('end-date').addEventListener('change', (e) => {
    state.endDate = e.target.value;
    state.allowAutoAlign = true;
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
      state.allowAutoAlign = true;
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
      lateMode: state.lateMode,
      benchmark: state.benchmark,
      title: '',
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
  badge.textContent = `收盤基準：${state.manifest.data_date}（盤後）${state.manifest.source_mode === 'synthetic_demo' ? ' · 合成試跑' : ''}`;

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
