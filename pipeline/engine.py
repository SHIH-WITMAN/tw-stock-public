"""Pure derived-index calculation engine for Taiwan public stock/ETF trends.

Single source of truth:
- Pre-computes calendar-aligned cumulative TRI (total return index, ex-date-close
  gross reinvestment) and PRI (price index adjusted for splits, stock dividends,
  and capital reductions) in Python.
- Never outputs raw closing prices to public artifacts; frontend computes any
  sub-period return via R(s, t) = TRI(t) / TRI(s) - 1.
- Enforces official reference-price event gate and fail-closed discontinuity breaks.
"""
from datetime import date, timedelta
import math
import re

ALGORITHM_VERSION = 'tri_ex_close_gross_v1'
MAX_CONSECUTIVE_HALT_DAYS = 20
MAX_MISSING_RATIO = 0.10


def parse_date(value):
    """Parse ISO ('2025-06-18') or ROC ('114/06/18', '114年06月18日', '1140618') date."""
    if isinstance(value, date):
        return value
    s = str(value or '').strip()
    m = re.match(r'^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$', s)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.match(r'^(\d{2,3})[/年\-](\d{1,2})[/月\-](\d{1,2})日?$', s)
    if m:
        return date(int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3)))
    m = re.match(r'^(\d{3})(\d{2})(\d{2})$', s)
    if m:
        return date(int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3)))
    return None


def safe_float(value):
    if value is None:
        return None
    s = str(value).replace(',', '').replace('元／股', '').replace('股', '').strip()
    if not s or s in ('--', 'NA', 'N/A', '-'):
        return None
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except ValueError:
        return None


def normalize_split_ratio(before, after):
    if not before or not after or before <= 0 or after <= 0:
        return None
    ratio = before / after
    if abs(ratio - round(ratio)) < 0.005 and round(ratio) > 0:
        return float(round(ratio))
    if ratio < 1.0 and abs(1.0 / ratio - round(1.0 / ratio)) < 0.02 and round(1.0 / ratio) > 0:
        return 1.0 / float(round(1.0 / ratio))
    return ratio


def parse_capital_reduction(when, before, after, reason, *, exright=None, explicit_ratio=None, explicit_cash=None):
    """Parse a capital reduction record into a verified event or fail-closed unsupported marker."""
    raw_reason = str(reason or '').strip()
    reason_low = raw_reason.lower()

    if explicit_ratio is not None and explicit_cash is not None:
        if 0.0 < explicit_ratio < 1.0 and explicit_cash >= 0.0:
            label = '現金減資' if explicit_cash > 0 else '彌補虧損減資'
            return {
                'kind': 'capital_reduction', 'date': when, 'ratio': float(explicit_ratio),
                'cash': float(explicit_cash), 'reason': label, 'raw_reason': raw_reason,
            }
        return {
            'kind': 'capital_reduction_unsupported', 'date': when,
            'reason': '減資換股比例異常', 'raw_reason': raw_reason,
        }

    if exright is not None and exright > 0:
        return {
            'kind': 'capital_reduction_unsupported', 'date': when,
            'reason': '含合併除權／增資之減資事件', 'raw_reason': raw_reason,
        }

    has_complex = any(k in raw_reason for k in ('增資', '分割')) or any(k in reason_low for k in ('spin', 'increase', 'split'))
    is_loss = ('making up loss' in reason_low) or ('loss' in reason_low) or ('彌補虧損' in raw_reason)
    is_cash = ('cash' in reason_low) or ('退還' in raw_reason) or ('現金' in raw_reason)

    if has_complex or (is_loss == is_cash):
        return {
            'kind': 'capital_reduction_unsupported', 'date': when,
            'reason': f'未支援之減資類型（{raw_reason or "未註明"}）', 'raw_reason': raw_reason,
        }

    if is_loss:
        if before and after and before > 0 and after > before:
            return {
                'kind': 'capital_reduction', 'date': when, 'ratio': before / after,
                'cash': 0.0, 'reason': '彌補虧損減資', 'raw_reason': raw_reason,
            }
        return {
            'kind': 'capital_reduction_unsupported', 'date': when,
            'reason': '彌補虧損減資參考價異常', 'raw_reason': raw_reason,
        }

    par = 10.0
    if before and after and before > 0 and after > 0 and abs(before - par) >= 0.2 and abs(after - par) >= 0.2 and (before - par) * (after - par) > 0:
        ratio = (before - par) / (after - par)
        cash = round(par * (1.0 - ratio), 6)
        if 0.01 < ratio < 0.999 and 0.0 < cash < before:
            expected_after = (before - cash) / ratio
            if abs(expected_after - after) <= max(0.05, after * 0.005):
                return {
                    'kind': 'capital_reduction', 'date': when, 'ratio': ratio,
                    'cash': cash, 'reason': '現金減資', 'raw_reason': raw_reason,
                }
    return {
        'kind': 'capital_reduction_unsupported', 'date': when,
        'reason': '現金減資換股與退還股款無法由參考價唯一推算', 'raw_reason': raw_reason,
    }


