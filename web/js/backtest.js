/**
 * Pure frontend multi-ticker backtest engine (ES Module, zero DOM, zero raw prices).
 *
 * Uses the exact same pre-computed `tri[]` and `pri[]` derived indices as Return Trend
 * and ETF Calendar Returns (algorithm: `tri_ex_close_gross_v1`):
 * - Ex-date close dividend yield: y_t = (TRI_t / TRI_{t-1}) / (PRI_t / PRI_{t-1}) - 1
 * - Fixed monthly DCA dates: [5, 15, 25] (postponed to next valid trading day within 14 days)
 * - Strict ex-date eligibility: buys executed ON ex-date do NOT receive that day's dividend.
 * - Excludes non-tradable benchmark index (`is_market: true`).
 */

export const FIXED_DCA_DAYS = [5, 15, 25];

function diffDays(aIso, bIso) {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/**
 * Shortcut start date aligned to the 1st day of the month N years ago (matches v2.19.2).
 */
export function backtestRangeStart(endIso, preset) {
  const [y, m] = endIso.split('-').map(Number);
  const yearsMap = { '1y': 1, '3y': 3, '5y': 5 };
  const yrs = yearsMap[preset] || 3;
  return `${String(y - yrs).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

/**
 * Robust XIRR solver (ported from v2.27.1 core_engine.py):
 * - Merges same-day cash flows
 * - Requires >= 2 distinct dates and both negative & positive flows
 * - Multi-bracket grid scan + bisection + residual check + multi-root rejection
 * - Returns annualized decimal rate (e.g. 0.15 for 15%), or null when undefined/ambiguous.
 */
export function solveXirr(rawFlows) {
  if (!Array.isArray(rawFlows) || rawFlows.length < 2) return null;
  const byDate = new Map();
  for (const f of rawFlows) {
    if (!f || !f.dateIso || !Number.isFinite(f.amount)) continue;
    byDate.set(f.dateIso, (byDate.get(f.dateIso) || 0) + f.amount);
  }
  const merged = [...byDate.entries()]
    .filter(([, amt]) => Math.abs(amt) > 1e-9)
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (merged.length < 2) return null;
  const hasNeg = merged.some(([, a]) => a < 0);
  const hasPos = merged.some(([, a]) => a > 0);
  if (!hasNeg || !hasPos) return null;

  const baseDate = merged[0][0];
  const lastDate = merged[merged.length - 1][0];
  if (diffDays(baseDate, lastDate) <= 0) return null;

  const flows = merged.map(([d, a]) => ({
    amt: a,
    t: diffDays(baseDate, d) / 365.25,
  }));
  const scale = flows.reduce((acc, f) => acc + Math.abs(f.amt), 0);
  const tol = Math.max(1e-4, scale * 1e-6);

  const npv = (r) => {
    if (r <= -1) return Number.NaN;
    let sum = 0;
    for (const f of flows) {
      const denom = (1 + r) ** f.t;
      if (!Number.isFinite(denom) || denom === 0) return Number.NaN;
      sum += f.amt / denom;
    }
    return sum;
  };

  const grid = [
    -0.999, -0.95, -0.9, -0.8, -0.65, -0.5, -0.35, -0.2, -0.1,
    -0.05, 0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.5,
    4.0, 7.0, 12.0, 25.0, 60.0, 150.0,
  ];
  const roots = [];

  for (let i = 0; i < grid.length - 1; i += 1) {
    const a0 = grid[i];
    const b0 = grid[i + 1];
    const fa = npv(a0);
    const fb = npv(b0);
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) continue;

    if (Math.abs(fa) <= tol) {
      roots.push(a0);
      continue;
    }
    if ((fa > 0 && fb < 0) || (fa < 0 && fb > 0)) {
      let lo = a0;
      let hi = b0;
      let flo = fa;
      for (let iter = 0; iter < 100; iter += 1) {
        const mid = (lo + hi) / 2;
        const fmid = npv(mid);
        if (!Number.isFinite(fmid)) break;
        if (Math.abs(fmid) <= tol || (hi - lo) < 1e-10) {
          lo = mid;
          hi = mid;
          break;
        }
        if ((flo > 0 && fmid > 0) || (flo < 0 && fmid < 0)) {
          lo = mid;
          flo = fmid;
        } else {
          hi = mid;
        }
      }
      const cand = (lo + hi) / 2;
      const fc = npv(cand);
      if (Number.isFinite(fc) && Math.abs(fc) <= Math.max(1e-3, scale * 1e-4)) {
        if (!roots.some((r) => Math.abs(r - cand) < 1e-3)) {
          roots.push(cand);
        }
      }
    }
  }

  // Reject no root or ambiguous multiple roots
  if (roots.length !== 1) return null;
  const r = roots[0];
  if (r <= -0.998 || r >= 149.9) return null;
  return r;
}

/**
 * Simulate single ticker backtest strictly from derived `tri[]` and `pri[]`.
 */
export function simulateSingleTicker(
  raw,
  calendarDates,
  { startDate, endDate, strategy = 'dca', amount = 10000, drip = true },
) {
  if (!raw || raw.is_market) {
    return { error: '大盤指數不可直接買賣，不列入回測' };
  }
  const tri = raw.tri || [];
  const pri = raw.pri || [];
  const n = calendarDates.length;
  if (n < 2) return { error: '交易日曆不足' };

  const reqStartIdx = calendarDates.findIndex((d) => d >= startDate);
  let reqEndIdx = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (calendarDates[i] <= endDate) {
      reqEndIdx = i;
      break;
    }
  }
  if (reqStartIdx < 0 || reqEndIdx <= reqStartIdx) {
    return { error: '指定區間無有效交易日' };
  }

  // Find actual first and last valid trading indices for this ticker inside [reqStartIdx, reqEndIdx]
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = reqStartIdx; i <= reqEndIdx; i += 1) {
    if (tri[i] > 0 && pri[i] > 0) {
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx < 0 || lastIdx <= firstIdx) {
    return { error: `區間 ${startDate} ～ ${endDate} 尚無足夠行情` };
  }

  const hitBreak = (raw.breaks || []).find((b) => b.idx > firstIdx && b.idx <= lastIdx);
  if (hitBreak) {
    return { error: `區間內含資料斷點（${hitBreak.date}：${hitBreak.reason}）` };
  }

  const actualStart = calendarDates[firstIdx];
  const actualEnd = calendarDates[lastIdx];
  const isLateListed = diffDays(startDate, actualStart) > 14;
  const isShortEnd = diffDays(actualEnd, endDate) > 7;

  // Build buy schedule map: calendar index -> number of buys on that day
  const buyAt = new Map();
  const safeAmt = Math.max(100, Number(amount) || 10000);
  if (strategy === 'lump') {
    buyAt.set(firstIdx, 1);
  } else {
    const [sy, sm] = actualStart.split('-').map(Number);
    const [ey, em] = actualEnd.split('-').map(Number);
    let y = sy;
    let m = sm;
    while (y < ey || (y === ey && m <= em)) {
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (const dNum of FIXED_DCA_DAYS) {
        if (dNum > daysInMonth) continue;
        const schedIso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
        if (schedIso < actualStart || schedIso > actualEnd) continue;
        // Postpone to next valid trading day for this ticker within 14 calendar days
        let matchIdx = -1;
        for (let k = firstIdx; k <= lastIdx; k += 1) {
          if (calendarDates[k] < schedIso) continue;
          if (diffDays(schedIso, calendarDates[k]) > 14) break;
          if (tri[k] > 0 && pri[k] > 0) {
            matchIdx = k;
            break;
          }
        }
        if (matchIdx >= 0) {
          buyAt.set(matchIdx, (buyAt.get(matchIdx) || 0) + 1);
        }
      }
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }

  let units = 0;
  let cashPool = 0;
  let totalInvested = 0;
  let totalDividends = 0;
  let buyCount = 0;
  let divCount = 0;
  const yearlyDiv = {};
  const cashFlows = [];

  // Track underlying TRI max drawdown over [firstIdx, lastIdx]
  let peakTri = -Infinity;
  let maxDrawdownPct = 0;

  let prevValidIdx = -1;
  // Find immediately preceding valid index before firstIdx (if any) just in case firstIdx itself is an ex-date
  // (Remember: buys on ex-date are NOT eligible for that day's dividend; units === 0 before Step B handles this!)
  for (let i = firstIdx; i <= lastIdx; i += 1) {
    const tVal = tri[i];
    const pVal = pri[i];
    if (!(tVal > 0 && pVal > 0)) continue;

    if (tVal > peakTri) peakTri = tVal;
    if (peakTri > 0) {
      const dd = (tVal / peakTri - 1) * 100;
      if (dd < maxDrawdownPct) maxDrawdownPct = dd;
    }

    // Step A: Process ex-dividend BEFORE today's buy (strict buy_date < ex_date eligibility!)
    if (prevValidIdx >= 0 && units > 0) {
      const gTri = tVal / tri[prevValidIdx];
      const gPri = pVal / pri[prevValidIdx];
      const exYield = gTri / gPri - 1;
      if (exYield > 1e-5) {
        const divCash = units * pVal * exYield;
        totalDividends += divCash;
        divCount += 1;
        const yr = calendarDates[i].slice(0, 4);
        yearlyDiv[yr] = (yearlyDiv[yr] || 0) + divCash;
        if (drip) {
          units += divCash / pVal;
        } else {
          cashPool += divCash;
          cashFlows.push({ dateIso: calendarDates[i], amount: divCash });
        }
      }
    }

    // Step B: Execute scheduled buy(s) on day i
    const nBuys = buyAt.get(i) || 0;
    if (nBuys > 0) {
      const spent = safeAmt * nBuys;
      units += spent / pVal;
      totalInvested += spent;
      buyCount += nBuys;
      cashFlows.push({ dateIso: calendarDates[i], amount: -spent });
    }

    prevValidIdx = i;
  }

  if (buyCount === 0 || totalInvested <= 0) {
    return { error: '指定區間內無符合之扣款交易日' };
  }

  const marketValue = units * pri[lastIdx];
  const finalValue = marketValue + (drip ? 0 : cashPool);
  const totalProfit = finalValue - totalInvested;
  const priceProfit = totalProfit - totalDividends;
  const roiPct = (totalProfit / totalInvested) * 100;

  const daysHeld = Math.max(1, diffDays(actualStart, actualEnd));
  const yearsHeld = Number((daysHeld / 365.25).toFixed(2));

  let annualizedPct = null;
  let annualizedMethod = null;
  if (daysHeld < 365) {
    annualizedMethod = 'short';
  } else if (strategy === 'lump') {
    if (finalValue > 0) {
      annualizedPct = Number((((finalValue / totalInvested) ** (365.25 / daysHeld) - 1) * 100).toFixed(2));
      annualizedMethod = 'cagr';
    }
  } else {
    const termAmt = drip ? finalValue : marketValue;
    const xirrRaw = solveXirr([...cashFlows, { dateIso: actualEnd, amount: termAmt }]);
    if (xirrRaw !== null && Number.isFinite(xirrRaw)) {
      annualizedPct = Number((xirrRaw * 100).toFixed(2));
      annualizedMethod = 'xirr';
    }
  }

  const yearlyDivRounded = Object.fromEntries(
    Object.entries(yearlyDiv)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([yr, v]) => [yr, Math.round(v)]),
  );

  return {
    ticker: raw.ticker,
    name: raw.name,
    category: raw.category || '',
    actualStart,
    actualEnd,
    isLateListed,
    isShortEnd,
    buyCount,
    divCount,
    daysHeld,
    yearsHeld,
    invested: Math.round(totalInvested),
    marketValue: Math.round(marketValue),
    finalValue: Math.round(finalValue),
    dividendAmount: Math.round(totalDividends),
    totalProfit: Math.round(totalProfit),
    priceProfit: Math.round(priceProfit),
    roiPct: Number(roiPct.toFixed(2)),
    annualizedPct,
    annualizedMethod,
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    yearlyDiv: yearlyDivRounded,
  };
}

/**
 * Run multi-ticker backtest comparison and partition same-period vs late-listed tickers.
 */
export function computeBacktestComparison(
  seriesList,
  calendarDates,
  { startDate, endDate, strategy = 'dca', amount = 10000, drip = true },
) {
  const tradable = (seriesList || []).filter((s) => s && !s.is_market);
  const samePeriod = [];
  const differentPeriod = [];
  const failed = [];

  for (const raw of tradable) {
    const res = simulateSingleTicker(raw, calendarDates, { startDate, endDate, strategy, amount, drip });
    if (res.error) {
      failed.push({ ticker: raw.ticker, name: raw.name, reason: res.error });
    } else if (res.isLateListed || res.isShortEnd) {
      differentPeriod.push(res);
    } else {
      samePeriod.push(res);
    }
  }

  samePeriod.sort((a, b) => b.roiPct - a.roiPct);
  differentPeriod.sort((a, b) => b.roiPct - a.roiPct);

  const commonEarliestDate = differentPeriod.length > 0
    ? differentPeriod.map((r) => r.actualStart).sort().pop()
    : null;

  return {
    samePeriod,
    differentPeriod,
    failed,
    commonEarliestDate,
    strategy,
    amount: Math.max(100, Number(amount) || 10000),
    drip: Boolean(drip),
    startDate,
    endDate,
  };
}
