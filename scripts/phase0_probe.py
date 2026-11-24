"""Phase 0 official-source probe and TRI reconciliation script (TWSE + TPEx only, zero FinMind).

Tests four representative securities covering major Taiwan market edge cases:
- 0050   : TWSE equity ETF with 2025-06-18 1-for-4 split + 5-day share-exchange halt
- 0056   : TWSE high-dividend ETF with quarterly distributions
- 2603   : TWSE stock with 2022-09-19 60% cash capital reduction (NT$6 refund)
- 00679B : TPEx US Treasury bond ETF with TPEx prices, exDailyQ & info.tpex.org.tw payment dates

Also cross-checks 0050/0056 against local read-only market_data.db cache when available.
"""
import json
import math
import re
import sqlite3
import time
from datetime import date
from pathlib import Path
import requests

SESSION = requests.Session()
SESSION.headers.update({'User-Agent': 'Mozilla/5.0 (Phase0-Verification)'})


def parse_roc_date(text):
    """Parse ROC date like '114/06/18', '114年06月18日', or '1140618' -> date."""
    s = str(text or '').strip()
    m = re.match(r'^(\d{2,3})[/年\-](\d{1,2})[/月\-](\d{1,2})日?$', s)
    if m:
        return date(int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3)))
    m = re.match(r'^(\d{3})(\d{2})(\d{2})$', s)
    if m:
        return date(int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3)))
    m = re.match(r'^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$', s)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def num(val):
    s = str(val or '').replace(',', '').strip()
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except ValueError:
        return None


