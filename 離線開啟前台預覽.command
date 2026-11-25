#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT=8899
URL="http://127.0.0.1:${PORT}/"

echo "=========================================="
echo "  台股含息趨勢觀察｜本機離線前台預覽"
echo "  網址：${URL}"
echo "  （完全離線讀取本機 web/data/，不需網路）"
echo "  關閉此終端機視窗或按 Ctrl+C 即可停止"
echo "=========================================="

# 若先前已有舊的 8899 伺服器則先結束
lsof -ti tcp:${PORT} 2>/dev/null | xargs -r kill 2>/dev/null || true

(sleep 1 && open "${URL}") &
exec python3 -B -m http.server ${PORT} --bind 127.0.0.1 --directory "${SCRIPT_DIR}/web"
