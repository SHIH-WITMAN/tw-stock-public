"""Build versioned static derived-index artifacts (`web/data/`) for Cloudflare Pages.

Publishes ONLY derived cumulative indices (`tri[]`, `pri[]`), calendar returns,
rolling returns, and data status metadata — NEVER publishes raw closing prices.

Usage:
  python -B -m pipeline.build_public --synthetic                  # fast offline demo dataset
  python -B -m pipeline.build_public --tickers 0050,0056,2603,00679B --years 3
  python -B -m pipeline.build_public --years 5                    # full Phase 1 universe
"""
import argparse
from datetime import date, datetime, timedelta
import json
import math
from pathlib import Path
from zoneinfo import ZoneInfo
from pipeline import engine
from pipeline.sources import OfficialStore

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo('Asia/Taipei')


def _load_universe():
    return json.loads((ROOT / 'config' / 'universe.json').read_text(encoding='utf-8'))


def _load_overrides():
    data = json.loads((ROOT / 'config' / 'manual_overrides.json').read_text(encoding='utf-8'))
    by_ticker = {}
    for item in data.get('overrides', []):
        code = str(item.get('ticker', '')).strip().upper()
        d = engine.parse_date(item.get('date'))
        if code and d:
            by_ticker.setdefault(code, []).append({**item, 'date': d})
    return by_ticker


def _synthetic_dataset(universe, years=5):
    """Deterministic multi-year synthetic dataset covering splits, cash reduction, bonds, foreign ETFs."""
    end_d = date(2026, 11, 20)
    start_d = date(end_d.year - years, 1, 2)
    cal = []
    cur = start_d
    while cur <= end_d:
        if cur.weekday() < 5:
            cal.append(cur)
        cur += timedelta(days=1)

    # TAIEX TR & PR
    taiex_tr = []
    taiex_pr = []
    tr_v, pr_v = 30000.0, 15000.0
    for i, d in enumerate(cal):
        drift = 0.00042 + 0.0045 * math.sin(i / 27.0) + 0.002 * math.cos(i / 11.0)
        tr_v *= (1.0 + drift)
        pr_v *= (1.0 + drift - 0.00014)
        taiex_tr.append((d, round(tr_v, 2)))
        taiex_pr.append((d, round(pr_v, 2)))

    quotes_map = {}
    events_map = {}
    refs_map = {}
    for idx, meta in enumerate(universe['tickers']):
        code = meta['ticker']
        cat = meta['category']
        # Simulate late-listing for a couple of 009xx ETFs
        offset = 420 if code in ('00935', '00937B', '00933B', '00929') else (210 if code in ('00919', '00918', '00922', '00923', '00924') else 0)
        sub_cal = cal[offset:]
        p = 100.0 if cat == 'tw_stock' else (35.0 if cat == 'bond' else 40.0)
        if code == '0050':
            p = 135.0
        elif code == '2603':
            p = 95.0
        q = []
        evs = []
        refs = []
        phase = (idx + 1) * 0.7
        annual_drift = {
            'tw_equity': 0.00048 + (idx % 5) * 0.00006,
            'foreign_equity': 0.00055 + (idx % 3) * 0.00008,
            'bond': 0.00008 + (idx % 2) * 0.00003,
            'tw_stock': 0.00052 + (idx % 4) * 0.00009,
        }.get(cat, 0.0003)

        split_done = False
        red_done = False
        for j, d in enumerate(sub_cal):
            # 0050 1-for-4 split + 5-day halt in June 2025
            if code == '0050' and date(2025, 6, 11) <= d <= date(2025, 6, 17):
                continue
            if code == '0050' and d >= date(2025, 6, 18) and not split_done:
                split_done = True
                before = round(p, 2)
                after = round(before / 4.0, 2)
                p = after
                evs.append({'kind': 'split', 'date': d, 'ratio': 4.0})
                refs.append({'date': d, 'before': before, 'after': after, 'source': 'SYNTHETIC TWTCAU'})

            # 2603 60% cash capital reduction in Sep 2022
            if code == '2603' and date(2022, 9, 7) <= d <= date(2022, 9, 16):
                continue
            if code == '2603' and d >= date(2022, 9, 19) and not red_done:
                red_done = True
                before = round(p, 2)
                after = round((before - 6.0) / 0.4, 2)
                p = after
                evs.append(engine.parse_capital_reduction(d, before, after, '退還股款'))
                refs.append({'date': d, 'before': before, 'after': after, 'source': 'SYNTHETIC TWTAUU'})

            # Quarterly cash dividend on ~15th of Mar/Jun/Sep/Dec
            if d.month in (3, 6, 9, 12) and j > 10 and sub_cal[j - 1].month != d.month:
                div_rate = 0.014 if cat in ('tw_equity', 'bond') else 0.007
                cash = round(p * div_rate, 2)
                if cash > 0.05:
                    before = round(p, 2)
                    p = max(1.0, p - cash)
                    evs.append({'kind': 'cash', 'date': d, 'cash': cash})
                    refs.append({'date': d, 'before': before, 'after': round(p, 2), 'source': 'SYNTHETIC EXDIV'})

            ret = annual_drift + 0.0065 * math.sin(j / (17.0 + idx % 7) + phase)
            p = max(2.0, p * (1.0 + ret))
            q.append((d, round(p, 2)))
        quotes_map[code] = q
        events_map[code] = evs
        refs_map[code] = refs

    return {
        'as_of': end_d,
        'taiex_tr': taiex_tr,
        'taiex_pr': taiex_pr,
        'quotes': quotes_map,
        'events': events_map,
        'refs': refs_map,
        'source_mode': 'synthetic_demo',
    }


