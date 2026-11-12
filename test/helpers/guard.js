// 防护规则：对一个文件的路径和内容，返回它违反了哪些规则。纯函数，便于自测。

// x.com 只允许出现在这些文件里：
// exchange.js 拼帖子链接，inbox.js 和 client/util.js（镜像 intentUrl）拼发帖链接，
// client/watch.jsx 只在输入框的提示文字里举例主页链接。
export const X_ALLOWED = new Set(['src/exchange.js', 'src/inbox.js', 'client/util.js', 'client/watch.jsx'])

// 按能力放行：images.js 可以用 fetch（下载和生成图片）；harvest.js 只可以引入 dns 和 net（校验链接，自己不发请求）。
const FETCH_ALLOWED = new Set(['src/images.js'])
const MODULES_ALLOWED = { 'src/harvest.js': new Set(['dns', 'net']) }

// 原版插件的目录名只允许出现在 settings.js：它要拒绝把交换文件夹设到那个目录里，所以必须知道这个名字（只比较路径，不读写）。
const OLD_DIR_ALLOWED = new Set(['src/settings.js'])

const FORBIDDEN_MODULE = /^(?:node:)?(http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster)(?:\/.*)?$/
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/g
const FETCH = /(?<![\w$.-])fetch(?![\w$-])|\.fetch\b|globalThis\s*\[/
const X_HOST = /(?:\/\/|\.|["'`])(?:x|twitter)\.com/
const REMOTE_SERVICES = /api\.x\.com|api\.twitter\.com|monid|tikhub|apify/i
const WRITE_CALLS = /likeTweet|createTweet|retweet|\/2\/tweets|statuses\/update|favorites\/create|friendships\/create/i

/**
 * @param {string} path - 相对仓库根的路径，如 src/host.js。
 * @param {string} source - 文件内容。
 * @returns {string[]} 违反的规则描述，空数组表示干净。
 */
export function violations(path, source) {
  const out = []
  const inSrc = path.startsWith('src/')
  if (inSrc) {
    const imports = path === 'src/sync.js'
      ? source.replace(/\bimport\s*\{\s*execFile\s*\}\s*from\s*(['"])(?:node:)?child_process\1/g, '')
      : source
    for (const [, , spec] of imports.matchAll(SPECIFIER)) {
      const m = FORBIDDEN_MODULE.exec(spec)
      if (m && !MODULES_ALLOWED[path]?.has(m[1])) out.push(`禁止引入网络或子进程模块：${spec}`)
    }
    if (path === 'src/sync.js' && /(?<![\w$.])exec\s*\(|\b(?:execSync|spawn|spawnSync|fork)\b|\bshell\s*:/.test(source)) out.push('同步只允许 execFile，禁止 shell')
    if (path === 'src/sync.js' && /\bexecFile\s*\((?!\s*(['"])git\1\s*[,)])/.test(source)) out.push('同步只允许执行 git')
    // Git 的固定子命令字符串不等于调用网络 fetch；其余写法照旧检查。
    const networkSource = path === 'src/sync.js' ? source.replace(/(['"])fetch\1/g, '') : source
    if (FETCH.test(networkSource) && !FETCH_ALLOWED.has(path)) out.push('禁止使用 fetch')
    if (/XMLHttpRequest|WebSocket/.test(source)) out.push('禁止使用 XMLHttpRequest 或 WebSocket')
    if (REMOTE_SERVICES.test(source)) out.push('禁止出现 X 接口或抓取服务域名')
    if (WRITE_CALLS.test(source)) out.push('禁止出现点赞、发帖、转发、关注的调用')
  }
  if ((inSrc || path.startsWith('client/')) && /media-desk/.test(source) && !OLD_DIR_ALLOWED.has(path)) out.push('禁止读写原版插件的数据目录')
  if (X_HOST.test(source) && !X_ALLOWED.has(path)) out.push('x.com 或 twitter.com 出现在不允许的文件里')
  return out
}
