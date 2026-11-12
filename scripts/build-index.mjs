// 生成 index.json：插件市场索引，地址是
// https://raw.githubusercontent.com/woniuniuniu/dsh-media-desk/main/index.json
//
// 展示文案沿用 index.json 里已经写好的部分，只把列出的版本和发布时间换成 npm 上的最新发布。
// 写文件前用 DSH 自己的校验器过一遍：不合规就报错退出，不让坏索引发出去。
// `npm publish` 之后跑一次：
//
//   npm run index
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { latestMarketVersion, reconcileDistTags } from './index-entry.mjs'

const INDEX_URL = 'https://raw.githubusercontent.com/woniuniuniu/dsh-media-desk/main/index.json'
const root = new URL('..', import.meta.url)
const indexPath = new URL('index.json', root)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const index = JSON.parse(readFileSync(indexPath, 'utf8'))

const plugin = index.plugins?.find(entry => entry.name === manifest.name)
if (!plugin) throw new Error(`index.json 里没有名为 ${manifest.name} 的插件`)

// 要完整文档：分发包的简版元数据里没有发布时间（time）。
const response = await fetch(`https://registry.npmjs.org/${manifest.name}`, {
  headers: { accept: 'application/json' },
})
if (!response.ok) throw new Error(`npm registry 返回 ${response.status}：${manifest.name}`)
const registry = await response.json()

plugin.versions = [latestMarketVersion(registry)]
reconcileDistTags(plugin, plugin.versions)

// 官方校验器是格式的唯一判据：分类、图标、区间、时间戳任何一项不合规都会在这里抛错。
parseMarketIndex(index, INDEX_URL)

// 先写临时文件再改名：中途出错也不会留下写了一半的 index.json 被市场读到。
const temporary = new URL('index.json.tmp', root)
writeFileSync(temporary, JSON.stringify(index, null, 2) + '\n')
renameSync(temporary, indexPath)

console.log(`index.json：${manifest.name}@${plugin.versions[0].version}，发布戳 ${plugin.versions[0].publishTimestamp}`)
