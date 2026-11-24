"""Official TWSE and TPEx data fetchers with polite rate limiting and local cache.

Zero FinMind dependency. Raw data is cached under local `data_raw/` (gitignored,
never published to `web/data/`).
"""
from datetime import date, timedelta
import json
from pathlib import Path
import time
import requests
from pipeline import engine

SESSION = requests.Session()
SESSION.headers.update({'User-Agent': 'tw-stock-public-phase1/1.0 (non-commercial research)'})


def _get_json(url, params=None, *, method='GET', delay=0.8, retries=4):
    last_err = None
    for attempt in range(retries + 1):
        time.sleep(delay if attempt == 0 else 10.0 * attempt)
        try:
            if method == 'POST':
                r = SESSION.post(url, data=params, timeout=25)
            else:
                r = SESSION.get(url, params=params, timeout=25)
            r.raise_for_status()
            if not r.text or not r.text.strip():
                raise ValueError('Empty response body (possible rate limit)')
            return r.json()
        except Exception as err:
            last_err = err
    raise RuntimeError(f'Official endpoint failed ({url}): {last_err}')


def month_range(start_d, end_d):
    y, m = start_d.year, start_d.month
    out = []
    while (y, m) <= (end_d.year, end_d.month):
        out.append((y, m))
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


class OfficialStore:
    """File-backed local cache for official TWSE/TPEx raw responses."""

    def __init__(self, raw_dir):
        self.raw_dir = Path(raw_dir)
        self.raw_dir.mkdir(parents=True, exist_ok=True)

    def _cache_path(self, key):
        safe = key.replace('/', '_').replace(':', '_')
        return self.raw_dir / f'{safe}.json'

    def _cached(self, key, fetcher, *, refresh=False):
        path = self._cache_path(key)
        if path.exists() and not refresh:
            return json.loads(path.read_text(encoding='utf-8'))
        data = fetcher()
        path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        return data

    def fetch_taiex_total_return(self, start_d, end_d, *, today=None):
        """TWSE MFI94U: TAIEX Total Return Index (加權報酬指數)."""
        today = today or date.today()
        quotes = {}
        for y, m in month_range(start_d, end_d):
            is_cur = (y, m) >= (today.year, today.month)
            j = self._cached(
                f'twse_mfi94u_{y}{m:02d}',
                lambda y=y, m=m: _get_json(
                    'https://www.twse.com.tw/rwd/zh/TAIEX/MFI94U',
                    {'date': f'{y}{m:02d}01', 'response': 'json'},
                ),
                refresh=is_cur,
            )
            if j.get('stat') != 'OK':
                continue
            for row in j.get('data', []):
                d = engine.parse_date(row[0])
                v = engine.safe_float(row[1])
                if d and v and v > 0 and start_d <= d <= end_d:
                    quotes[d] = v
        return sorted(quotes.items())

    def fetch_taiex_price_index(self, start_d, end_d, *, today=None):
        """TWSE FMTQIK: TAIEX Price Index (加權股價指數)."""
        today = today or date.today()
        quotes = {}
        for y, m in month_range(start_d, end_d):
            is_cur = (y, m) >= (today.year, today.month)
            j = self._cached(
                f'twse_fmtqik_{y}{m:02d}',
                lambda y=y, m=m: _get_json(
                    'https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK',
                    {'date': f'{y}{m:02d}01', 'response': 'json'},
                ),
                refresh=is_cur,
            )
            if j.get('stat') != 'OK':
                continue
            for row in j.get('data', []):
                d = engine.parse_date(row[0])
                v = engine.safe_float(row[4])
                if d and v and v > 0 and start_d <= d <= end_d:
                    quotes[d] = v
        return sorted(quotes.items())

    def fetch_prices(self, ticker, market, start_d, end_d, *, today=None):
        today = today or date.today()
        quotes = {}
        empty_streak = 0
        # Walk backwards from latest month to earliest so pre-IPO empty months stop early.
        for y, m in reversed(month_range(start_d, end_d)):
            is_cur = (y, m) >= (today.year, today.month)
            if market == 'TPEx':
                j = self._cached(
                    f'tpex_px_{ticker}_{y}{m:02d}',
                    lambda y=y, m=m: _get_json(
                        'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock',
                        {'date': f'{y}/{m:02d}/01', 'code': ticker, 'response': 'json'},
                    ),
                    refresh=is_cur,
                )
                tables = j.get('tables') or []
                rows = tables[0].get('data', []) if tables else []
            else:
                j = self._cached(
                    f'twse_px_{ticker}_{y}{m:02d}',
                    lambda y=y, m=m: _get_json(
                        'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY',
                        {'date': f'{y}{m:02d}01', 'stockNo': ticker, 'response': 'json'},
                    ),
                    refresh=is_cur,
                )
                rows = j.get('data', []) if j.get('stat') == 'OK' else []
            month_hits = 0
            for row in rows:
                d = engine.parse_date(row[0])
                v = engine.safe_float(row[6])
                if d and v and v > 0 and start_d <= d <= end_d:
                    quotes[d] = v
                    month_hits += 1
            if month_hits == 0 and not is_cur:
                empty_streak += 1
                if empty_streak >= 2:
                    break
            else:
                empty_streak = 0
        return sorted(quotes.items())

    def fetch_twse_etf_splits(self, start_d, end_d, *, today=None):
        today = today or date.today()
        events_by_ticker = {}
        refs_by_ticker = {}
        for y in range(start_d.year, end_d.year + 1):
            s = f'{y}0101'
            e = f'{y}1231'
            j = self._cached(
                f'twse_twtcau_{y}',
                lambda s=s, e=e: _get_json(
                    'https://www.twse.com.tw/rwd/zh/split/TWTCAU',
                    {'startDate': s, 'endDate': e, 'response': 'json'},
                ),
                refresh=(y >= today.year),
            )
            for row in j.get('data', []):
                d = engine.parse_date(row[0])
                code = str(row[1]).strip().upper()
                before, after = engine.safe_float(row[4]), engine.safe_float(row[5])
                if not (d and code and before and after):
                    continue
                refs_by_ticker.setdefault(code, []).append({'date': d, 'before': before, 'after': after, 'source': 'TWSE TWTCAU'})
                ratio = engine.normalize_split_ratio(before, after)
                if ratio and abs(ratio - 1.0) > 1e-6:
                    events_by_ticker.setdefault(code, []).append({'kind': 'split', 'date': d, 'ratio': ratio})
        return events_by_ticker, refs_by_ticker

    def fetch_twse_par_changes(self, start_d, end_d, *, today=None):
        """TWSE TWTB8U: stock par-value change splits (e.g. 2327 1-for-4 in 2025)."""
        today = today or date.today()
        events_by_ticker = {}
        refs_by_ticker = {}
        for y in range(start_d.year, end_d.year + 1):
            s = f'{y}0101'
            e = f'{y}1231'
            j = self._cached(
                f'twse_twtb8u_{y}',
                lambda s=s, e=e: _get_json(
                    'https://www.twse.com.tw/rwd/zh/change/TWTB8U',
                    {'startDate': s, 'endDate': e, 'response': 'json'},
                ),
                refresh=(y >= today.year),
            )
            for row in j.get('data', []):
                d = engine.parse_date(row[0])
                code = str(row[1]).strip().upper()
                before, after = engine.safe_float(row[3]), engine.safe_float(row[4])
                if not (d and code and before and after):
                    continue
                refs_by_ticker.setdefault(code, []).append({'date': d, 'before': before, 'after': after, 'source': 'TWSE TWTB8U'})
                ratio = engine.normalize_split_ratio(before, after)
                if ratio and abs(ratio - 1.0) > 1e-6:
                    events_by_ticker.setdefault(code, []).append({'kind': 'split', 'date': d, 'ratio': ratio})
        return events_by_ticker, refs_by_ticker

    def fetch_twse_reductions(self, start_d, end_d, *, today=None):
        today = today or date.today()
        events_by_ticker = {}
        refs_by_ticker = {}
        for y in range(start_d.year, end_d.year + 1):
            s = f'{y}0101'
            e = f'{y}1231'
            j = self._cached(
                f'twse_twtauu_{y}',
                lambda s=s, e=e: _get_json(
                    'https://www.twse.com.tw/rwd/zh/reducation/TWTAUU',
                    {'startDate': s, 'endDate': e, 'response': 'json'},
                ),
                refresh=(y >= today.year),
            )
            for row in j.get('data', []):
                d = engine.parse_date(row[0])
                code = str(row[1]).strip().upper()
                before, after = engine.safe_float(row[3]), engine.safe_float(row[4])
                exright = engine.safe_float(row[8])
                reason = row[9] if len(row) > 9 else ''
                if not (d and code):
                    continue
                if before and after:
                    refs_by_ticker.setdefault(code, []).append({'date': d, 'before': before, 'after': after, 'source': 'TWSE TWTAUU'})
                ev = engine.parse_capital_reduction(d, before, after, reason, exright=exright)
                events_by_ticker.setdefault(code, []).append(ev)
        return events_by_ticker, refs_by_ticker

    def fetch_tpex_reductions(self, start_d, end_d, *, today=None):
        today = today or date.today()
        events_by_ticker = {}
        refs_by_ticker = {}
        for y in range(start_d.year, end_d.year + 1):
            j = self._cached(
                f'tpex_revivt_{y}',
                lambda y=y: _get_json(
                    'https://www.tpex.org.tw/www/zh-tw/bulletin/revivt',
                    {'startDate': f'{y}/01/01', 'endDate': f'{y}/12/31', 'response': 'json'},
                ),
                refresh=(y >= today.year),
            )
            tables = j.get('tables') or []
            rows = tables[0].get('data', []) if tables else []
            for row in rows:
                d = engine.parse_date(row[0])
                code = str(row[1]).strip().upper()
                before, after = engine.safe_float(row[3]), engine.safe_float(row[4])
                exright = engine.safe_float(row[8])
                reason = row[9] if len(row) > 9 else ''
                detail_html = row[10] if len(row) > 10 else ''
                if not (d and code):
                    continue
                if before and after:
                    refs_by_ticker.setdefault(code, []).append({'date': d, 'before': before, 'after': after, 'source': 'TPEx revivt'})
                exp_ratio, exp_cash, has_inc = engine.parse_tpex_reduction_detail_html(detail_html)
                if has_inc:
                    ev = {'kind': 'capital_reduction_unsupported', 'date': d, 'reason': '含合併現金增資之減資事件', 'raw_reason': str(reason)}
                elif exp_ratio is not None and exp_cash is not None:
                    ev = engine.parse_capital_reduction(d, before, after, reason, explicit_ratio=exp_ratio, explicit_cash=exp_cash)
                else:
                    ev = engine.parse_capital_reduction(d, before, after, reason, exright=exright)
                events_by_ticker.setdefault(code, []).append(ev)
        return events_by_ticker, refs_by_ticker

    def fetch_twse_exright(self, start_d, end_d, *, today=None, target_tickers=None):
        """TWSE TWT49U: cash/stock dividends + official reference prices for listed stocks/ETFs."""
        today = today or date.today()
        events_by_ticker = {}
        refs_by_ticker = {}
        for y in range(start_d.year, end_d.year + 1):
            j = self._cached(
                f'twse_twt49u_{y}',
                lambda y=y: _get_json(
                    'https://www.twse.com.tw/rwd/zh/exRight/TWT49U',
                    {'startDate': f'{y}0101', 'endDate': f'{y}1231', 'response': 'json'},
                ),
                refresh=(y >= today.year),
            )
            for row in j.get('data', []):
                d = engine.parse_date(row[0])
                code = str(row[1]).strip().upper()
                if target_tickers is not None and code not in target_tickers:
                    continue
                before, after = engine.safe_float(row[3]), engine.safe_float(row[4])
                val = engine.safe_float(row[5])
                kind = str(row[6] or '').strip()
                if not (d and code):
                    continue
                if before and after:
                    refs_by_ticker.setdefault(code, []).append({'date': d, 'before': before, 'after': after, 'source': 'TWSE TWT49U'})
                if kind == '息' and val and val > 0:
                    events_by_ticker.setdefault(code, []).append({'kind': 'cash', 'date': d, 'cash': val})
                elif '權' in kind:
                    # Fetch exact detail when stock rights are involved.
                    det = self._cached(
                        f'twse_twt49udet_{code}_{d.strftime("%Y%m%d")}',
                        lambda code=code, d=d: _get_json(
                            'https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail',
                            {'STK_NO': code, 'T1': d.strftime('%Y%m%d'), 'response': 'json'},
                        ),
                    )
                    drows = det.get('data') or []
                    if drows:
                        c_div = engine.safe_float(drows[0][2]) or 0.0
                        # Columns 4 & 5: earnings / surplus free shares per 1000 shares
                        s_free = (engine.safe_float(drows[0][4]) or 0.0) + (engine.safe_float(drows[0][5]) or 0.0)
                        if c_div > 0:
                            events_by_ticker.setdefault(code, []).append({'kind': 'cash', 'date': d, 'cash': c_div})
                        if s_free > 0:
                            events_by_ticker.setdefault(code, []).append({'kind': 'stock', 'date': d, 'ratio': 1.0 + s_free / 1000.0})
        return events_by_ticker, refs_by_ticker

    def fetch_tpex_exright(self, start_d, end_d, *, today=None):
        """TPEx exDailyQ: exact cash dividend, stock dividend, and official reference prices."""
        today = today or date.today()
        events_by_ticker = {}
        refs_by_ticker = {}
        for y in range(start_d.year, end_d.year + 1):
            j = self._cached(
                f'tpex_exdailyq_{y}',
                lambda y=y: _get_json(
                    'https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ',
                    {'startDate': f'{y}/01/01', 'endDate': f'{y}/12/31', 'response': 'json'},
                ),
                refresh=(y >= today.year),
            )
            tables = j.get('tables') or []
            rows = tables[0].get('data', []) if tables else []
            for row in rows:
                d = engine.parse_date(row[0])
                code = str(row[1]).strip().upper()
                before, after = engine.safe_float(row[3]), engine.safe_float(row[4])
                cash = engine.safe_float(row[13]) if len(row) > 13 else None
                stock_per_1000 = engine.safe_float(row[14]) if len(row) > 14 else None
                if not (d and code):
                    continue
                if before and after:
                    refs_by_ticker.setdefault(code, []).append({'date': d, 'before': before, 'after': after, 'source': 'TPEx exDailyQ'})
                if cash and cash > 0:
                    events_by_ticker.setdefault(code, []).append({'kind': 'cash', 'date': d, 'cash': cash})
                if stock_per_1000 and stock_per_1000 > 0:
                    events_by_ticker.setdefault(code, []).append({'kind': 'stock', 'date': d, 'ratio': 1.0 + stock_per_1000 / 1000.0})
        return events_by_ticker, refs_by_ticker