def fetch_json(url, params=None, method='GET', delay=0.6):
    time.sleep(delay)
    if method == 'POST':
        r = SESSION.post(url, data=params, timeout=20)
    else:
        r = SESSION.get(url, params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def month_range(start_ym, end_ym):
    y, m = start_ym
    ey, em = end_ym
    out = []
    while (y, m) <= (ey, em):
        out.append((y, m))
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def fetch_twse_prices(ticker, start_ym, end_ym):
    quotes = {}
    for y, m in month_range(start_ym, end_ym):
        j = fetch_json(
            'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY',
            {'date': f'{y}{m:02d}01', 'stockNo': ticker, 'response': 'json'},
        )
        if j.get('stat') != 'OK':
            continue
        for row in j.get('data', []):
            d = parse_roc_date(row[0])
            c = num(row[6])
            if d and c and c > 0:
                quotes[d] = c
    return sorted(quotes.items())


def fetch_tpex_prices(ticker, start_ym, end_ym):
    quotes = {}
    for y, m in month_range(start_ym, end_ym):
        j = fetch_json(
            'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock',
            {'date': f'{y}/{m:02d}/01', 'code': ticker, 'response': 'json'},
        )
        tables = j.get('tables') or []
        if not tables:
            continue
        for row in tables[0].get('data', []):
            d = parse_roc_date(row[0])
            c = num(row[6])
            if d and c and c > 0:
                quotes[d] = c
    return sorted(quotes.items())


def fetch_twse_etf_dividends(ticker, start_str, end_str):
    j = fetch_json(
        'https://www.twse.com.tw/rwd/zh/ETF/etfDiv',
        {'stkNo': ticker, 'startDate': start_str, 'endDate': end_str, 'response': 'json'},
    )
    events = []
    for row in j.get('data', []):
        ex_d = parse_roc_date(row[2])
        pay_d = parse_roc_date(row[4])
        cash = num(row[5])
        if ex_d and cash and cash > 0:
            events.append({'kind': 'cash', 'date': ex_d, 'cash': cash, 'pay_date': pay_d})
    return sorted(events, key=lambda e: e['date'])


def fetch_tpex_etf_dividends(ticker):
    rows = fetch_json(
        'https://info.tpex.org.tw/api/etfExDiv',
        {'stkNo': ticker, 'lang': 'zh-tw'},
        method='POST',
    )
    events = []
    for row in rows:
        ex_d = parse_roc_date(row.get('divDate'))
        pay_d = parse_roc_date(row.get('inDate'))
        cash = num(row.get('amount'))
        if ex_d and cash and cash > 0:
            events.append({'kind': 'cash', 'date': ex_d, 'cash': cash, 'pay_date': pay_d})
    return sorted(events, key=lambda e: e['date'])


def fetch_twse_etf_splits(start_str, end_str):
    j = fetch_json(
        'https://www.twse.com.tw/rwd/zh/split/TWTCAU',
        {'startDate': start_str, 'endDate': end_str, 'response': 'json'},
    )
    out = {}
    for row in j.get('data', []):
        d = parse_roc_date(row[0])
        code = str(row[1]).strip().upper()
        before = num(row[4])
        after = num(row[5])
        if d and before and after and after > 0:
            ratio = before / after
            if abs(ratio - round(ratio)) < 0.005 and round(ratio) > 0:
                ratio = float(round(ratio))
            elif ratio < 1 and abs(1 / ratio - round(1 / ratio)) < 0.02:
                ratio = 1.0 / round(1 / ratio)
            out.setdefault(code, []).append({'kind': 'split', 'date': d, 'ratio': ratio, 'before': before, 'after': after})
    return out


def fetch_twse_reductions(start_str, end_str):
    j = fetch_json(
        'https://www.twse.com.tw/rwd/zh/reducation/TWTAUU',
        {'startDate': start_str, 'endDate': end_str, 'response': 'json'},
    )
    out = {}
    for row in j.get('data', []):
        d = parse_roc_date(row[0])
        code = str(row[1]).strip().upper()
        before = num(row[3])
        after = num(row[4])
        reason = str(row[9] or '').strip()
        if not (d and before and after):
            continue
        if '退還股款' in reason:
            ratio = (before - 10.0) / (after - 10.0)
            cash = round(10.0 * (1.0 - ratio), 6)
        elif '彌補虧損' in reason:
            ratio = before / after
            cash = 0.0
        else:
            continue
        out.setdefault(code, []).append({
            'kind': 'capital_reduction', 'date': d, 'ratio': ratio, 'cash': cash,
            'before': before, 'after': after, 'reason': reason,
        })
    return out


def fetch_twse_exright(start_str, end_str):
    j = fetch_json(
        'https://www.twse.com.tw/rwd/zh/exRight/TWT49U',
        {'startDate': start_str, 'endDate': end_str, 'response': 'json'},
    )
    out = {}
    for row in j.get('data', []):
        d = parse_roc_date(row[0])
        code = str(row[1]).strip().upper()
        before = num(row[3])
        after = num(row[4])
        val = num(row[5])
        kind = str(row[6] or '').strip()
        if d and code:
            out.setdefault(code, []).append({
                'date': d, 'before': before, 'after': after, 'value': val, 'kind': kind,
            })
    return out


def compute_tri(quotes, events):
    """Build cumulative TRI & PRI (base 100.0 on quotes[0]) matching ex_date_close_drip_gross_v1."""
    closes = dict(quotes)
    by_date = {}
    for ev in events:
        if quotes[0][0] < ev['date'] <= quotes[-1][0]:
            by_date.setdefault(ev['date'], []).append(ev)
    order = {'split': 0, 'capital_reduction': 0, 'cash': 1, 'stock': 2}
    tri_shares = 1.0
    pri_shares = 1.0
    base = quotes[0][1]
    tri = [(quotes[0][0], 100.0)]
    pri = [(quotes[0][0], 100.0)]
    ev_dates = sorted(by_date.keys())
    idx = 0
    for d, close in quotes[1:]:
        while idx < len(ev_dates) and ev_dates[idx] <= d:
            ed = ev_dates[idx]
            idx += 1
            daily = sorted(by_date[ed], key=lambda e: order.get(e['kind'], 9))
            for ev in daily:
                if ev['kind'] == 'split':
                    tri_shares *= ev['ratio']
                    pri_shares *= ev['ratio']
                elif ev['kind'] == 'capital_reduction':
                    rc_tri = tri_shares * ev['cash']
                    rc_pri = pri_shares * ev['cash']
                    tri_shares *= ev['ratio']
                    pri_shares *= ev['ratio']
                    if rc_tri > 0:
                        tri_shares += rc_tri / closes[ed]
                        pri_shares += rc_pri / closes[ed]
            cash_tri = sum(tri_shares * ev['cash'] for ev in daily if ev['kind'] == 'cash')
            for ev in daily:
                if ev['kind'] == 'stock':
                    tri_shares *= ev['ratio']
                    pri_shares *= ev['ratio']
            if cash_tri > 0:
                tri_shares += cash_tri / closes[ed]
        tri.append((d, tri_shares * close / base * 100.0))
        pri.append((d, pri_shares * close / base * 100.0))
    return tri, pri


def local_finmind_compare(ticker, start_d, end_d):
    """Read-only comparison against local stockV2.1-Flask market_data.db (if cached)."""
    db = Path('/Users/witman/Library/CloudStorage/GoogleDrive-winfred.shi@gmail.com/我的雲端硬碟/亞德客/AI 系統/stockV2.1-Flask/market_data.db')
    if not db.exists():
        return None
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        def load_rows(ds, code):
            row = conn.execute(
                'SELECT payload FROM cashflow_public_cache WHERE dataset=? AND ticker=?',
                (ds, code),
            ).fetchone()
            return json.loads(row[0]) if row and row[0] else []

        px_rows = load_rows('TaiwanStockPrice', ticker)
        div_rows = load_rows('TaiwanStockDividend', ticker)
        sp_rows = load_rows('TaiwanStockSplitPrice', '*')
        if not px_rows:
            return None
        quotes = sorted({
            date.fromisoformat(r['date'][:10]): float(r['close'])
            for r in px_rows
            if r.get('date') and r.get('close') and float(r['close']) > 0
            and start_d <= date.fromisoformat(r['date'][:10]) <= end_d
        }.items())
        if len(quotes) < 2:
            return None
        events = []
        for r in div_rows:
            cd = r.get('CashExDividendTradingDate')
            c = float(r.get('CashEarningsDistribution') or 0) + float(r.get('CashStatutorySurplus') or 0)
            if cd and c > 0:
                events.append({'kind': 'cash', 'date': date.fromisoformat(cd[:10]), 'cash': c})
        for r in sp_rows:
            if str(r.get('stock_id', '')).zfill(4) == ticker and r.get('date'):
                b, a = float(r.get('before_price') or 0), float(r.get('after_price') or 0)
                if b > 0 and a > 0:
                    ratio = b / a
                    if abs(ratio - round(ratio)) < 0.005:
                        ratio = float(round(ratio))
                    events.append({'kind': 'split', 'date': date.fromisoformat(r['date'][:10]), 'ratio': ratio})
        tri, pri = compute_tri(quotes, events)
        return {
            'start': quotes[0][0].isoformat(), 'end': quotes[-1][0].isoformat(),
            'days': len(quotes),
            'tri_ret_pct': round(tri[-1][1] - 100.0, 4),
            'pri_ret_pct': round(pri[-1][1] - 100.0, 4),
        }
    finally:
        conn.close()


def main():
    report = {}

    # 1. TWSE ETF splits (2025 full year)
    splits_2025 = fetch_twse_etf_splits('20250101', '20251231')
    report['twse_splits_2025_0050'] = [
        {**e, 'date': e['date'].isoformat()} for e in splits_2025.get('0050', [])
    ]

    # 2. 0050 (2025-05 .. 2025-08: covers 2025-06-18 1-for-4 split + 5-day halt + 2025-07-21 dividend)
    q_0050 = fetch_twse_prices('0050', (2025, 5), (2025, 8))
    div_0050 = fetch_twse_etf_dividends('0050', '20250101', '20251231')
    ev_0050 = div_0050 + splits_2025.get('0050', [])
    tri_0050, pri_0050 = compute_tri(q_0050, ev_0050)
    fm_0050 = local_finmind_compare('0050', q_0050[0][0], q_0050[-1][0])
    report['0050'] = {
        'window': f'{q_0050[0][0]} ~ {q_0050[-1][0]}',
        'days': len(q_0050),
        'events': len([e for e in ev_0050 if q_0050[0][0] < e['date'] <= q_0050[-1][0]]),
        'official_tri_ret_pct': round(tri_0050[-1][1] - 100.0, 4),
        'official_pri_ret_pct': round(pri_0050[-1][1] - 100.0, 4),
        'local_finmind': fm_0050,
    }

    # 3. 0056 (2025-01 .. 2025-12: full calendar year, 4 quarterly dividends)
    q_0056 = fetch_twse_prices('0056', (2025, 1), (2025, 12))
    div_0056 = fetch_twse_etf_dividends('0056', '20250101', '20251231')
    tri_0056, pri_0056 = compute_tri(q_0056, div_0056)
    fm_0056 = local_finmind_compare('0056', q_0056[0][0], q_0056[-1][0])
    report['0056'] = {
        'window': f'{q_0056[0][0]} ~ {q_0056[-1][0]}',
        'days': len(q_0056),
        'dividends_in_year': [
            {'ex': e['date'].isoformat(), 'pay': e['pay_date'].isoformat() if e['pay_date'] else None, 'dps': e['cash']}
            for e in div_0056 if q_0056[0][0] < e['date'] <= q_0056[-1][0]
        ],
        'official_tri_ret_pct': round(tri_0056[-1][1] - 100.0, 4),
        'official_pri_ret_pct': round(pri_0056[-1][1] - 100.0, 4),
        'local_finmind': fm_0056,
    }

    # 4. 2603 (2022-08 .. 2022-10: covers 2022-09-19 60% cash capital reduction)
    q_2603 = fetch_twse_prices('2603', (2022, 8), (2022, 10))
    reds_2022 = fetch_twse_reductions('20220901', '20220930')
    ex_2603 = fetch_twse_exright('20220801', '20221031').get('2603', [])
    ev_2603 = reds_2022.get('2603', [])
    tri_2603, pri_2603 = compute_tri(q_2603, ev_2603)
    # Check resumption day (2022-09-19) vs pre-halt close (2022-09-06)
    by_d = dict(tri_2603)
    pre_d = date(2022, 9, 6)
    res_d = date(2022, 9, 19)
    res_jump_pct = round((by_d[res_d] / by_d[pre_d] - 1.0) * 100.0, 4) if pre_d in by_d and res_d in by_d else None
    raw_by_d = dict(q_2603)
    raw_jump_pct = round((raw_by_d[res_d] / raw_by_d[pre_d] - 1.0) * 100.0, 4) if pre_d in raw_by_d and res_d in raw_by_d else None
    report['2603'] = {
        'window': f'{q_2603[0][0]} ~ {q_2603[-1][0]}',
        'days': len(q_2603),
        'reduction': [{**e, 'date': e['date'].isoformat()} for e in ev_2603],
        'exright_in_window': len(ex_2603),
        'pre_halt_close': raw_by_d.get(pre_d),
        'resume_close': raw_by_d.get(res_d),
        'raw_unadjusted_1day_jump_pct': raw_jump_pct,
        'tri_adjusted_1day_move_pct': res_jump_pct,
        'official_tri_ret_pct': round(tri_2603[-1][1] - 100.0, 4),
    }

    # 5. 00679B (TPEx bond ETF: 2025-07 .. 2025-12)
    q_679b = fetch_tpex_prices('00679B', (2025, 7), (2025, 12))
    div_679b_all = fetch_tpex_etf_dividends('00679B')
    div_679b = [e for e in div_679b_all if q_679b[0][0] < e['date'] <= q_679b[-1][0]]
    tri_679b, pri_679b = compute_tri(q_679b, div_679b)
    report['00679B'] = {
        'window': f'{q_679b[0][0]} ~ {q_679b[-1][0]}',
        'days': len(q_679b),
        'total_history_dividends_count': len(div_679b_all),
        'earliest_div_date': div_679b_all[0]['date'].isoformat() if div_679b_all else None,
        'latest_div_date': div_679b_all[-1]['date'].isoformat() if div_679b_all else None,
        'dividends_with_pay_date_ratio': f"{sum(1 for e in div_679b_all if e['pay_date'])}/{len(div_679b_all)}",
        'window_dividends': [
            {'ex': e['date'].isoformat(), 'pay': e['pay_date'].isoformat() if e['pay_date'] else None, 'dps': e['cash']}
            for e in div_679b
        ],
        'official_tri_ret_pct': round(tri_679b[-1][1] - 100.0, 4),
        'official_pri_ret_pct': round(pri_679b[-1][1] - 100.0, 4),
    }

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