def parse_tpex_reduction_detail_html(html):
    """Extract exact share ratio (per 1000 old shares) and cash refund per share from TPEx revivt HTML."""
    text = str(html or '')
    m_sh = re.search(r'每壹仟股換發新股票.*?<td[^>]*>([\d.,]+)', text, re.S)
    m_cash = re.search(r'每股退還股款.*?<td[^>]*>([\d.,]+)', text, re.S)
    m_inc = re.search(r'現金增資總股數.*?<td[^>]*>([^<]+)', text, re.S)
    if m_inc:
        inc_val = safe_float(m_inc.group(1))
        if inc_val and inc_val > 0:
            return None, None, True
    new_per_1000 = safe_float(m_sh.group(1)) if m_sh else None
    cash_per_share = safe_float(m_cash.group(1)) if m_cash else None
    ratio = (new_per_1000 / 1000.0) if (new_per_1000 is not None and 0 < new_per_1000 < 1000) else None
    return ratio, cash_per_share, False


def build_derived_series(quotes, events, calendar, *, reference_checks=None, has_price_limit=True):
    """Compute calendar-aligned TRI and PRI arrays (base 100.0 at first observed trading day).

    Args:
        quotes: list of (date, close) sorted ascending, close > 0.
        events: list of normalized event dicts:
            - {'kind': 'split', 'date': date, 'ratio': float}
            - {'kind': 'capital_reduction', 'date': date, 'ratio': float, 'cash': float}
            - {'kind': 'capital_reduction_unsupported', 'date': date, 'reason': str}
            - {'kind': 'cash', 'date': date, 'cash': float}
            - {'kind': 'stock', 'date': date, 'ratio': float}  # 1 + stock_div/10
        calendar: sorted list of official exchange trading dates (date objects).
        reference_checks: optional list of {'date': date, 'before': float, 'after': float, 'source': str}
            from official exchange reference price tables (TWT49U/exDailyQ/TWTAUU/revivt/TWTCAU/TWTB8U).
        has_price_limit: True for domestic ±10% securities, False for foreign-component / bond ETFs.

    Returns dict containing calendar-aligned `tri`, `pri`, `first_idx`, `last_idx`,
    `breaks`, `div_count`, `halt_days`, `gate_errors`, and `warnings`.
    """
    n = len(calendar)
    if n == 0 or not quotes:
        return {
            'tri': [None] * n, 'pri': [None] * n,
            'first_idx': None, 'last_idx': None, 'breaks': [],
            'div_count': 0, 'halt_days': 0, 'max_halt_streak': 0,
            'gate_errors': ['無可用收盤行情'], 'warnings': [],
        }

    cal_set = set(calendar)
    cal_idx = {d: i for i, d in enumerate(calendar)}
    quote_map = {d: float(c) for d, c in quotes if d in cal_set and c and c > 0}
    if not quote_map:
        return {
            'tri': [None] * n, 'pri': [None] * n,
            'first_idx': None, 'last_idx': None, 'breaks': [],
            'div_count': 0, 'halt_days': 0, 'max_halt_streak': 0,
            'gate_errors': ['行情日期與官方交易日曆無交集'], 'warnings': [],
        }

    obs_dates = sorted(quote_map.keys())
    first_d, last_d = obs_dates[0], obs_dates[-1]
    first_idx, last_idx = cal_idx[first_d], cal_idx[last_d]

    by_date = {}
    for ev in events or []:
        ed = ev['date']
        if first_d < ed <= last_d:
            by_date.setdefault(ed, []).append(ev)

    # Official Reference-Price Event Gate (Claude §3-3):
    # Every official reference-price change inside (first_d, last_d] must have a matching parsed event.
    gate_errors = []
    for ref in reference_checks or []:
        rd = ref.get('date')
        before, after = ref.get('before'), ref.get('after')
        if not rd or not (first_d < rd <= last_d):
            continue
        if before and after and before > 0 and after > 0 and abs(after - before) / before > 0.001:
            day_evs = by_date.get(rd, [])
            if not day_evs:
                gate_errors.append(
                    f'官方參考價閘門異常：{rd.isoformat()}（{ref.get("source", "官方參考價")} '
                    f'{before} -> {after}）但事件表無對應紀錄'
                )

    order = {'capital_reduction_unsupported': 0, 'split': 0, 'capital_reduction': 0, 'cash': 1, 'stock': 2, 'rights_issue': 2}
    tri = [None] * n
    pri = [None] * n
    breaks = []
    warnings = []
    div_count = 0

    tri_shares = 1.0
    pri_shares = 1.0
    base_close = quote_map[first_d]
    tri[first_idx] = 100.0
    pri[first_idx] = 100.0

    ev_dates = sorted(by_date.keys())
    ev_ptr = 0
    halt_days = 0
    streak = 0
    max_halt_streak = 0
    prev_tri = 100.0

    for idx in range(first_idx + 1, last_idx + 1):
        d = calendar[idx]
        close = quote_map.get(d)
        if close is None:
            halt_days += 1
            streak += 1
            if streak > max_halt_streak:
                max_halt_streak = streak
            continue
        streak = 0

        day_had_event = False
        while ev_ptr < len(ev_dates) and ev_dates[ev_ptr] <= d:
            ed = ev_dates[ev_ptr]
            ev_ptr += 1
            daily = sorted(by_date[ed], key=lambda e: order.get(e['kind'], 9))
            day_had_event = True
            has_unsupported = any(e['kind'] == 'capital_reduction_unsupported' for e in daily)
            if has_unsupported:
                reasons = '、'.join(e.get('reason', '未明減資') for e in daily if e['kind'] == 'capital_reduction_unsupported')
                breaks.append({'idx': idx, 'date': ed.isoformat(), 'reason': f'未明減資事件：{reasons}'})
                warnings.append(f'{ed.isoformat()} 含未明減資事件（{reasons}），該跨區段已設斷點')
                continue

            for ev in daily:
                if ev['kind'] == 'split':
                    tri_shares *= ev['ratio']
                    pri_shares *= ev['ratio']
                elif ev['kind'] == 'capital_reduction':
                    rc_tri = tri_shares * ev.get('cash', 0.0)
                    rc_pri = pri_shares * ev.get('cash', 0.0)
                    tri_shares *= ev['ratio']
                    pri_shares *= ev['ratio']
                    if rc_tri > 0:
                        reinvest_px = quote_map.get(ed)
                        if not reinvest_px and ed not in cal_idx and (d - ed).days <= 7:
                            reinvest_px = close
                        if not reinvest_px:
                            breaks.append({'idx': idx, 'date': ed.isoformat(), 'reason': '減資復牌日缺少收盤價'})
                            warnings.append(f'{ed.isoformat()} 減資復牌日缺少收盤價，已設斷點')
                        else:
                            tri_shares += rc_tri / reinvest_px
                            pri_shares += rc_pri / reinvest_px

            cash_tri = sum(tri_shares * ev['cash'] for ev in daily if ev['kind'] == 'cash')
            for ev in daily:
                if ev['kind'] in ('stock', 'rights_issue'):
                    tri_shares *= ev['ratio']
                    pri_shares *= ev['ratio']
            if cash_tri > 0:
                div_count += 1
                reinvest_px = quote_map.get(ed)
                if not reinvest_px and ed not in cal_idx and (d - ed).days <= 7:
                    reinvest_px = close
                if not reinvest_px:
                    breaks.append({'idx': idx, 'date': ed.isoformat(), 'reason': '除息日缺少收盤價'})
                    warnings.append(f'{ed.isoformat()} 除息日缺少收盤價，已設斷點')
                else:
                    tri_shares += cash_tri / reinvest_px

        cur_tri = round(tri_shares * close / base_close * 100.0, 6)
        cur_pri = round(pri_shares * close / base_close * 100.0, 6)
        tri[idx] = cur_tri
        pri[idx] = cur_pri

        # Auxiliary daily jump check (domestic ±10% rule vs unrestricted foreign/bond).
        if has_price_limit and not day_had_event and prev_tri > 0:
            move = abs(cur_tri / prev_tri - 1.0)
            if move > 0.115:
                warnings.append(f'{d.isoformat()} 單日調整後變動 {move * 100:.2f}%（超過國內 ±10% 漲跌幅，請人工複查是否漏事件）')
        prev_tri = cur_tri

    return {
        'tri': tri,
        'pri': pri,
        'first_idx': first_idx,
        'last_idx': last_idx,
        'first_date': first_d.isoformat(),
        'last_date': last_d.isoformat(),
        'breaks': breaks,
        'div_count': div_count,
        'halt_days': halt_days,
        'max_halt_streak': max_halt_streak,
        'gate_errors': gate_errors,
        'warnings': list(dict.fromkeys(warnings)),
    }


