// 创作中心数据抓取：小红书（内容分析·逐笔记累计→增量）、B站（首页昨日增量）、抖音（数据中心·昨天）。
// 用法：ego-browser nodejs < scripts/scrape-creator-centers.mjs
// 环境变量：MEDIA_DESK_GUI（DSH 网页版地址，默认 http://127.0.0.1:3080）、MEDIA_DESK_HOME（数据目录，默认 ~/.dsh/media-desk）。
// 结果：最后一行输出 SCRAPE_RESULT {json}；写入走 DSH GUI 标签页的同源 fetch（带用户会话）。
// 去重：数据目录下的 scrape-cache.json 记录已写入的键与逐笔记累计值，重复跑不会重复写。
const fs = await import('node:fs/promises')
const { join } = await import('node:path')
const { homedir } = await import('node:os')

const CACHE_FILE = join(process.env.MEDIA_DESK_HOME ?? join(homedir(), '.dsh', 'media-desk'), 'scrape-cache.json')
const GUI_URL = process.env.MEDIA_DESK_GUI ?? 'http://127.0.0.1:3080'
const RUN_DATE = new Date().toLocaleDateString('sv-SE') // 本地 YYYY-MM-DD

const summary = { date: RUN_DATE, written: 0, platforms: {}, errors: [] }
const num = s => Number(String(s ?? '').replace(/,/g, '')) || 0
const iso = date => new Date(`${date}T12:00:00+08:00`).toISOString()

async function readCache() {
  try { return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')) } catch { return { notes: {}, days: {} } }
}

function isLoginWall(text) {
  return /扫码登录|登录后|手机号登录|验证码登录/.test(text.slice(0, 2000))
}

/** 小红书：内容分析表，逐笔记累计值。首次见的笔记按发布日期记存量，之后记增量。 */
async function scrapeXhs(page, cache, rows) {
  await page.goto('https://creator.xiaohongshu.com/statistics/data-analysis', { timeout: 45000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 6000))
  // 一页 50 条，免去翻页
  await page.evaluate(() => {
    const leaf = txt => [...document.querySelectorAll('li, div, span')].find(e => e.children.length === 0 && (e.textContent || '').trim() === txt)
    leaf('10 条/页')?.click()
  })
  await new Promise(r => setTimeout(r, 1500))
  await page.evaluate(() => {
    const leaf = txt => [...document.querySelectorAll('li, div, span')].find(e => e.children.length === 0 && (e.textContent || '').trim() === txt)
    leaf('50 条/页')?.click()
  })
  await new Promise(r => setTimeout(r, 4000))
  const notes = await page.evaluate(() => {
    const out = []
    for (const tr of document.querySelectorAll('table tbody tr')) {
      const t = (tr.innerText || '').replace(/\s+/g, ' ').trim()
      // 列序：曝光 观看 封面点击率 点赞 评论 收藏 涨粉 分享 …
      const m = /(.+?)发布于(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}\s+([\d,]+)\s+([\d,]+)\s+[\d.]+%\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/.exec(t)
      if (!m) continue
      out.push({ title: m[1].trim().slice(0, 60), date: m[2], exposure: m[3], views: m[4], likes: m[5], comments: m[6], saves: m[7], shares: m[9] })
    }
    const total = Number(/共 (\d+) 条/.exec(document.body.innerText)?.[1]) || 0
    return { total, rows: out }
  })
  if (!notes.rows.length) {
    const text = await page.evaluate(() => document.body.innerText)
    if (isLoginWall(text)) throw new Error('小红书登录失效，需要在 ego 浏览器里重新登录')
    throw new Error('小红书内容分析页没解析到笔记表格（页面结构可能变了）')
  }
  let fresh = 0, delta = 0
  for (const n of notes.rows) {
    const cur = { views: num(n.views), likes: num(n.likes), comments: num(n.comments), saves: num(n.saves), shares: num(n.shares) }
    const key = `xhs:${n.date}:${n.title}:${num(n.exposure)}`
    const prev = cache.notes[key]
    if (!prev) {
      rows.push({ platform: '小红书', date: iso(n.date), ...cur })
      cache.notes[key] = cur
      fresh++
    } else {
      const d = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Math.max(0, v - (prev[k] || 0))]))
      if (Object.values(d).some(v => v > 0)) {
        rows.push({ platform: '小红书', date: iso(RUN_DATE), ...d })
        delta++
      }
      cache.notes[key] = cur
    }
  }
  summary.platforms['小红书'] = { notes: notes.rows.length, of: notes.total, baseline: fresh, increments: delta, partial: notes.rows.length < notes.total || undefined }
}

