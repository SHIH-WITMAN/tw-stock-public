/**
 * Pure frontend model for derived-index comparison (ES Module).
 * Computes sub-period returns strictly by division: R(s, t) = TRI(t) / TRI(s) - 1.
 */
export const MAX_SERIES = 9;
export const MARKET_TICKER = 'TAIEX';
export const MAX_CONSECUTIVE_HALT_DAYS = 20;
export const MAX_MISSING_RATIO = 0.10;
export const TICKER_RE = /^[A-Z0-9]{4,10}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const PALETTES = {
  light: {
    benchmark: '#334155',
    colors: ['#dc2626', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c'],
  },
  dark: {
    benchmark: '#fbbf24',
    colors: ['#38bdf8', '#34d399', '#fb7185', '#a78bfa', '#fb923c', '#2dd4bf', '#f472b6', '#a3e635', '#60a5fa'],
  },
};

export function assignColors(seriesList, benchmarkTicker, theme = 'light') {
  const pal = PALETTES[theme === 'dark' ? 'dark' : 'light'];
  const map = {};
  let idx = 0;
  for (const s of seriesList) {
    if (benchmarkTicker && s.ticker === benchmarkTicker) {
      map[s.ticker] = pal.benchmark;
    } else {
      map[s.ticker] = pal.colors[idx % pal.colors.length];
      idx += 1;
    }
  }
  return map;
}

export function rangeStartDate(endIso, preset) {
  const [y, m, d] = endIso.split('-').map(Number);
  if (preset === 'ytd') {
    return `${y - 1}-12-31`;
  }
  const monthsMap = { '1m': 1, '3m': 3, '6m': 6, '1y': 12, '3y': 36, '5y': 60 };
  const months = monthsMap[preset] || 12;
  const totalMonths = y * 12 + (m - 1) - months;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  const maxDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, maxDay);
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

function diffDays(aIso, bIso) {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function maxNullStreak(arr) {
  let best = 0;
  let cur = 0;
  for (const v of arr) {
    if (v === null || v === undefined) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/**
 * Align selected series onto the official exchange calendar and compute 0%-normalized curves.
 */
export function computeTrendComparison(
  seriesList,
  calendarDates,
  { startDate, endDate, mode = 'total_return', lateMode = 'strict', allowAutoAlign = true },
) {
  const emptyResult = {
    dates: [],
    series: [],
    excluded: [],
    actualStart: null,
    actualEnd: null,
    haltNote: null,
    startHaltNote: null,
    endAlignNote: null,
    autoAligned: null,
    lateEntryTickers: [],
    commonEarliestDate: null,
  };
  if (!Array.isArray(calendarDates) || calendarDates.length < 2) {
    return emptyResult;
  }
  // Find base trading day <= startDate (within 14 calendar days)
  let startIdx = -1;
  for (let i = calendarDates.length - 1; i >= 0; i -= 1) {
    if (calendarDates[i] <= startDate) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0 || diffDays(calendarDates[startIdx], startDate) > 14) {
    startIdx = calendarDates.findIndex((d) => d >= startDate);
  }
  let endIdx = -1;
  for (let i = calendarDates.length - 1; i >= 0; i -= 1) {
    if (calendarDates[i] <= endDate) {
      endIdx = i;
      break;
    }
  }
  if (startIdx < 0 || endIdx <= startIdx) {
    return emptyResult;
  }

  const field = mode === 'price_only' ? 'pri' : 'tri';

  // Common end-date resilience: if any selected series is missing the exact endIdx
  // (e.g. halted or lagging by <= 7 calendar days), align all series to their common end date.
  const requestedEndIso = calendarDates[endIdx];
  let effectiveEndIdx = endIdx;
  const candidateEnds = [];
  for (const raw of seriesList) {
    const arr = raw[field] || [];
    const ev = arr[endIdx];
    if (ev !== null && ev !== undefined && ev > 0) continue;
    let lastValid = -1;
    for (let k = endIdx - 1; k > startIdx; k -= 1) {
      if (diffDays(calendarDates[k], requestedEndIso) > 7) break;
      if (arr[k] !== null && arr[k] !== undefined && arr[k] > 0) {
        lastValid = k;
        break;
      }
    }
    if (lastValid > startIdx) {
      candidateEnds.push(lastValid);
    }
  }
  let endAlignNote = null;
  if (candidateEnds.length > 0) {
    const minEnd = Math.min(...candidateEnds);
    if (minEnd > startIdx && minEnd < effectiveEndIdx) {
      effectiveEndIdx = minEnd;
      endAlignNote = `部分標的於 ${requestedEndIso} 暫無收盤或停牌，已統一對齊至共同收盤日 ${calendarDates[effectiveEndIdx]}。`;
    }
  }

  const dates = calendarDates.slice(startIdx, effectiveEndIdx + 1);
  const totalDays = dates.length;
  const included = [];
  const excluded = [];
  const haltedSummary = [];
  const startHaltNotes = [];
  const lateEntryTickers = [];

  for (const raw of seriesList) {
    const arr = raw[field] || [];
    const name = raw.is_market ? (mode === 'price_only' ? (raw.price_name || '加權股價指數') : raw.name) : raw.name;
    let baseVal = arr[startIdx];
    let baseIdx = startIdx;
    let startCarriedFrom = null;
    const endVal = arr[effectiveEndIdx];

    // Q1: Distinguish mid-history short halt on startDate (<= 14 calendar days) vs truly late-listed.
    if (baseVal === null || baseVal === undefined || baseVal <= 0) {
      for (let k = startIdx - 1; k >= 0; k -= 1) {
        if (diffDays(calendarDates[k], calendarDates[startIdx]) > 14) break;
        if (arr[k] !== null && arr[k] !== undefined && arr[k] > 0) {
          baseVal = arr[k];
          baseIdx = k;
          startCarriedFrom = calendarDates[k];
          break;
        }
      }
    }

    // Truly late-listed (no quote on or within 14 calendar days before startDate)
    if (baseVal === null || baseVal === undefined || baseVal <= 0) {
      let earliestIdx = -1;
      for (let i = startIdx + 1; i < effectiveEndIdx; i += 1) {
        if (arr[i] !== null && arr[i] !== undefined && arr[i] > 0) {
          earliestIdx = i;
          break;
        }
      }

      if (lateMode === 'late_entry' && earliestIdx >= 0 && effectiveEndIdx - earliestIdx >= 1) {
        if (endVal === null || endVal === undefined || endVal <= 0) {
          excluded.push({
            ticker: raw.ticker,
            name,
            is_market: Boolean(raw.is_market),
            reason: `結束日 ${calendarDates[effectiveEndIdx]} 缺少收盤資料`,
          });
          continue;
        }
        const hitBreakLate = (raw.breaks || []).find((b) => b.idx > earliestIdx && b.idx <= effectiveEndIdx);
        if (hitBreakLate) {
          excluded.push({
            ticker: raw.ticker,
            name,
            is_market: Boolean(raw.is_market),
            reason: `區間內含資料斷點（${hitBreakLate.date}：${hitBreakLate.reason}），暫不混入比較`,
          });
          continue;
        }
        const lateBase = arr[earliestIdx];
        const values = [];
        const activeValues = [];
        let haltedDays = 0;
        for (let i = startIdx; i <= effectiveEndIdx; i += 1) {
          if (i < earliestIdx) {
            values.push(null);
            continue;
          }
          const v = arr[i];
          if (v === null || v === undefined || v <= 0) {
            values.push(null);
            activeValues.push(null);
            haltedDays += 1;
          } else {
            const pct = Number(((v / lateBase - 1) * 100).toFixed(2));
            values.push(pct);
            activeValues.push(pct);
          }
        }
        const streak = maxNullStreak(activeValues);
        if (streak > MAX_CONSECUTIVE_HALT_DAYS || (haltedDays > 10 && haltedDays / activeValues.length > MAX_MISSING_RATIO)) {
          excluded.push({
            ticker: raw.ticker,
            name,
            is_market: Boolean(raw.is_market),
            reason: `上市後缺少 ${haltedDays} 個交易日（最長連續 ${streak} 日），可能長期停牌，未混入比較`,
          });
          continue;
        }
        if (haltedDays > 0) {
          haltedSummary.push(`${raw.ticker}（${haltedDays} 日）`);
        }
        lateEntryTickers.push(`${raw.ticker}（${calendarDates[earliestIdx]} 起）`);
        included.push({
          ticker: raw.ticker,
          name,
          is_market: Boolean(raw.is_market),
          total_return_pct: values[values.length - 1],
          values,
          halted_days: haltedDays,
          div_count: raw.div_count || 0,
          late_start_date: calendarDates[earliestIdx],
          late_start_idx: earliestIdx - startIdx,
        });
        continue;
      }

      const entry = {
        ticker: raw.ticker,
        name,
        is_market: Boolean(raw.is_market),
        reason: earliestIdx >= 0
          ? `起算日 ${calendarDates[startIdx]} 尚無行情（最早可用為 ${calendarDates[earliestIdx]}，較晚掛牌）`
          : `起算日 ${calendarDates[startIdx]} 尚無可用行情`,
      };
      if (earliestIdx >= 0 && effectiveEndIdx - earliestIdx >= 1) {
        entry.earliest_date = calendarDates[earliestIdx];
      }
      excluded.push(entry);
      continue;
    }

    if (endVal === null || endVal === undefined || endVal <= 0) {
      excluded.push({
        ticker: raw.ticker,
        name,
        is_market: Boolean(raw.is_market),
        reason: `結束日 ${calendarDates[effectiveEndIdx]} 缺少收盤資料`,
      });
      continue;
    }

    const hitBreak = (raw.breaks || []).find((b) => b.idx > baseIdx && b.idx <= effectiveEndIdx);
    if (hitBreak) {
      excluded.push({
        ticker: raw.ticker,
        name,
        is_market: Boolean(raw.is_market),
        reason: `區間內含資料斷點（${hitBreak.date}：${hitBreak.reason}），暫不混入比較`,
      });
      continue;
    }

    const values = [];
    let haltedDays = 0;
    for (let i = startIdx; i <= effectiveEndIdx; i += 1) {
      const v = arr[i];
      if (v === null || v === undefined || v <= 0) {
        // On startIdx itself when carrying pre-halt close, anchor the curve cleanly at 0%.
        values.push(i === startIdx && startCarriedFrom ? 0 : null);
        haltedDays += 1;
      } else {
        values.push(Number(((v / baseVal - 1) * 100).toFixed(2)));
      }
    }
    const streak = maxNullStreak(values);
    if (streak > MAX_CONSECUTIVE_HALT_DAYS || (haltedDays > 10 && haltedDays / totalDays > MAX_MISSING_RATIO)) {
      excluded.push({
        ticker: raw.ticker,
        name,
        is_market: Boolean(raw.is_market),
        reason: `區間內缺少 ${haltedDays} 個交易日（最長連續 ${streak} 日），可能長期停牌，未混入比較`,
      });
      continue;
    }
    if (startCarriedFrom) {
      startHaltNotes.push(`${raw.ticker}（起算日逢停牌，沿用 ${startCarriedFrom} 基準）`);
    } else if (haltedDays > 0) {
      haltedSummary.push(`${raw.ticker}（${haltedDays} 日）`);
    }

    included.push({
      ticker: raw.ticker,
      name,
      is_market: Boolean(raw.is_market),
      total_return_pct: values[values.length - 1],
      values,
      halted_days: haltedDays,
      div_count: raw.div_count || 0,
      start_carried_from: startCarriedFrom,
    });
  }

  // Q3 follow-up: If ALL selected non-market stocks were excluded only because they listed after startDate
  // (leaving only TAIEX alone on the chart), auto-align to their common listing date!
  const nonMarketIncluded = included.filter((s) => !s.is_market);
  const lateNonMarketExcluded = excluded.filter((e) => !e.is_market && e.earliest_date);
  if (
    allowAutoAlign
    && lateMode === 'strict'
    && nonMarketIncluded.length === 0
    && lateNonMarketExcluded.length > 0
  ) {
    const alignedStart = lateNonMarketExcluded
      .map((e) => e.earliest_date)
      .sort()
      .pop();
    if (alignedStart && alignedStart > calendarDates[startIdx] && alignedStart < calendarDates[effectiveEndIdx]) {
      const rerun = computeTrendComparison(seriesList, calendarDates, {
        startDate: alignedStart,
        endDate: calendarDates[effectiveEndIdx],
        mode,
        lateMode,
        allowAutoAlign: false,
      });
      if (rerun.series.some((s) => !s.is_market)) {
        return {
          ...rerun,
          autoAligned: {
            originalStart: calendarDates[startIdx],
            alignedStart: rerun.actualStart,
            tickers: lateNonMarketExcluded.map((e) => `${e.ticker} ${e.name}`),
          },
        };
      }
    }
  }

  const haltNote = haltedSummary.length > 0
    ? `區間內含暫停交易日（如分割換股／減資／重訊停牌）：${haltedSummary.join('、')}；停牌日不填補假價格並自動銜接復牌日。`
    : null;
  const startHaltNote = startHaltNotes.length > 0
    ? `起算日停牌基準補正：${startHaltNotes.join('、')}。`
    : null;
  const commonEarliestDate = lateNonMarketExcluded.length > 0
    ? lateNonMarketExcluded.map((e) => e.earliest_date).sort().pop()
    : null;

  return {
    dates,
    series: included,
    excluded,
    actualStart: dates[0],
    actualEnd: dates[dates.length - 1],
    haltNote,
    startHaltNote,
    endAlignNote,
    autoAligned: null,
    lateEntryTickers,
    commonEarliestDate,
  };
}

export function orderCards(seriesList, benchmarkTicker) {
  const list = [...seriesList];
  if (!benchmarkTicker) {
    return list.sort((a, b) => (b.total_return_pct ?? -Infinity) - (a.total_return_pct ?? -Infinity));
  }
  const bench = list.find((s) => s.ticker === benchmarkTicker);
  const rest = list
    .filter((s) => s.ticker !== benchmarkTicker)
    .sort((a, b) => (b.total_return_pct ?? -Infinity) - (a.total_return_pct ?? -Infinity));
  return bench ? [bench, ...rest] : rest;
}

export function diffSummary(valuePct, benchPct) {
  if (valuePct === null || valuePct === undefined || benchPct === null || benchPct === undefined) {
    return { text: '—', direction: 'flat' };
  }
  const diff = Number((valuePct - benchPct).toFixed(2));
  if (Math.abs(diff) < 0.005) return { text: '與基準持平', direction: 'flat' };
  const absStr = Math.abs(diff).toFixed(2);
  if (diff > 0) {
    const label = valuePct < 0 && benchPct < 0 ? '少跌' : '領先';
    return { text: `${label} +${absStr} 個百分點`, direction: 'up' };
  }
  const label = valuePct < 0 && benchPct < 0 ? '多跌' : '落後';
  return { text: `${label} -${absStr} 個百分點`, direction: 'down' };
}

export function toggleFocus(focusedSet, clickedTicker, benchmarkTicker, allTickers) {
  const next = new Set(focusedSet);
  if (next.size === 0) {
    next.add(clickedTicker);
    if (benchmarkTicker && benchmarkTicker !== clickedTicker && allTickers.includes(benchmarkTicker)) {
      next.add(benchmarkTicker);
    }
  } else if (next.has(clickedTicker)) {
    next.delete(clickedTicker);
  } else {
    next.add(clickedTicker);
  }
  if (next.size >= allTickers.length) {
    next.clear();
  }
  return next;
}

export function resolveLabelPositions(items, minY, maxY, minGap) {
  const sorted = [...items].sort((a, b) => a.y - b.y).map((it) => ({ ...it, labelY: Math.max(minY, Math.min(maxY, it.y)) }));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].labelY - sorted[i - 1].labelY < minGap) {
      sorted[i].labelY = sorted[i - 1].labelY + minGap;
    }
  }
  if (sorted.length > 0 && sorted[sorted.length - 1].labelY > maxY) {
    sorted[sorted.length - 1].labelY = maxY;
    for (let i = sorted.length - 2; i >= 0; i -= 1) {
      if (sorted[i + 1].labelY - sorted[i].labelY < minGap) {
        sorted[i].labelY = sorted[i + 1].labelY - minGap;
      }
    }
  }
  return sorted;
}

export function encodeShareParams({ tickers, includeMarket, startDate, endDate, mode, lateMode, benchmark, title, snapshotVersion }) {
  const params = new URLSearchParams();
  const clean = tickers.filter((t) => TICKER_RE.test(t)).slice(0, MAX_SERIES);
  if (clean.length) params.set('t', clean.join(','));
  params.set('m', includeMarket ? '1' : '0');
  if (DATE_RE.test(startDate || '')) params.set('s', startDate);
  if (DATE_RE.test(endDate || '')) params.set('e', endDate);
  params.set('mode', mode === 'price_only' ? 'price_only' : 'total_return');
  if (lateMode === 'late_entry') params.set('lm', 'late');
  if (benchmark && (benchmark === MARKET_TICKER || TICKER_RE.test(benchmark))) {
    params.set('b', benchmark);
  } else {
    params.set('b', '');
  }
  if (title) params.set('title', String(title).trim().slice(0, 40));
  if (snapshotVersion && /^[0-9]{8}-[0-9]{6}$/.test(snapshotVersion)) {
    params.set('ver', snapshotVersion);
  }
  return params.toString();
}

export function decodeShareParams(searchStr, validTickersSet) {
  const params = new URLSearchParams(searchStr || '');
  if (!params.has('t') && !params.has('m')) return null;
  const rawTickers = (params.get('t') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const includeMarket = params.get('m') !== '0';
  const maxT = MAX_SERIES - (includeMarket ? 1 : 0);
  const tickers = [];
  for (const t of rawTickers) {
    if (TICKER_RE.test(t) && (!validTickersSet || validTickersSet.has(t)) && !tickers.includes(t)) {
      tickers.push(t);
      if (tickers.length >= maxT) break;
    }
  }
  const s = params.get('s') || '';
  const e = params.get('e') || '';
  const ver = params.get('ver') || '';
  return {
    tickers,
    includeMarket,
    startDate: DATE_RE.test(s) ? s : null,
    endDate: DATE_RE.test(e) ? e : null,
    mode: params.get('mode') === 'price_only' ? 'price_only' : 'total_return',
    lateMode: params.get('lm') === 'late' ? 'late_entry' : 'strict',
    benchmark: params.has('b') ? params.get('b') : MARKET_TICKER,
    title: (params.get('title') || '').trim().slice(0, 40),
    snapshotVersion: /^[0-9]{8}-[0-9]{6}$/.test(ver) ? ver : null,
  };
}
