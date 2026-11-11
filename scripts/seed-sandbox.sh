#!/bin/sh
# 把示例帖子文件复制到沙盒的交换文件夹，用来在沙盒里试跑。用法：scripts/seed-sandbox.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${DSH_SANDBOX:-$ROOT/../.dsh-sandbox}"
DEST="$SANDBOX/x-desk/exchange/posts"
mkdir -p "$DEST"
cp "$ROOT"/scripts/sample-exchange/posts/*.json "$DEST/"
echo "已复制 $(ls "$ROOT"/scripts/sample-exchange/posts/*.json | wc -l | tr -d ' ') 个示例帖子到 $DEST"