def _has_break(breaks, start_idx, end_idx):
    return any(start_idx < b['idx'] <= end_idx for b in (breaks or []))


def range_return_pct(series_vals, breaks, start_idx, end_idx):
    """Exact sub-period return (%) from pre-computed TRI/PRI array."""
    if start_idx is None or end_idx is None or start_idx >= end_idx:
        return None
    if _has_break(breaks, start_idx, end_idx):
        return None
    s_val, e_val = series_vals[start_idx], series_vals[end_idx]
    if s_val is None or e_val is None or s_val <= 0:
        return None
    return round((e_val / s_val - 1.0) * 100.0, 4)


def compute_calendar_returns(tri, breaks, calendar, years, *, benchmark_tri=None, benchmark_eligible=True, as_of=None):
    """Compute calendar-year returns directly from pre-computed TRI (zero dual-engine drift)."""
    as_of = as_of or (calendar[-1] if calendar else date.today())
    results = []
    for year in sorted(years, reverse=True):
        y_start = date(year, 1, 1)
        y_end = min(date(year, 12, 31), as_of)
        entry = {
            'year': year,
            'is_ytd': year == as_of.year and y_end < date(year, 12, 31),
            'start_date': None,
            'end_date': None,
            'total_ret_pct': None,
            'benchmark_ret_pct': None,
            'excess_pct': None,
            'beat_benchmark': None,
            'reason': None,
        }
        if y_end < y_start or not calendar:
            entry['reason'] = '尚未開始'
            results.append(entry)
            continue

        # Prior year-end trading day (within 10 calendar days before Jan 1).
        prev_candidates = [i for i, d in enumerate(calendar) if d < y_start and tri[i] is not None]
        if not prev_candidates or (y_start - calendar[prev_candidates[-1]]).days > 10:
            entry['reason'] = '尚無完整年度資料（可能較晚掛牌）'
            results.append(entry)
            continue
        start_idx = prev_candidates[-1]

        end_candidates = [i for i, d in enumerate(calendar) if y_start <= d <= y_end and tri[i] is not None]
        if not end_candidates or (y_end - calendar[end_candidates[-1]]).days > 7:
            entry['reason'] = '年末／最新收盤資料不足'
            results.append(entry)
            continue
        end_idx = end_candidates[-1]

        ret = range_return_pct(tri, breaks, start_idx, end_idx)
        entry['start_date'] = calendar[start_idx].isoformat()
        entry['end_date'] = calendar[end_idx].isoformat()
        if ret is None:
            entry['reason'] = '區間內含斷點或資料不足'
            results.append(entry)
            continue
        entry['total_ret_pct'] = round(ret, 2)

        if benchmark_eligible and benchmark_tri is not None:
            b_ret = range_return_pct(benchmark_tri, [], start_idx, end_idx)
            if b_ret is not None:
                entry['benchmark_ret_pct'] = round(b_ret, 2)
                excess = round(ret - b_ret, 2)
                entry['excess_pct'] = excess
                entry['beat_benchmark'] = bool(ret > b_ret) if not entry['is_ytd'] else None
        results.append(entry)
    return results


def compute_rolling_returns(tri, breaks, calendar, as_of=None):
    """Compute YTD, 1Y, 3Y rolling returns from the exact same TRI array."""
    if not calendar:
        return {'ytd': None, '1y': None, '3y': None}
    as_of = as_of or calendar[-1]
    end_candidates = [i for i, d in enumerate(calendar) if d <= as_of and tri[i] is not None]
    if not end_candidates or (as_of - calendar[end_candidates[-1]]).days > 7:
        return {'ytd': None, '1y': None, '3y': None}
    end_idx = end_candidates[-1]
    end_d = calendar[end_idx]

    def lookup(target_date):
        cands = [i for i, d in enumerate(calendar) if d <= target_date and tri[i] is not None]
        if not cands or (target_date - calendar[cands[-1]]).days > 14:
            return None
        val = range_return_pct(tri, breaks, cands[-1], end_idx)
        return round(val, 2) if val is not None else None

    ytd_target = date(end_d.year - 1, 12, 31)
    y1_target = end_d - timedelta(days=365)
    y3_target = end_d - timedelta(days=365 * 3)
    return {
        'ytd': lookup(ytd_target),
        '1y': lookup(y1_target),
        '3y': lookup(y3_target),
    }
