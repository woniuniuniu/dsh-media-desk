// 本地模拟模型（OpenAI 兼容流式接口），只用于开发和测试，不消耗真实额度。
// 能应答本项目的八类提示词（见 classify），并模拟生图接口：返回一张内置的 1x1 图片，故意延迟几秒。
// 用法：node scripts/mock-llm.mjs [端口]。每次请求的摘要写到 stdout。
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const SUMMARY = '口吻平实克制，像朋友聊天，先说结论再给一个具体的例子。不用感叹号，不用营销腔，不喊口号。常用表达：说白了、其实、先别急。句子短，一句话只讲一件事，段落之间留白。遇到不确定的事直接说不确定，不装懂。结尾不总结，不号召，停在最有意思的那一句上。禁用词：赋能、颠覆、重磅、干货。这是模拟模型生成的精简版，仅用于沙盒演示，字数固定为二百字。每次回答都一样，方便前后对照，不必逐字细读它，看个大意就好吧，真的。'

const PARA = '这是模拟模型写的一段长文，用来在沙盒里演示整篇稿子的样子。先说结论，再给一个具体的例子，句子很短，一句话只讲一件事。'
const section = n => `## 第${n}部分\n\n${PARA.repeat(9)}\n\n`
const LONGFORM_DRAFT = `${section(1)}${section(2)}${section(3)}我自己的做法是这样：【此处填你的经历】\n\n${PARA.repeat(3)}`
const LONGFORM_REVISED = `${section(1)}${section(2)}这是按你的要求改过的模拟长文，结构更紧，开头直接给结论。\n\n${PARA.repeat(4)}`

/**
 * 按系统提示词里稳定的措辞判断是哪一类请求（措辞来自 src/ai.js、src/voice.js、src/style.js）。
 * @param {string} system - 系统提示词。
 * @returns {'longform_ideas'|'longform_draft'|'longform_revise'|'topics'|'rules'|'condense'|'style'|'revise'|'draft'} 请求类别。
 */
export function classify(system) {
  // 只看第一行：各类提示词的第一行是它独有的任务说明，后面拼接的写作风格是用户内容，可能含任何词
  const head = system.split('\n')[0]
  if (head.includes('长文选题编辑')) return 'longform_ideas'
  if (head.includes('写一篇长文初稿')) return 'longform_draft'
  if (head.includes('改长文稿子')) return 'longform_revise'
  if (head.includes('归并成选题')) return 'topics'
  if (head.includes('写作习惯分析师')) return 'rules'
  if (head.includes('精简版')) return 'condense'
  if (head.includes('文风分析师')) return 'style'
  if (head.includes('改推文草稿')) return 'revise'
  return 'draft'
}

/** 选题：把请求里出现的帖子编号两两一组，最多三个选题。 */
function topicsAnswer(user) {
  const ids = [...new Set([...user.matchAll(/"id":"([^"]+)"/g)].map(m => m[1]))]
  const topics = []
  for (let i = 0; i < ids.length && topics.length < 3; i += 2) {
    topics.push({ title: `模拟选题 ${topics.length + 1}`, postIds: ids.slice(i, i + 2), fun: 2, info: 2, resonance: 1, form: 'post', reason: '模拟模型的理由' })
  }
  return JSON.stringify(topics)
}

/**
 * 生成回答文本。
 * @param {string} system - 系统提示词。
 * @param {string} user - 用户消息。
 * @returns {string} 回答。
 */
export function answer(system, user) {
  const kind = classify(system)
  if (kind === 'longform_ideas') return JSON.stringify([{ title: '模拟长文选题一', angle: '从一个具体的例子切入，讲清楚评测为什么该先写。', typeId: 't_model' }, { title: '模拟长文选题二', angle: '讲讲小模型加好评测集的组合。', typeId: 't_tech' }])
  if (kind === 'longform_draft') return LONGFORM_DRAFT
  if (kind === 'longform_revise') return LONGFORM_REVISED
  if (kind === 'topics') return topicsAnswer(user)
  if (kind === 'rules') return JSON.stringify([{ name: '先说结论', rule: '开头直接给结论，再补一个例子', evidence: '模拟模型：多对里都把结论挪到开头' }])
  if (kind === 'condense') return SUMMARY
  if (kind === 'style') return JSON.stringify({ name: '慢半拍', summary: '不急着下结论，先把场景讲清楚。', tone: '平静、好奇。', sentences: '长短交替，常用逗号断开。', opening: '从一个具体的早晨开始。', structure: '场景、疑问、一个小发现。', words: ['那天', '后来'], avoid: ['感叹号'], samples: ['那天早上我差点迟到，却停在了一块广告牌前。'] })
  if (kind === 'revise') return '这是按你的要求改过的一条模拟推文：先说结论，再补一个具体的例子。'
  return '这是模拟模型写的一条推文草稿：评测做得扎实，比盲目换更大的模型管用得多。'
}

/**
 * 启动模拟服务。
 * @param {number} [port] - 端口，0 表示随机空闲端口。
 * @param {{delay?: number, imageDelay?: number, log?: boolean}} [options] - 流式每块间隔、生图延迟（毫秒）、是否打印日志。
 * @returns {Promise<import('node:http').Server>} 已在监听的服务。
 */
export function startMock(port = 0, { delay = 70, imageDelay = 2500, log = false } = {}) {
  let served = 0
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      if (req.url.endsWith('/models')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (req.url.endsWith('/images/generations')) {
        served += 1
        if (imageDelay) await new Promise(r => setTimeout(r, imageDelay + (served % 5) * 1500))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ b64_json: PIXEL }] }))
        return
      }
      const messages = body.messages ?? []
      const flat = m => (typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join(''))
      const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(flat).join('\n')
      const user = messages.filter(m => m.role === 'user').map(flat).join('\n')
      const text = answer(system, user)
      if (log) console.log(JSON.stringify({ url: req.url, model: body.model, kind: classify(system) }))
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const base = { id: 'mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
      const send = choice => res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`)
      send({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null })
      for (let i = 0; i < text.length; i += 12) {
        send({ index: 0, delta: { content: text.slice(i, i + 12) }, finish_reason: null })
        if (delay) await new Promise(r => setTimeout(r, delay))
      }
      send({ index: 0, delta: {}, finish_reason: 'stop' })
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/**
 * 测试用客户端：向模拟服务发一次流式请求，把增量文本拼成完整回答。
 * @param {number} port - 端口。
 * @param {{system: string, user: string}} prompts - 提示词。
 * @returns {Promise<{text: string, model: string}>} 回答。
 */
export async function readCompletion(port, { system, user }) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  })
  let text = ''
  for (const line of (await res.text()).split('\n')) {
    if (line.startsWith('data: ') && !line.includes('[DONE]')) text += JSON.parse(line.slice(6)).choices[0]?.delta?.content ?? ''
  }
  return { text, model: 'mock-model' }
}

/** 关闭服务并等它真正停下（先断开保持中的连接）。 */
export async function stopMock(server) {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 4399)
  await startMock(port, { log: true })
  console.log(`mock llm on ${port}`)
}
