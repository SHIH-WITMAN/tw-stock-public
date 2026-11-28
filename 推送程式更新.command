#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="$HOME/.venvs/stockV2.1-Flask/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

echo "=========================================="
echo "  台股含息趨勢｜測試並推送程式更新"
echo "=========================================="
echo ""
echo "[1/3] 執行單元測試（未通過將中止推送）..."
PYTHONPYCACHEPREFIX="$HOME/Library/Caches/tw-stock-public/pycache" "$PYTHON_BIN" -B -m unittest discover -s tests -v
if command -v node >/dev/null 2>&1; then
  node --test tests/model.test.mjs tests/backtest.test.mjs
fi

echo ""
echo "[2/3] 目前待提交變更："
if [[ -z "$(git status --porcelain)" ]]; then
  echo "目前沒有任何程式或設定變更。"
  echo ""
  read -k 1 "?按任意鍵關閉視窗..."
  echo ""
  exit 0
fi
git status -s

echo ""
printf "請輸入本次更新說明（直接按 Enter 將使用預設訊息）: "
read -r COMMIT_MSG
if [[ -z "${COMMIT_MSG// /}" ]]; then
  COMMIT_MSG="chore: update app ($(date '+%Y-%m-%d %H:%M'))"
fi

echo ""
echo "[3/3] 同步遠端並提交推送至 GitHub（Cloudflare Pages 將自動部署）..."
git add -A
git commit -m "$COMMIT_MSG"
git pull --rebase --autostash -X theirs origin main
git push origin main

echo ""
echo "✅ 程式已推送完成！約 10～30 秒後 https://tw-stock-public.pages.dev 將自動更新。"
echo ""
read -k 1 "?按任意鍵關閉視窗..."
echo ""
