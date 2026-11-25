#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="$HOME/.venvs/stockV2.1-Flask/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

PORT=8898
URL="http://127.0.0.1:${PORT}"

if lsof -ti:${PORT} >/dev/null 2>&1; then
  echo "本機管理後台已在運行中，正在開啟瀏覽器：${URL}"
  open "${URL}"
  exit 0
fi

echo "正在啟動本機專用管理後台 (${URL})..."
(sleep 1 && open "${URL}") &
PYTHONPYCACHEPREFIX="$HOME/Library/Caches/tw-stock-public/pycache" "$PYTHON_BIN" -B admin/server.py
