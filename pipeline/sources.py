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
_NET_REQ_COUNT = 0


def _classify_security(code, name, market):
    """Infer type and default category from official code/name."""
    is_etf = code.startswith('00')
    sec_type = 'ETF' if is_etf else 'STOCK'
    if not is_etf:
        return {
            'type': 'STOCK',
            'category': 'tw_stock',
            'category_label': '台股權值股',
            'benchmark_eligible': True,
            'has_price_limit': True,
        }
    if code.endswith('B') or any(k in name for k in ('債', '公債', '公司債', '金融債')):
        return {
            'type': 'ETF',
            'category': 'bond',
            'category_label': '債券型',
            'benchmark_eligible': False,
            'has_price_limit': False,
        }
    if any(k in name.upper() for k in ('S&P', 'NASDAQ', 'FANG', '費城', '美國', '美股', '日本', '日經', '歐洲', '印度', '全球', '海外', '中國', '恒生', '滬深', '越南')):
        return {
            'type': 'ETF',
            'category': 'foreign_equity',
            'category_label': '國外成分股',
            'benchmark_eligible': False,
            'has_price_limit': False,
        }
    return {
        'type': 'ETF',
        'category': 'tw_equity',
        'category_label': '台股股票型',
        'benchmark_eligible': True,
        'has_price_limit': True,
    }


