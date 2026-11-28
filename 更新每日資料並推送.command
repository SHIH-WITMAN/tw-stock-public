#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="$HOME/.venvs/stockV2.1-Flask/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

echo "=========================================="
echo "  台股含息趨勢｜更新每日官方資料並推送"
echo "=========================================="
echo ""
echo "[1/3] 執行 Python 與 JS 單元測試..."
PYTHONPYCACHEPREFIX="$HOME/Library/Caches/tw-stock-public/pycache" "$PYTHON_BIN" -B -m unittest discover -s tests -v
if command -v node >/dev/null 2>&1; then
  node --test tests/model.test.mjs tests/backtest.test.mjs
fi

echo ""
echo "[2/3] 向 TWSE／TPEx 抓取已啟用標的最新資料並通過閘門（近 5 年）..."
PYTHONPYCACHEPREFIX="$HOME/Library/Caches/tw-stock-public/pycache" "$PYTHON_BIN" -B -m pipeline.build_public --years 5

echo ""
echo "[3/3] 檢查並推送至 GitHub（Cloudflare Pages 將自動部署）..."
git add web/data
if git diff --cached --quiet; then
  echo "資料無變動，不需推送。"
else
  TODAY_STR="$(date '+%Y-%m-%d %H:%M')"
  git commit -m "data: update daily derived indices ($TODAY_STR)"
  git pull --rebase --autostash -X theirs origin main
  git push origin main
  echo ""
  echo "✅ 已推送完成！約 10～30 秒後可至 https://tw-stock-public.pages.dev 查看最新資料。"
fi

echo ""
read -k 1 "?按任意鍵關閉視窗..."
echo ""
