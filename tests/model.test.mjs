import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTrendComparison, orderCards, diffSummary, toggleFocus,
  encodeShareParams, decodeShareParams, rangeStartDate,
} from '../web/js/model.js';

test('computeTrendComparison divides TRI accurately and handles short halts vs late listing', () => {
  const cal = ['2025-06-10', '2025-06-11', '2025-06-12', '2025-06-18', '2025-06-19'];
  const s0050 = { ticker: '0050', name: '元大台灣50', tri: [100, null, null, 110, 121], pri: [100, null, null, 110, 121], breaks: [] };
  const sLate = { ticker: '009816', name: '新上市', tri: [null, null, 50, 55, 60], pri: [null, null, 50, 55, 60], breaks: [] };
  const sBreak = { ticker: '9999', name: '未明減資', tri: [100, 101, 102, 103, 104], pri: [100, 101, 102, 103, 104], breaks: [{ idx: 3, date: '2025-06-18', reason: '未明減資' }] };

  const res = computeTrendComparison([s0050, sLate, sBreak], cal, {
    startDate: '2025-06-10', endDate: '2025-06-19', mode: 'total_return',
  });
  assert.equal(res.series.length, 1);
  assert.deepEqual(res.series[0].values, [0, null, null, 10, 21]);
  assert.equal(res.series[0].halted_days, 2);
  assert.match(res.haltNote, /0050（2 日）/);

  const exMap = Object.fromEntries(res.excluded.map((e) => [e.ticker, e]));
  assert.equal(exMap['009816'].earliest_date, '2025-06-12');
  assert.match(exMap['9999'].reason, /資料斷點/);
});

test('orderCards puts benchmark leftmost and sorts rest descending', () => {
  const list = [
    { ticker: '0056', total_return_pct: 5 },
    { ticker: 'TAIEX', total_return_pct: 10 },
    { ticker: '2330', total_return_pct: 25 },
  ];
  assert.deepEqual(orderCards(list, 'TAIEX').map((s) => s.ticker), ['TAIEX', '2330', '0056']);
});

test('diffSummary distinguishes both-negative drawdown vs mixed', () => {
  assert.deepEqual(diffSummary(-5, -10), { text: '少跌 +5.00 個百分點', direction: 'up' });
  assert.deepEqual(diffSummary(-15, -10), { text: '多跌 -5.00 個百分點', direction: 'down' });
  assert.deepEqual(diffSummary(12, 10), { text: '領先 +2.00 個百分點', direction: 'up' });
});

test('toggleFocus auto-includes benchmark on first click and clears when all selected', () => {
  const all = ['TAIEX', '0050', '0056'];
  let f = toggleFocus(new Set(), '0050', 'TAIEX', all);
  assert.deepEqual([...f].sort(), ['0050', 'TAIEX']);
  f = toggleFocus(f, '0056', 'TAIEX', all);
  assert.equal(f.size, 0);
});

test('share URL params enforce ticker whitelist, cap, title length, and snapshot version', () => {
  const valid = new Set(['0050', '0056', '2330']);
  const qs = encodeShareParams({
    tickers: ['0050', 'BAD<script>', '0056'],
    includeMarket: true,
    startDate: '2025-01-02',
    endDate: '2026-11-20',
    mode: 'total_return',
    benchmark: 'TAIEX',
    title: 'A'.repeat(60),
    snapshotVersion: '20261120-233520',
  });
  const dec = decodeShareParams(`?${qs}`, valid);
  assert.deepEqual(dec.tickers, ['0050', '0056']);
  assert.equal(dec.title.length, 40);
  assert.equal(dec.snapshotVersion, '20261120-233520');
  assert.equal(rangeStartDate('2026-03-31', '1m'), '2026-02-28');
  assert.equal(rangeStartDate('2026-11-20', 'ytd'), '2025-12-31');
});