def _live_dataset(universe, selected_tickers, years=5):
    today = datetime.now(TZ).date()
    end_d = today
    start_d = date(today.year - years, 1, 1) - timedelta(days=14)
    store = OfficialStore(ROOT / 'data_raw')

    if selected_tickers is not None:
        target_codes = {
            m['ticker'] for m in universe['tickers']
            if m['ticker'] in selected_tickers
        }
    else:
        target_codes = {
            m['ticker'] for m in universe['tickers']
            if m.get('enabled', True)
        }
    print(f'[live] Fetching TAIEX TR & PR ({start_d} ~ {end_d})...', flush=True)
    taiex_tr = store.fetch_taiex_total_return(start_d, end_d, today=today)
    taiex_pr = store.fetch_taiex_price_index(start_d, end_d, today=today)
    if not taiex_tr or not taiex_pr:
        raise RuntimeError('無法取得官方大盤加權指數，中止發布')

    print('[live] Fetching official corporate actions (splits, par changes, reductions, ex-rights)...', flush=True)
    twse_splits, twse_split_refs = store.fetch_twse_etf_splits(start_d, end_d, today=today)
    twse_pars, twse_par_refs = store.fetch_twse_par_changes(start_d, end_d, today=today)
    twse_reds, twse_red_refs = store.fetch_twse_reductions(start_d, end_d, today=today)
    tpex_reds, tpex_red_refs = store.fetch_tpex_reductions(start_d, end_d, today=today)
    twse_ex, twse_ex_refs = store.fetch_twse_exright(start_d, end_d, today=today, target_tickers=target_codes)
    tpex_ex, tpex_ex_refs = store.fetch_tpex_exright(start_d, end_d, today=today)
    overrides = _load_overrides()

    print('[live] Fetching fast all-market daily snapshot & security dictionary (2 requests)...', flush=True)
    daily_patch, _ = store.fetch_all_market_daily_and_dictionary(refresh=True)

    taiex_as_of = min(taiex_tr[-1][0], taiex_pr[-1][0])
    quotes_map = {}
    events_map = {}
    refs_map = {}
    target_list = [m for m in universe['tickers'] if m['ticker'] in target_codes]
    for idx, meta in enumerate(target_list, 1):
        code = meta['ticker']
        cached_tag = '已快取增量' if store.has_cached_history(code, meta['market']) else '首次回填歷史'
        print(f'[live] [{idx}/{len(target_list)}] Fetching prices for {code} {meta["name"]} ({meta["market"]} · {cached_tag})...', flush=True)
        quotes_map[code] = store.fetch_prices(
            code, meta['market'], start_d, end_d,
            today=today, daily_patch=daily_patch, expected_end=taiex_as_of,
        )
        evs = []
        refs = []
        if meta['market'] == 'TPEx':
            evs.extend(tpex_ex.get(code, []))
            evs.extend(tpex_reds.get(code, []))
            refs.extend(tpex_ex_refs.get(code, []))
            refs.extend(tpex_red_refs.get(code, []))
        else:
            evs.extend(twse_ex.get(code, []))
            evs.extend(twse_splits.get(code, []))
            evs.extend(twse_pars.get(code, []))
            evs.extend(twse_reds.get(code, []))
            refs.extend(twse_ex_refs.get(code, []))
            refs.extend(twse_split_refs.get(code, []))
            refs.extend(twse_par_refs.get(code, []))
            refs.extend(twse_red_refs.get(code, []))
        evs.extend(overrides.get(code, []))
        events_map[code] = evs
        refs_map[code] = refs

    # Align published as_of to the latest trading day where BOTH TAIEX and >= 50% of enabled tickers
    # have closing quotes, preventing half-updated dates where TAIEX updates earlier than stocks.
    as_of = taiex_as_of
    non_empty = [q for q in quotes_map.values() if q]
    if non_empty:
        cal_dates = sorted(set(d for d, _ in taiex_tr) & set(d for d, _ in taiex_pr))
        ticker_date_sets = [set(d for d, _ in q) for q in non_empty]
        threshold = max(1, (len(ticker_date_sets) + 1) // 2)
        for d in reversed(cal_dates):
            if d > taiex_as_of:
                continue
            hits = sum(1 for ds in ticker_date_sets if d in ds)
            if hits >= threshold:
                as_of = d
                break
        if as_of < taiex_as_of:
            print(f'[live] 大盤已更新至 {taiex_as_of}，但多數個股尚停在 {as_of}，發布截止日自動對齊至 {as_of}', flush=True)
            taiex_tr = [(d, v) for d, v in taiex_tr if d <= as_of]
            taiex_pr = [(d, v) for d, v in taiex_pr if d <= as_of]
            quotes_map = {k: [(d, v) for d, v in q if d <= as_of] for k, q in quotes_map.items()}

    return {
        'as_of': as_of,
        'taiex_tr': taiex_tr,
        'taiex_pr': taiex_pr,
        'quotes': quotes_map,
        'events': events_map,
        'refs': refs_map,
        'source_mode': 'official_twse_tpex',
    }


def build_artifacts(dataset, universe, output_root):
    """Validate and emit versioned derived-index JSONs; fail-closed if gate errors occur."""
    taiex_tr_map = dict(dataset['taiex_tr'])
    taiex_pr_map = dict(dataset['taiex_pr'])
    calendar = sorted(set(taiex_tr_map.keys()) & set(taiex_pr_map.keys()))
    if len(calendar) < 2:
        raise RuntimeError('官方交易日曆不足 2 日，無法建置')

    as_of = calendar[-1]
    cal_iso = [d.isoformat() for d in calendar]
    years = list(range(calendar[0].year + 1, as_of.year + 1))

    # Benchmarks as normalized derived indices (base 100.0, no raw index points needed beyond relative ratio)
    tr_base = taiex_tr_map[calendar[0]]
    pr_base = taiex_pr_map[calendar[0]]
    taiex_tri = [round(taiex_tr_map[d] / tr_base * 100.0, 6) for d in calendar]
    taiex_pri = [round(taiex_pr_map[d] / pr_base * 100.0, 6) for d in calendar]

    version_id = f"{as_of.strftime('%Y%m%d')}-{datetime.now(TZ).strftime('%H%M%S')}"
    v_dir = Path(output_root) / 'v' / version_id
    series_dir = v_dir / 'series'
    series_dir.mkdir(parents=True, exist_ok=True)

    # Write shared exchange calendar & benchmarks
    (v_dir / 'calendar.json').write_text(
        json.dumps({'dates': cal_iso, 'as_of': as_of.isoformat()}, ensure_ascii=False),
        encoding='utf-8',
    )
    (series_dir / 'TAIEX.json').write_text(
        json.dumps({
            'ticker': 'TAIEX', 'name': '加權報酬指數', 'price_name': '加權股價指數',
            'is_market': True, 'first_idx': 0, 'last_idx': len(calendar) - 1,
            'tri': taiex_tri, 'pri': taiex_pri, 'breaks': [], 'halt_days': 0,
        }, ensure_ascii=False),
        encoding='utf-8',
    )

    catalog_items = []
    gate_failures = []
    all_warnings = []

    for meta in universe['tickers']:
        code = meta['ticker']
        if code not in dataset['quotes']:
            continue
        quotes = dataset['quotes'][code]
        events = dataset['events'].get(code, [])
        refs = dataset['refs'].get(code, [])
        calc = engine.build_derived_series(
            quotes, events, calendar,
            reference_checks=refs,
            has_price_limit=bool(meta.get('has_price_limit', True)),
        )
        if calc['gate_errors']:
            gate_failures.append({'ticker': code, 'errors': calc['gate_errors']})
            continue
        for w in calc['warnings']:
            all_warnings.append(f'{code} {meta["name"]}：{w}')

        cal_rets = engine.compute_calendar_returns(
            calc['tri'], calc['breaks'], calendar, years,
            benchmark_tri=taiex_tri,
            benchmark_eligible=True,
            as_of=as_of,
        )
        rolling = engine.compute_rolling_returns(calc['tri'], calc['breaks'], calendar, as_of=as_of)

        completed_comparable = [r for r in cal_rets if not r['is_ytd'] and r['beat_benchmark'] is not None]
        wins = sum(1 for r in completed_comparable if r['beat_benchmark'])
        comparable_years = len(completed_comparable)
        last_close = round(float(quotes[-1][1]), 2) if quotes else None

        # Write per-ticker derived index JSON (ONLY derived indices tri/pri, NO raw closing prices!)
        (series_dir / f'{code}.json').write_text(
            json.dumps({
                'ticker': code,
                'name': meta['name'],
                'market': meta['market'],
                'type': meta['type'],
                'category': meta['category'],
                'first_idx': calc['first_idx'],
                'last_idx': calc['last_idx'],
                'first_date': calc['first_date'],
                'last_date': calc['last_date'],
                'tri': calc['tri'],
                'pri': calc['pri'],
                'breaks': calc['breaks'],
                'div_count': calc['div_count'],
                'halt_days': calc['halt_days'],
                'max_halt_streak': calc['max_halt_streak'],
            }, ensure_ascii=False),
            encoding='utf-8',
        )

        catalog_items.append({
            'ticker': code,
            'name': meta['name'],
            'market': meta['market'],
            'type': meta['type'],
            'category': meta['category'],
            'category_label': meta['category_label'],
            'benchmark_eligible': True,
            'first_date': calc['first_date'],
            'last_date': calc['last_date'],
            'last_close': last_close,
            'div_count': calc['div_count'],
            'halt_days': calc['halt_days'],
            'has_breaks': bool(calc['breaks']),
            'rolling': rolling,
            'calendar_returns': cal_rets,
            'beat_wins': wins,
            'comparable_years': comparable_years,
        })

    # Neutral default order: ticker ascending (投顧法中性原則)
    catalog_items.sort(key=lambda item: item['ticker'])

    if gate_failures:
        raise RuntimeError(f'官方參考價閘門攔截 {len(gate_failures)} 檔異常，中止切換版本：{gate_failures}')

    # Compute category median per year for non-TAIEX categories (bond / foreign_equity)
    category_medians = {}
    for cat in ('bond', 'foreign_equity'):
        cat_items = [i for i in catalog_items if i['category'] == cat]
        medians = {}
        for y in years:
            vals = sorted(
                r['total_ret_pct']
                for item in cat_items
                for r in item['calendar_returns']
                if r['year'] == y and r['total_ret_pct'] is not None
            )
            if vals:
                mid = len(vals) // 2
                medians[str(y)] = round(vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2.0, 2)
        category_medians[cat] = medians

    available_codes = {item['ticker'] for item in catalog_items}
    active_presets = []
    for preset in universe.get('presets', []):
        filtered = [t for t in preset.get('tickers', []) if t in available_codes]
        if len(filtered) >= 2:
            active_presets.append({**preset, 'tickers': filtered})
    if not active_presets and len(catalog_items) >= 2:
        active_presets.append({
            'id': 'pilot_all',
            'label': '已取得官方資料代表組合',
            'tickers': [i['ticker'] for i in catalog_items[:8]],
            'include_market': True,
        })

    taiex_cal_rets = engine.compute_calendar_returns(
        taiex_tri, [], calendar, years,
        benchmark_tri=None,
        benchmark_eligible=False,
        as_of=as_of,
    )
    taiex_rolling = engine.compute_rolling_returns(taiex_tri, [], calendar, as_of=as_of)
    benchmark_summary = {
        'ticker': 'TAIEX',
        'name': '加權報酬指數（台股大盤）',
        'category_label': '比較基準',
        'last_date': as_of.isoformat(),
        'last_close': round(float(taiex_pr_map[as_of]), 2),
        'rolling': taiex_rolling,
        'calendar_returns': taiex_cal_rets,
    }

    catalog = {
        'as_of': as_of.isoformat(),
        'years': sorted(years, reverse=True),
        'benchmark': benchmark_summary,
        'presets': active_presets,
        'category_medians': category_medians,
        'items': catalog_items,
        'survivorship_notice': '僅含目前已取得官方資料並掛牌之收錄標的，不含已清算或下市標的；歷史數據不代表未來表現，非投資建議。',
    }
    (v_dir / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False), encoding='utf-8')

    manifest = {
        'version': version_id,
        'data_date': as_of.isoformat(),
        'built_at': datetime.now(TZ).isoformat(timespec='seconds'),
        'algorithm_version': engine.ALGORITHM_VERSION,
        'source_mode': dataset['source_mode'],
        'sources': [
            {'name': '臺灣證券交易所（TWSE）', 'items': '上市日行情、加權指數／報酬指數、除權息、減資與 ETF 分割參考價'},
            {'name': '證券櫃檯買賣中心（TPEx）', 'items': '上櫃日行情、除權息與減資參考價'},
        ],
        'ticker_count': len(catalog_items),
        'calendar_days': len(calendar),
        'warnings': all_warnings,
        'files': {
            'calendar': f'data/v/{version_id}/calendar.json',
            'catalog': f'data/v/{version_id}/catalog.json',
            'series_prefix': f'data/v/{version_id}/series/',
        },
    }
    (v_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

    # Atomic switch of latest.json ONLY after every artifact passed validation.
    latest_path = Path(output_root) / 'latest.json'
    latest_tmp = Path(output_root) / 'latest.json.tmp'
    latest_tmp.write_text(json.dumps({
        'version': version_id,
        'data_date': as_of.isoformat(),
        'manifest_url': f'data/v/{version_id}/manifest.json',
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    latest_tmp.replace(latest_path)
    return manifest


def main():
    parser = argparse.ArgumentParser(description='Build public derived-index JSON artifacts.')
    parser.add_argument('--synthetic', action='store_true', help='Generate deterministic synthetic dataset (offline)')
    parser.add_argument('--tickers', type=str, default='', help='Comma-separated ticker subset for pilot runs')
    parser.add_argument('--all', action='store_true', help='Include all tickers in universe.json regardless of enabled flag')
    parser.add_argument('--years', type=int, default=5, help='History depth in years (default: 5)')
    parser.add_argument('--keep-versions', type=int, default=5, help='Max versioned snapshots to retain under web/data/v (default: 5, 0=keep all)')
    parser.add_argument('--out', type=str, default=str(ROOT / 'web' / 'data'), help='Output directory')
    args = parser.parse_args()

    universe = _load_universe()
    if args.synthetic:
        dataset = _synthetic_dataset(universe, years=args.years)
    else:
        if args.all:
            subset = {m['ticker'] for m in universe['tickers']}
        elif args.tickers:
            subset = {t.strip().upper() for t in args.tickers.split(',') if t.strip()}
        else:
            subset = None
        dataset = _live_dataset(universe, subset, years=args.years)

    manifest = build_artifacts(dataset, universe, Path(args.out))
    if args.keep_versions > 0:
        import shutil
        v_root = Path(args.out) / 'v'
        if v_root.exists():
            dirs = sorted([d for d in v_root.iterdir() if d.is_dir()], key=lambda d: d.name)
            for old_dir in dirs[:-args.keep_versions]:
                shutil.rmtree(old_dir, ignore_errors=True)
    print(json.dumps({
        'status': 'OK',
        'version': manifest['version'],
        'data_date': manifest['data_date'],
        'ticker_count': manifest['ticker_count'],
        'calendar_days': manifest['calendar_days'],
        'warnings_count': len(manifest['warnings']),
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
