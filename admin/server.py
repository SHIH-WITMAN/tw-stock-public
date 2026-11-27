"""Local-only admin server for tw-stock-public (127.0.0.1:8898).

Lives in `admin/` outside `web/`, so Cloudflare Pages never deploys this file.
Provides:
- GET  /api/state       : universe.json + per-ticker cache status + market dictionary count
- POST /api/sync-dict   : fetch 2,000+ TWSE/TPEx securities dictionary (2 requests)
- GET  /api/search?q=.. : search 2,000+ dictionary by ticker or Chinese name
- POST /api/universe    : save updated tickers / presets to config/universe.json
- POST /api/build       : start background official data fetch & build_public
- POST /api/push        : commit & push to GitHub (triggers Cloudflare Pages deploy)
- GET  /api/job         : poll running background job status & live logs
- GET  /preview/*       : preview public `web/` static files locally
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import re
import subprocess
import sys
import threading
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline.sources import OfficialStore, _classify_security  # noqa: E402

UNIVERSE_PATH = ROOT / 'config' / 'universe.json'
RAW_DIR = ROOT / 'data_raw'
WEB_DIR = ROOT / 'web'
ADMIN_DIR = ROOT / 'admin'

CATEGORY_LABELS = {
    'tw_equity': ('ETF', '台股股票型', True, True),
    'foreign_equity': ('ETF', '國外成分股', False, False),
    'bond': ('ETF', '債券型', False, False),
    'tw_stock': ('STOCK', '台股權值股', True, True),
}

_JOB_LOCK = threading.Lock()
_JOB = {
    'running': False,
    'kind': None,
    'status': 'idle',
    'logs': [],
}


def _append_log(line):
    with _JOB_LOCK:
        _JOB['logs'].append(line)
        if len(_JOB['logs']) > 400:
            _JOB['logs'] = _JOB['logs'][-400:]


def _run_subprocess_job(kind, commands):
    with _JOB_LOCK:
        if _JOB['running']:
            return False
        _JOB['running'] = True
        _JOB['kind'] = kind
        _JOB['status'] = 'running'
        _JOB['logs'] = [f'=== 開始執行：{kind} ===']

    def worker():
        ok = True
        try:
            for cmd in commands:
                _append_log(f'$ {" ".join(cmd)}')
                proc = subprocess.Popen(
                    cmd,
                    cwd=str(ROOT),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
                for line in proc.stdout:
                    _append_log(line.rstrip('\n'))
                rc = proc.wait()
                if rc != 0:
                    ok = False
                    _append_log(f'❌ 指令失敗 (exit code {rc})')
                    break
            if ok:
                _append_log('✅ 執行完成！')
        except Exception as err:
            ok = False
            _append_log(f'❌ 發生例外：{err}')
        finally:
            with _JOB_LOCK:
                _JOB['running'] = False
                _JOB['status'] = 'done' if ok else 'error'

    threading.Thread(target=worker, daemon=True).start()
    return True


def _load_universe():
    return json.loads(UNIVERSE_PATH.read_text(encoding='utf-8'))


def _save_universe(data):
    UNIVERSE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def _load_dictionary():
    dict_path = RAW_DIR / 'market_dictionary.json'
    if dict_path.exists():
        try:
            return json.loads(dict_path.read_text(encoding='utf-8'))
        except Exception:
            return []
    return []


class AdminHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return  # keep console clean

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, base_dir, rel_path):
        target = (base_dir / rel_path).resolve()
        if not str(target).startswith(str(base_dir.resolve())) or not target.exists() or target.is_dir():
            self.send_error(404, 'Not Found')
            return
        ctype, _ = mimetypes.guess_type(str(target))
        data = target.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', f'{ctype or "application/octet-stream"}; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/' or path == '/index.html':
            return self._serve_file(ADMIN_DIR, 'index.html')

        if path.startswith('/preview/'):
            rel = path[len('/preview/'):] or 'index.html'
            return self._serve_file(WEB_DIR, rel)
        if path == '/preview':
            return self._serve_file(WEB_DIR, 'index.html')

        if path == '/api/state':
            uni = _load_universe()
            store = OfficialStore(RAW_DIR)
            dict_items = _load_dictionary()
            latest_file = WEB_DIR / 'data' / 'latest.json'
            latest_info = json.loads(latest_file.read_text(encoding='utf-8')) if latest_file.exists() else None
            tickers_out = []
            for item in uni.get('tickers', []):
                cached = store.has_cached_history(item['ticker'], item['market'])
                published = False
                if latest_info:
                    pub_file = WEB_DIR / 'data' / 'v' / latest_info['version'] / 'series' / f"{item['ticker']}.json"
                    published = pub_file.exists()
                tickers_out.append({**item, 'cached': cached, 'published': published})
            return self._send_json({
                'universe': {**uni, 'tickers': tickers_out},
                'dictionary_count': len(dict_items),
                'latest': latest_info,
            })

        if path == '/api/search':
            qs = parse_qs(parsed.query)
            q = (qs.get('q', [''])[0] or '').strip().upper()
            dict_items = _load_dictionary()
            uni = _load_universe()
            existing = {t['ticker'] for t in uni.get('tickers', [])}
            if not q:
                matches = dict_items[:20]
            else:
                matches = [
                    it for it in dict_items
                    if q in it['ticker'].upper() or q in it['name'].upper()
                ][:25]
            return self._send_json({
                'results': [{**it, 'in_universe': it['ticker'] in existing} for it in matches],
                'dictionary_count': len(dict_items),
            })

        if path == '/api/job':
            with _JOB_LOCK:
                return self._send_json(dict(_JOB))

        self.send_error(404, 'Not Found')

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get('Content-Length') or 0)
        raw_body = self.rfile.read(length).decode('utf-8') if length > 0 else '{}'
        try:
            body = json.loads(raw_body or '{}')
        except Exception:
            return self._send_json({'error': 'Invalid JSON'}, status=400)

        if path == '/api/sync-dict':
            store = OfficialStore(RAW_DIR)
            _, dict_list = store.fetch_all_market_daily_and_dictionary(refresh=True)
            return self._send_json({'ok': True, 'dictionary_count': len(dict_list)})

        if path == '/api/add-ticker':
            code = str(body.get('ticker') or '').strip().upper()
            name = str(body.get('name') or '').strip()
            market = 'TPEx' if body.get('market') == 'TPEx' else 'TWSE'
            cat = str(body.get('category') or '').strip()
            enabled = bool(body.get('enabled', True))
            if not re.match(r'^[A-Z0-9]{4,10}$', code) or not name:
                return self._send_json({'error': '請輸入有效代號（4～10碼英數）與名稱'}, status=400)
            info = _classify_security(code, name, market)
            if cat in CATEGORY_LABELS:
                sec_type, cat_label, bench_ok, limit_ok = CATEGORY_LABELS[cat]
            else:
                cat = info['category']
                sec_type, cat_label, bench_ok, limit_ok = info['type'], info['category_label'], info['benchmark_eligible'], info['has_price_limit']

            uni = _load_universe()
            found = False
            for item in uni['tickers']:
                if item['ticker'] == code:
                    item.update({
                        'name': name, 'market': market, 'type': sec_type,
                        'category': cat, 'category_label': cat_label,
                        'benchmark_eligible': bench_ok, 'has_price_limit': limit_ok,
                        'enabled': enabled,
                    })
                    found = True
                    break
            if not found:
                uni['tickers'].append({
                    'ticker': code, 'name': name, 'market': market, 'type': sec_type,
                    'category': cat, 'category_label': cat_label,
                    'benchmark_eligible': bench_ok, 'has_price_limit': limit_ok,
                    'enabled': enabled,
                })
            _save_universe(uni)
            return self._send_json({'ok': True, 'added': not found, 'ticker': code})

        if path == '/api/update-ticker':
            code = str(body.get('ticker') or '').strip().upper()
            uni = _load_universe()
            if body.get('delete'):
                uni['tickers'] = [t for t in uni['tickers'] if t['ticker'] != code]
                for p in uni.get('presets', []):
                    p['tickers'] = [t for t in p.get('tickers', []) if t != code]
                _save_universe(uni)
                return self._send_json({'ok': True})

            for item in uni['tickers']:
                if item['ticker'] == code:
                    if 'enabled' in body:
                        item['enabled'] = bool(body['enabled'])
                    if 'category' in body and body['category'] in CATEGORY_LABELS:
                        cat = body['category']
                        sec_type, cat_label, bench_ok, limit_ok = CATEGORY_LABELS[cat]
                        item.update({
                            'type': sec_type, 'category': cat, 'category_label': cat_label,
                            'benchmark_eligible': bench_ok, 'has_price_limit': limit_ok,
                        })
                    if 'market' in body and body['market'] in ('TWSE', 'TPEx'):
                        item['market'] = body['market']
                    break
            _save_universe(uni)
            return self._send_json({'ok': True})

        if path == '/api/save-presets':
            presets = body.get('presets')
            if not isinstance(presets, list):
                return self._send_json({'error': 'Invalid presets list'}, status=400)
            uni = _load_universe()
            clean_presets = []
            for idx, p in enumerate(presets):
                label = str(p.get('label') or '').strip()[:30]
                tickers = [str(t).strip().upper() for t in (p.get('tickers') or []) if re.match(r'^[A-Z0-9]{4,10}$', str(t).strip().upper())]
                if label and tickers:
                    clean_presets.append({
                        'id': re.sub(r'[^a-zA-Z0-9_]', '_', str(p.get('id') or f'preset_{idx + 1}')),
                        'label': label,
                        'tickers': list(dict.fromkeys(tickers))[:8],
                        'include_market': bool(p.get('include_market', True)),
                    })
            uni['presets'] = clean_presets
            _save_universe(uni)
            return self._send_json({'ok': True, 'count': len(clean_presets)})

        if path == '/api/build':
            years = int(body.get('years') or 3)
            py = sys.executable
            started = _run_subprocess_job(
                f'抓取已啟用標的官方資料並產製衍生指數（近 {years} 年）',
                [
                    [py, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'],
                    [py, '-B', '-m', 'pipeline.build_public', '--years', str(years)],
                ],
            )
            if not started:
                return self._send_json({'error': '目前已有背景任務執行中，請稍候'}, status=409)
            return self._send_json({'ok': True})

        if path == '/api/push':
            msg = str(body.get('message') or '').strip() or 'chore: update tickers and derived indices via local admin'
            py = sys.executable
            safe_msg = msg.replace('"', '\\"')
            started = _run_subprocess_job(
                '執行測試並推送至 GitHub（觸發 Cloudflare Pages 部署）',
                [
                    [py, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'],
                    ['git', 'add', 'config/universe.json', 'web', 'pipeline', 'tests'],
                    ['zsh', '-c', f'if git diff --cached --quiet; then echo "ℹ️ 本機與 GitHub 內容一致，無新變更需提交"; else git commit -m "{safe_msg}"; fi'],
                    ['git', 'pull', '--rebase', '--autostash', '-X', 'theirs', 'origin', 'main'],
                    ['git', 'push', 'origin', 'main'],
                ],
            )
            if not started:
                return self._send_json({'error': '目前已有背景任務執行中，請稍候'}, status=409)
            return self._send_json({'ok': True})

        self.send_error(404, 'Not Found')


def main():
    port = 8898
    server = ThreadingHTTPServer(('127.0.0.1', port), AdminHandler)
    print(f'================================================')
    print(f'  台股含息趨勢｜本機專用管理後台已啟動')
    print(f'  後台網址：http://127.0.0.1:{port}')
    print(f'  前台預覽：http://127.0.0.1:{port}/preview/')
    print(f'  （僅限本機 127.0.0.1 存取，外網與公開前台完全不可見）')
    print(f'================================================')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n後台已關閉。')


if __name__ == '__main__':
    main()
