// Gemini 官方接口没有 OpenAI 的 /images/generations，生图请求改走原生 generateContent。
import assert from 'node:assert/strict'
import test from 'node:test'
import { generateImage } from '../src/images.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const KEY = 'secret-key-1234'
const GEMINI = { source: 'http', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3-pro-image', apiKey: KEY, size: '1536x1024', quality: '', extra: '' }
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent'

const imageReply = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] }))
const errorReply = (status, message) => new Response(JSON.stringify({ error: { code: status, message, status: 'FAILED_PRECONDITION' } }), { status })

test('Gemini 地址走原生 generateContent，从 inlineData 取图', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push([String(url), init])
    return imageReply()
  }
  const one = await generateImage(GEMINI, 'a paper boat', { fetchImpl })
  assert.equal(one.ext, '.png')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], ENDPOINT)
  assert.equal(calls[0][1].headers['x-goog-api-key'], KEY)
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    contents: [{ parts: [{ text: 'a paper boat' }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:2' } },
  })
})

test('Gemini 地址归一：域名、/v1beta、/v1beta/openai 和整条模型地址都对得上', async () => {
  for (const baseUrl of [
    'https://generativelanguage.googleapis.com',
    'https://generativelanguage.googleapis.com/',
    'https://generativelanguage.googleapis.com/v1beta',
    'https://generativelanguage.googleapis.com/v1beta/openai',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash',
  ]) {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(String(url))
      return imageReply()
    }
    await generateImage({ ...GEMINI, baseUrl }, 'p', { fetchImpl })
    assert.equal(calls[0], ENDPOINT, baseUrl)
  }

  const prefixed = []
  await generateImage({ ...GEMINI, model: 'models/gemini-3-pro-image' }, 'p', {
    fetchImpl: async (url) => {
      prefixed.push(String(url))
      return imageReply()
    },
  })
  assert.equal(prefixed[0], ENDPOINT)
})

test('Gemini 尺寸换算成画幅比例，extra 里的 aspectRatio 优先', async () => {
  const ratios = []
  const fetchImpl = async (url, init) => {
    ratios.push(JSON.parse(init.body).generationConfig.imageConfig?.aspectRatio)
    return imageReply()
  }
  for (const size of ['1024x1024', '1536x1024', '1024x1536', '2048x872', '']) {
    await generateImage({ ...GEMINI, size }, 'p', { fetchImpl })
  }
  assert.deepEqual(ratios.slice(0, 4), ['1:1', '3:2', '2:3', '21:9'])
  assert.equal(ratios[4], undefined)

  await generateImage({ ...GEMINI, extra: '{"aspectRatio":"16:9"}' }, 'p', { fetchImpl })
  assert.equal(ratios.at(-1), '16:9')
})

test('Gemini 报错带上官方说明，且不泄露密钥', async () => {
  const retired = async () => errorReply(404, 'This model is no longer available to new users. Update to models/gemini-3.8-flash. key secret-key-1234')
  await assert.rejects(generateImage(GEMINI, 'p', { fetchImpl: retired }), err => /接口地址或模型不对（404）/.test(err.message) && /gemini-3\.8-flash/.test(err.message) && !err.message.includes('secret-key') && err.message.includes('***'))

  const denied = async () => errorReply(401, 'API key not valid')
  await assert.rejects(generateImage(GEMINI, 'p', { fetchImpl: denied }), /密钥无效/)

  const blocked = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'I cannot help with that.' }] }, finishReason: 'SAFETY' }] }))
  await assert.rejects(generateImage(GEMINI, 'p', { fetchImpl: blocked }), /没有返回图片/)
})

test('Gemini 遇到 5xx 重试一次', async () => {
  let n = 0
  const flaky = async () => {
    n += 1
    return n === 1 ? errorReply(502, 'backend error') : imageReply()
  }
  assert.equal((await generateImage(GEMINI, 'p', { fetchImpl: flaky })).ext, '.png')
  assert.equal(n, 2)
})

test('非 Gemini 地址仍走 OpenAI Images 接口', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  }
  await generateImage({ ...GEMINI, baseUrl: 'https://img.example/v1' }, 'p', { fetchImpl })
  assert.equal(calls[0], 'https://img.example/v1/images/generations')
})
