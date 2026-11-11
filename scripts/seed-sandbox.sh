#!/bin/sh
# 把示例帖子复制到沙盒的交换文件夹，并把发布时间改成最近（3 小时到 30 分钟之前，保持原来的先后顺序），
# 这样示例不会因为太旧被丢掉。用法：scripts/seed-sandbox.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${DSH_SANDBOX:-$ROOT/../.dsh-sandbox}"
DEST="$SANDBOX/x-desk/exchange/posts"
mkdir -p "$DEST"
node -e '
const fs = require("fs"), path = require("path")
const [src, dest] = process.argv.slice(1)
const MIN = 60000, now = Date.now()
const rows = fs.readdirSync(src).filter(f => f.endsWith(".json")).map(f => [f, JSON.parse(fs.readFileSync(path.join(src, f), "utf8"))])
rows.sort((a, b) => Date.parse(a[1].postedAt) - Date.parse(b[1].postedAt))
rows.forEach(([name, raw], i) => {
  const frac = rows.length > 1 ? i / (rows.length - 1) : 1
  const posted = now - (180 - frac * 150) * MIN
  const gap = Math.max(0, Date.parse(raw.fetchedAt) - Date.parse(raw.postedAt))
  raw.postedAt = new Date(posted).toISOString()
  raw.fetchedAt = new Date(Math.min(now - 10 * MIN, posted + gap)).toISOString()
  fs.writeFileSync(path.join(dest, name), JSON.stringify(raw, null, 2) + "\n")
})
console.log("已复制 " + rows.length + " 个示例帖子到 " + dest)
' "$ROOT/scripts/sample-exchange/posts" "$DEST"
