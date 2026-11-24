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