/** B站：首页「视频数据」的昨日增量（统计截至前一日的单日口径）。 */
async function scrapeBili(page, cache, rows) {
  await page.goto('https://member.bilibili.com/platform/home', { timeout: 45000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 6000))
  const data = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ')
    const cut = /统计截至：(\d{4}-\d{2}-\d{2})/.exec(t)?.[1]
    const seg = t.slice(t.indexOf('视频数据'), t.indexOf('粉丝概览') > 0 ? t.indexOf('粉丝概览') : undefined)
    const grab = label => {
      const m = new RegExp(label + ' ([\\d,]+)').exec(seg)
      return m ? m[1] : null
    }
    return { cut, views: grab('播放量'), comments: grab('评论'), likes: grab('点赞'), shares: grab('分享'), saves: grab('收藏') }
  })
  if (!data.cut || data.views === null || data.likes === null) {
    const text = await page.evaluate(() => document.body.innerText)
    if (isLoginWall(text)) throw new Error('B站登录失效，需要在 ego 浏览器里重新登录')
    throw new Error('B站首页没解析到昨日增量（页面结构可能变了）')
  }
  const key = `bili:${data.cut}`
  if (cache.days[key]) {
    summary.platforms['B站'] = { date: data.cut, skipped: '已写过' }
    return
  }
  rows.push({ platform: 'B站', date: iso(data.cut), views: num(data.views), likes: num(data.likes), comments: num(data.comments), shares: num(data.shares), saves: num(data.saves) })
  cache.days[key] = true
  summary.platforms['B站'] = { date: data.cut, views: num(data.views) }
}

/** 抖音：数据中心-作品数据「昨天」标签页的账号汇总。 */
async function scrapeDouyin(page, cache, rows) {
  await page.goto('https://creator.douyin.com/creator-micro/data-center/operation', { timeout: 60000 }).catch(() => {})
  await page.waitForLoadState('load').catch(() => {})
  await new Promise(r => setTimeout(r, 8000))
  await page.evaluate(() => {
    const hit = [...document.querySelectorAll('div, span, button, a')].find(e => e.children.length === 0 && (e.textContent || '').trim() === '昨天')
    if (hit) hit.click()
  })
  await new Promise(r => setTimeout(r, 4000))
  const data = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ')
    const seg = t.slice(t.indexOf('作品数据'), t.indexOf('粉丝数据') > t.indexOf('作品数据') ? t.indexOf('粉丝数据') : undefined)
    const day = /统计周期：(\d{4}-\d{2}-\d{2})/.exec(seg)?.[1]
    const grab = label => {
      const m = new RegExp(label + ' ([\\d,]+)').exec(seg)
      return m ? m[1] : null
    }
    return { day, views: grab('总播放量'), likes: grab('总点赞量'), comments: grab('总评论量'), shares: grab('总分享量'), saves: grab('总收藏量') }
  })
  if (!data.day || data.views === null) {
    const text = await page.evaluate(() => document.body.innerText)
    if (isLoginWall(text)) throw new Error('抖音登录失效，需要在 ego 浏览器里重新登录')
    throw new Error('抖音数据中心没解析到「昨天」数据（页面结构可能变了）')
  }
  const key = `douyin:${data.day}`
  if (cache.days[key]) {
    summary.platforms['抖音'] = { date: data.day, skipped: '已写过' }
    return
  }
  rows.push({ platform: '抖音', date: iso(data.day), views: num(data.views), likes: num(data.likes), comments: num(data.comments), shares: num(data.shares), saves: num(data.saves) })
  cache.days[key] = true
  summary.platforms['抖音'] = { date: data.day, views: num(data.views) }
}

// ── 主流程 ──
const cache = await readCache()
const rows = []
const task = await taskSpace('creator-center scrape')
const page = task.page('p1')

for (const [name, fn] of [['小红书', scrapeXhs], ['B站', scrapeBili], ['抖音', scrapeDouyin]]) {
  try {
    await fn(page, cache, rows)
  } catch (err) {
    summary.errors.push(`${name}：${err.message}`)
  }
}

if (rows.length) {
  const gui = await task.newPage()
  try {
    await gui.goto(GUI_URL, { timeout: 30000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 4000))
    const write = await gui.evaluate(async (payload) => {
      const r = await fetch('/media-desk/ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-media-desk-lang': 'zh' },
        body: JSON.stringify({ ops: payload.ops, label: payload.label }),
      })
      return { status: r.status, ...(await r.json().catch(() => ({}))) }
    }, { ops: rows.map(r => ({ op: 'add_metric', itemId: null, ...r })), label: `创作中心数据 ${RUN_DATE}` })
    if (write.status !== 200 || write.errors?.length) throw new Error(`写入工作台失败：${JSON.stringify(write).slice(0, 200)}`)
    summary.written = rows.length
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 })
  } finally {
    // 必须 close：release 不关标签，遗留的 DSH 页面长连接会占满同主机 6 条连接，整个 DSH web 卡死
    await gui.close().catch(() => {})
  }
}

console.log('SCRAPE_RESULT ' + JSON.stringify(summary, null, 1))