def _get_json(url, params=None, *, method='GET', delay=0.8, retries=4):
    global _NET_REQ_COUNT
    _NET_REQ_COUNT += 1
    if _NET_REQ_COUNT > 1 and (_NET_REQ_COUNT % 25 == 0):
        print(f'  [節流保護] 已連續請求 {_NET_REQ_COUNT} 次，自動暫停 6 秒避免觸發證交所限流...', flush=True)
        time.sleep(6.0)
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

    def has_cached_history(self, ticker, market):
        prefix = 'tpex_px_' if market == 'TPEx' else 'twse_px_'
        return any(self.raw_dir.glob(f'{prefix}{ticker}_*.json'))

    def fetch_all_market_daily_and_dictionary(self, *, refresh=True):
        """Fast 2-request all-market daily snapshot + 2,000+ security search dictionary."""
        dict_path = self.raw_dir / 'market_dictionary.json'
        snap_path = self.raw_dir / 'daily_all_snapshot.json'
        if not refresh and dict_path.exists() and snap_path.exists():
            return (
                json.loads(snap_path.read_text(encoding='utf-8')),
                json.loads(dict_path.read_text(encoding='utf-8')),
            )

        daily_prices = {}
        dictionary = {}

        # 1. TWSE OpenAPI STOCK_DAY_ALL (1 request for all listed stocks & ETFs)
        try:
            twse_rows = _get_json('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', delay=0.25)
            if isinstance(twse_rows, list):
                for row in twse_rows:
                    code = str(row.get('Code') or '').strip().upper()
                    name = str(row.get('Name') or '').strip()
                    if not code or not name or len(code) < 4 or code.endswith(('R', 'L')):
                        continue
                    d = engine.parse_date(row.get('Date'))
                    c = engine.safe_float(row.get('ClosingPrice'))
                    if d and c and c > 0:
                        daily_prices[code] = {'date': d.isoformat(), 'close': c, 'market': 'TWSE'}
                    info = _classify_security(code, name, 'TWSE')
                    dictionary[code] = {'ticker': code, 'name': name, 'market': 'TWSE', **info}
        except Exception as err:
            print(f'  [提示] TWSE 全市場當日快照略過: {err}', flush=True)

        # 2. TPEx OpenAPI daily close quotes (1 request for all OTC stocks & bond ETFs)
        try:
            tpex_rows = _get_json('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', delay=0.25)
            if isinstance(tpex_rows, list):
                for row in tpex_rows:
                    code = str(row.get('SecuritiesCompanyCode') or '').strip().upper()
                    name = str(row.get('CompanyName') or '').strip()
                    if not code or not name or len(code) < 4 or len(code) > 6 or code.endswith(('R', 'L')):
                        continue
                    d = engine.parse_date(row.get('Date'))
                    c = engine.safe_float(row.get('Close'))
                    if d and c and c > 0:
                        daily_prices[code] = {'date': d.isoformat(), 'close': c, 'market': 'TPEx'}
                    info = _classify_security(code, name, 'TPEx')
                    dictionary[code] = {'ticker': code, 'name': name, 'market': 'TPEx', **info}
        except Exception as err:
            print(f'  [提示] TPEx 全市場當日快照略過: {err}', flush=True)

        dict_list = sorted(dictionary.values(), key=lambda x: x['ticker'])
        if dict_list:
            dict_path.write_text(json.dumps(dict_list, ensure_ascii=False, indent=2), encoding='utf-8')
        if daily_prices:
            snap_path.write_text(json.dumps(daily_prices, ensure_ascii=False), encoding='utf-8')
        return daily_prices, dict_list

    def fetch_prices(self, ticker, market, start_d, end_d, *, today=None, daily_patch=None, expected_end=None):
        today = today or date.today()
        quotes = {}
        empty_streak = 0
        patch_item = (daily_patch or {}).get(ticker)
        patch_d = engine.parse_date(patch_item['date']) if patch_item else None
        patch_c = engine.safe_float(patch_item['close']) if patch_item else None

        # Walk backwards from latest month to earliest so pre-IPO empty months stop early.
        for y, m in reversed(month_range(start_d, end_d)):
            is_cur = (y, m) >= (today.year, today.month)
            cache_key = f'tpex_px_{ticker}_{y}{m:02d}' if market == 'TPEx' else f'twse_px_{ticker}_{y}{m:02d}'
            cache_file = self._cache_path(cache_key)

            # Fast-track: only skip per-ticker monthly refresh when BOTH:
            # (1) current month is cached, AND
            # (2) either cache already reaches expected_end, OR daily_patch reaches expected_end
            #     within 4 days of the cached latest session (prevents skipping when OpenAPI lags TAIEX!).
            need_refresh = is_cur
            if is_cur and cache_file.exists():
                try:
                    cached_j = json.loads(cache_file.read_text(encoding='utf-8'))
                    c_rows = (cached_j.get('tables') or [{}])[0].get('data', []) if market == 'TPEx' else (cached_j.get('data', []) if cached_j.get('stat') == 'OK' else [])
                    c_dates = [engine.parse_date(r[0]) for r in c_rows if engine.parse_date(r[0])]
                    if c_dates:
                        max_cached = max(c_dates)
                        if expected_end and max_cached >= expected_end:
                            need_refresh = False
                        elif patch_d and patch_c and (not expected_end or patch_d >= expected_end) and (patch_d - max_cached).days <= 4:
                            need_refresh = False
                except Exception:
                    need_refresh = True

            if market == 'TPEx':
                j = self._cached(
                    cache_key,
                    lambda y=y, m=m: _get_json(
                        'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock',
                        {'date': f'{y}/{m:02d}/01', 'code': ticker, 'response': 'json'},
                    ),
                    refresh=need_refresh,
                )
                tables = j.get('tables') or []
                rows = tables[0].get('data', []) if tables else []
            else:
                j = self._cached(
                    cache_key,
                    lambda y=y, m=m: _get_json(
                        'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY',
                        {'date': f'{y}{m:02d}01', 'stockNo': ticker, 'response': 'json'},
                    ),
                    refresh=need_refresh,
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

        if patch_d and patch_c and patch_c > 0 and start_d <= patch_d <= end_d:
            quotes[patch_d] = patch_c
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
                    # Fetch exact detail when stock rights or cash capital-increase subscription are involved.
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
                        # Column 4 ONLY: A. 按普通股股東持股比例每千股無償配股
                        # (Column 5 is B. 員工紅利轉增資 total company shares — NOT per-1000 shareholder stock dividend!)
                        s_free = engine.safe_float(drows[0][4]) or 0.0
                        # Column 6: cash capital increase (有償現金增資) new shares
                        c_sub = (engine.safe_float(drows[0][6]) or 0.0) if len(drows[0]) > 6 else 0.0
                        if c_div > 0:
                            events_by_ticker.setdefault(code, []).append({'kind': 'cash', 'date': d, 'cash': c_div})
                        if s_free > 0:
                            events_by_ticker.setdefault(code, []).append({'kind': 'stock', 'date': d, 'ratio': 1.0 + s_free / 1000.0})
                        if c_sub > 0 and before and after and before > 0 and after > 0:
                            # Residual ex-rights factor after accounting for cash dividend and free stock dividend
                            theo_after_free = (before - c_div) / (1.0 + s_free / 1000.0)
                            rights_ratio = theo_after_free / after
                            if rights_ratio > 1.0005:
                                events_by_ticker.setdefault(code, []).append({'kind': 'rights_issue', 'date': d, 'ratio': rights_ratio})
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
