import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// 单进程锁：用一个带心跳时间的文件，保证只有一个宿主进程跑后台处理。
export class Lock {
  constructor(file, { ttlMs = 180000, now = Date.now, pid = process.pid } = {}) {
    this.file = file
    this.ttlMs = ttlMs
    this.now = now
    this.pid = pid
  }

  // 读不出来、不是 JSON、字段不对，都当作没有锁
  async #read() {
    try {
      const v = JSON.parse(await readFile(this.file, 'utf8'))
      if (v && Number.isFinite(v.pid) && Number.isFinite(v.at)) return v
    } catch {}
    return null
  }

  async acquire() {
    const cur = await this.#read()
    if (cur && cur.pid !== this.pid && cur.at >= this.now() - this.ttlMs) return false
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${this.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ pid: this.pid, at: this.now() }))
    await rename(tmp, this.file)
    return (await this.#read())?.pid === this.pid
  }

  async release() {
    if ((await this.#read())?.pid === this.pid) await rm(this.file, { force: true })
  }
}
