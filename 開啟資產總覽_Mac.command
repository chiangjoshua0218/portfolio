#!/bin/bash
# 用獨立的 Chrome profile 開啟，關閉 CORS 限制（不影響正常 Chrome）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
open -na "Google Chrome" --args \
  --disable-web-security \
  --user-data-dir=/tmp/portfolio-chrome \
  "file://$SCRIPT_DIR/index.html"
