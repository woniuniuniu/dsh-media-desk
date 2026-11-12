#!/bin/sh
# 把示例帖子、自己发出的内容（mine）和回复草稿（replies）复制到沙盒的交换文件夹，并把时间改成最近
# （3 小时到 30 分钟之前，保持原来的先后顺序），这样示例不会因为太旧被丢掉。用法：scripts/seed-sandbox.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${DSH_SANDBOX:-$ROOT/../.dsh-sandbox}"
EXCHANGE="$SANDBOX/x-desk/exchange"
mkdir -p "$EXCHANGE/posts" "$EXCHANGE/mine" "$EXCHANGE/replies"
node -e '
const fs = require("fs"), path = require("path")
const [root, exchange] = process.argv.slice(1)
const MIN = 60000, now = Date.now()
// kind：子文件夹名；timeKey：决定先后顺序的时间字段；fetched：是否同时改 fetchedAt
function seed(kind, timeKey, fetched) {
  const src = path.join(root, "scripts", "sample-exchange", kind), dest = path.join(exchange, kind)
  const rows = fs.readdirSync(src).filter(f => f.endsWith(".json")).map(f => [f, JSON.parse(fs.readFileSync(path.join(src, f), "utf8"))])
  rows.sort((a, b) => Date.parse(a[1][timeKey]) - Date.parse(b[1][timeKey]))
  rows.forEach(([name, raw], i) => {
    const frac = rows.length > 1 ? i / (rows.length - 1) : 1
    const at = now - (180 - frac * 150) * MIN
    if (fetched) {
      const gap = Math.max(0, Date.parse(raw.fetchedAt) - Date.parse(raw.postedAt))
      raw.fetchedAt = new Date(Math.min(now - 10 * MIN, at + gap)).toISOString()
    }
    raw[timeKey] = new Date(at).toISOString()
    fs.writeFileSync(path.join(dest, name), JSON.stringify(raw, null, 2) + "\n")
  })
  console.log("已复制 " + rows.length + " 个示例（" + kind + "）到 " + dest)
}
seed("posts", "postedAt", true)
// 自己发出的内容：读取时间固定为 10 分钟前
seed("mine", "postedAt", false)
for (const f of fs.readdirSync(path.join(exchange, "mine"))) {
  const p = path.join(exchange, "mine", f), raw = JSON.parse(fs.readFileSync(p, "utf8"))
  raw.fetchedAt = new Date(now - 10 * MIN).toISOString()
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n")
}
seed("replies", "notifiedAt", false)
' "$ROOT" "$EXCHANGE"
