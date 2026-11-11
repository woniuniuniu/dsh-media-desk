import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const isCode = (e, code) => e && e.code === code

// 单进程锁：用一个带心跳时间的文件，保证只有一个宿主进程跑后台处理。
// 所有"抢"的动作都靠文件系统的原子操作（独占创建、改名）完成，不靠"先读再写"。
// hooks.afterStaleRead 仅供测试在"读到过期锁"与"接管"之间插入动作。
export class Lock {
  constructor(file, { ttlMs = 180000, now = Date.now, pid = process.pid, hooks = {} } = {}) {
    this.file = file
    this.ttlMs = ttlMs
    this.now = now
    this.pid = pid
    this.hooks = hooks
  }

  // 返回 undefined=文件不存在；null=读不出来或内容不合格（视为没有有效锁）；否则 {pid, at}
  async #read(path = this.file) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (e) {
      return isCode(e, 'ENOENT') ? undefined : null
    }
    try {
      const v = JSON.parse(text)
      if (v && Number.isFinite(v.pid) && Number.isFinite(v.at)) return v
    } catch {}
    return null
  }

  // 心跳在 ttl 内，且不是比现在晚 ttl 以上的未来时间
  #fresh(v) {
    const t = this.now()
    return v.at >= t - this.ttlMs && v.at <= t + this.ttlMs
  }

  #data() {
    return JSON.stringify({ pid: this.pid, at: this.now() })
  }

  // 独占创建：先写完整的临时文件，再用硬链接放到位（已存在则失败），别人不会读到写了一半的锁
  async #create() {
    const tmp = `${this.file}.${this.pid}.tmp`
    try {
      await writeFile(tmp, this.#data())
      await link(tmp, this.file)
      return true
    } catch (e) {
      if (isCode(e, 'EEXIST')) return false
      throw e
    } finally {
      await rm(tmp, { force: true })
    }
  }

  // 只有锁的主人才会续期
  async #renew() {
    const tmp = `${this.file}.${this.pid}.tmp`
    try {
      await writeFile(tmp, this.#data())
      await rename(tmp, this.file)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
    return true
  }

  // 把取走的锁放回去；原位置已经有新锁就丢掉取走的副本
  async #putBack(moved) {
    try {
      await link(moved, this.file)
    } catch (e) {
      if (!isCode(e, 'EEXIST')) throw e
    }
    await rm(moved, { force: true })
  }

  async acquire() {
    await mkdir(dirname(this.file), { recursive: true })
    const cur = await this.#read()
    if (cur === undefined) return this.#create()
    if (cur && cur.pid === this.pid) return this.#renew()
    if (cur && this.#fresh(cur)) return false

    // 过期或损坏：改名取走，同一时刻只有一个竞争者能改名成功
    await this.hooks.afterStaleRead?.()
    const moved = `${this.file}.stale.${this.pid}`
    try {
      await rename(this.file, moved)
    } catch (e) {
      if (isCode(e, 'ENOENT')) return false
      throw e
    }
    const got = await this.#read(moved)
    if (got && got.pid !== this.pid && this.#fresh(got)) {
      // 取走的瞬间主人刚好续了期，还回去
      await this.#putBack(moved)
      return false
    }
    await rm(moved, { force: true })
    return this.#create()
  }

  async release() {
    const moved = `${this.file}.release.${this.pid}`
    try {
      await rename(this.file, moved)
    } catch (e) {
      if (isCode(e, 'ENOENT')) return
      throw e
    }
    const got = await this.#read(moved)
    if (got && got.pid === this.pid) await rm(moved, { force: true })
    else await this.#putBack(moved)
  }
}