test('mid-history halt on startDate carries pre-halt base instead of excluding', () => {
  const cal = ['2025-11-18', '2025-11-24', '2025-11-25', '2025-11-26', '2025-11-27'];
  const s0052 = { ticker: '0052', name: '富邦科技', tri: [200, null, null, 210, 220], pri: [200, null, null, 210, 220], breaks: [] };
  const taiex = { ticker: 'TAIEX', name: '加權報酬指數', is_market: true, tri: [100, 102, 103, 105, 106], pri: [100, 102, 103, 105, 106], breaks: [] };

  const res = computeTrendComparison([taiex, s0052], cal, {
    startDate: '2025-11-24', endDate: '2025-11-27', mode: 'total_return',
  });
  assert.equal(res.excluded.length, 0);
  const p = res.series.find((s) => s.ticker === '0052');
  assert.ok(p);
  assert.equal(p.start_carried_from, '2025-11-18');
  assert.deepEqual(p.values, [0, null, 5, 10]);
  assert.match(res.startHaltNote, /0052/);
});

test('common end-date alignment handles 1-day lagging ticker within 7 days', () => {
  const cal = ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25'];
  const taiex = { ticker: 'TAIEX', name: '加權報酬指數', is_market: true, tri: [100, 102, 104, 105], pri: [100, 102, 104, 105], breaks: [] };
  const s0050 = { ticker: '0050', name: '元大台灣50', tri: [100, 103, 106, null], pri: [100, 103, 106, null], breaks: [] };

  const res = computeTrendComparison([taiex, s0050], cal, {
    startDate: '2026-11-20', endDate: '2026-11-25', mode: 'total_return',
  });
  assert.equal(res.excluded.length, 0);
  assert.equal(res.actualEnd, '2026-11-24');
  assert.match(res.endAlignNote, /2026-11-24/);
  assert.equal(res.series.find((s) => s.ticker === '0050').total_return_pct, 6);
});

test('auto-aligns when only late-listed stock + market are selected, and supports Mode B late_entry', () => {
  const cal = ['2023-01-03', '2023-06-01', '2024-04-01', '2024-06-03', '2024-12-31'];
  const taiex = { ticker: 'TAIEX', name: '加權報酬指數', is_market: true, tri: [100, 110, 120, 126, 132], pri: [100, 110, 120, 126, 132], breaks: [] };
  const s0050 = { ticker: '0050', name: '元大台灣50', tri: [100, 112, 125, 130, 140], pri: [100, 112, 125, 130, 140], breaks: [] };
  const s00940 = { ticker: '00940', name: '元大台灣價值高息', tri: [null, null, 100, 105, 110], pri: [null, null, 100, 105, 110], breaks: [] };

  // Case 1: Only 00940 + TAIEX -> auto-aligns to 2024-04-01
  const resAuto = computeTrendComparison([taiex, s00940], cal, {
    startDate: '2023-01-03', endDate: '2024-12-31', mode: 'total_return', lateMode: 'strict',
  });
  assert.equal(resAuto.actualStart, '2024-04-01');
  assert.ok(resAuto.autoAligned);
  assert.equal(resAuto.series.length, 2);
  assert.equal(resAuto.series.find((s) => s.ticker === '00940').total_return_pct, 10);

  // Case 2: Mixed 0050 + 00940 + TAIEX in Mode A -> keeps 0050 full range, excludes 00940 with commonEarliestDate
  const resModeA = computeTrendComparison([taiex, s0050, s00940], cal, {
    startDate: '2023-01-03', endDate: '2024-12-31', mode: 'total_return', lateMode: 'strict',
  });
  assert.equal(resModeA.actualStart, '2023-01-03');
  assert.equal(resModeA.commonEarliestDate, '2024-04-01');
  assert.equal(resModeA.series.length, 2);

  // Case 3: Mixed 0050 + 00940 + TAIEX in Mode B -> includes 00940 starting at 0% on 2024-04-01
  const resModeB = computeTrendComparison([taiex, s0050, s00940], cal, {
    startDate: '2023-01-03', endDate: '2024-12-31', mode: 'total_return', lateMode: 'late_entry',
  });
  assert.equal(resModeB.series.length, 3);
  const sLate = resModeB.series.find((s) => s.ticker === '00940');
  assert.equal(sLate.late_start_date, '2024-04-01');
  assert.deepEqual(sLate.values, [null, null, 0, 5, 10]);
});
