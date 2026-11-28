import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveXirr, backtestRangeStart, simulateSingleTicker, computeBacktestComparison,
} from '../web/js/backtest.js';

test('solveXirr computes accurate annualized return and rejects degenerate/ambiguous flows', () => {
  // Exact 10% over 1 year (365.25d ~ 365d)
  const r = solveXirr([
    { dateIso: '2024-01-01', amount: -10000 },
    { dateIso: '2025-01-01', amount: 11000 },
  ]);
  assert.ok(r !== null && Math.abs(r - 0.10) < 0.001);

  // Same-day cancelling flows -> null (no unique solution)
  assert.equal(solveXirr([
    { dateIso: '2024-06-01', amount: -100 },
    { dateIso: '2024-06-01', amount: 100 },
  ]), null);

  // All negative flows -> null
  assert.equal(solveXirr([
    { dateIso: '2024-01-01', amount: -100 },
    { dateIso: '2025-01-01', amount: -100 },
  ]), null);

  // Multiple sign flips with 2 distinct roots (-100, +230, -132 => roots 0.1 and 0.2) -> null
  assert.equal(solveXirr([
    { dateIso: '2023-01-01', amount: -100 },
    { dateIso: '2024-01-01', amount: 230 },
    { dateIso: '2025-01-01', amount: -132 },
  ]), null);
});

test('lump-sum DRIP matches TRI(T)/TRI(s) - 1 exactly and respects ex-date eligibility', () => {
  // Day 0: close 50, tri=100, pri=100
  // Day 1 (ex-div 2.0 on close 50): pri stays 100, tri = 100 * (1 + 2/50) = 104
  // Day 2: close 55 (+10%): pri=110, tri=114.4
  const cal = ['2024-01-02', '2024-06-03', '2025-01-03'];
  const s = { ticker: '0050', name: '元大台灣50', tri: [100, 104, 114.4], pri: [100, 100, 110], breaks: [] };

  // Bought on Day 0 (before ex-date): receives 4% dividend ($4,000 on $100,000) and reinvests!
  const resDrip = simulateSingleTicker(s, cal, {
    startDate: '2024-01-02', endDate: '2025-01-03', strategy: 'lump', amount: 100000, drip: true,
  });
  assert.equal(resDrip.invested, 100000);
  assert.equal(resDrip.dividendAmount, 4000);
  assert.equal(resDrip.finalValue, 114400);
  assert.equal(resDrip.roiPct, 14.4);
  assert.equal(resDrip.annualizedMethod, 'cagr');
  assert.ok(resDrip.annualizedPct > 14.0 && resDrip.annualizedPct < 14.8);

  // Cash dividend mode: receives $4,000 cash + stock grows to $110,000 = $114,000
  const resCash = simulateSingleTicker(s, cal, {
    startDate: '2024-01-02', endDate: '2025-01-03', strategy: 'lump', amount: 100000, drip: false,
  });
  assert.equal(resCash.dividendAmount, 4000);
  assert.equal(resCash.marketValue, 110000);
  assert.equal(resCash.finalValue, 114000);
  assert.equal(resCash.roiPct, 14.0);

  // Buying ON ex-date (2024-06-03): must NOT receive that day's dividend!
  const resOnEx = simulateSingleTicker(s, cal, {
    startDate: '2024-06-03', endDate: '2025-01-03', strategy: 'lump', amount: 100000, drip: true,
  });
  assert.equal(resOnEx.divCount, 0);
  assert.equal(resOnEx.dividendAmount, 0);
  assert.equal(resOnEx.finalValue, 110000);
  assert.equal(resOnEx.annualizedPct, null); // < 365 days -> null
  assert.equal(resOnEx.annualizedMethod, 'short');
});

test('fixed monthly [5, 15, 25] DCA postpones weekends, excludes TAIEX, and partitions late-listed tickers', () => {
  // Sparse trading calendar: Jan, Jun, Jan, Feb (note: 5/25 & 12/25 are within 14d of 6/5 & 1/6, so use exact 2024-01..2025-02 monthly dates)
  const cal = [
    '2024-01-05', '2024-01-15', '2024-01-25',
    '2024-07-05', '2024-07-15', '2024-07-25',
    '2025-01-06', '2025-01-15', '2025-01-27',
    '2025-02-05',
  ];
  // 2024-06-25 -> 2024-07-05 (10d) and 2024-12-25 -> 2025-01-06 (12d) also postpone within 14d -> 12 total buys!
  const taiex = { ticker: 'TAIEX', name: '加權報酬指數', is_market: true, tri: cal.map((_, i) => 100 + i * 2), pri: cal.map((_, i) => 100 + i * 2), breaks: [] };
  const s0050 = { ticker: '0050', name: '元大台灣50', tri: [100, 102, 104, 110, 112, 114, 120, 122, 124, 126], pri: [100, 102, 104, 110, 112, 114, 120, 122, 124, 126], breaks: [] };
  const s00940 = { ticker: '00940', name: '元大台灣價值高息', tri: [null, null, null, 100, 101, 102, 105, 106, 107, 108], pri: [null, null, null, 100, 101, 102, 105, 106, 107, 108], breaks: [] };

  const cmp = computeBacktestComparison([taiex, s0050, s00940], cal, {
    startDate: '2024-01-01', endDate: '2025-02-05', strategy: 'dca', amount: 10000, drip: true,
  });

  // TAIEX excluded; 0050 in samePeriod; 00940 in differentPeriod
  assert.equal(cmp.samePeriod.length, 1);
  assert.equal(cmp.samePeriod[0].ticker, '0050');
  assert.equal(cmp.samePeriod[0].buyCount, 12);
  assert.equal(cmp.samePeriod[0].invested, 120000);
  assert.equal(cmp.samePeriod[0].annualizedMethod, 'xirr');
  assert.ok(cmp.samePeriod[0].annualizedPct > 0);

  assert.equal(cmp.differentPeriod.length, 1);
  assert.equal(cmp.differentPeriod[0].ticker, '00940');
  assert.equal(cmp.commonEarliestDate, '2024-07-05');
  assert.equal(backtestRangeStart('2026-11-27', '3y'), '2023-11-01');
});
