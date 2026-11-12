import { execFile } from 'node:child_process'
import { access, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const DIRS = ['posts', 'decisions', 'drafts', 'voice', 'replies', 'mine']
const COMMANDS = new Set(['rev-parse', 'status', 'add', 'commit', 'fetch', 'merge', 'push', 'remote', 'ls-files', 'log', 'diff', 'config'])
const GLOBAL_ARGS = ['-c', 'user.name=x-desk', '-c', 'user.email=x-desk@localhost', '-c', 'core.quotepath=false']

function defaultRun(argv, { cwd, env, timeout }) {
  return new Promise(resolve => {
    execFile('git', argv, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err
        ? { code: err.code === 'ENOENT' ? 127 : (typeof err.code === 'number' && err.code !== 0 ? err.code : -1), stdout: '', stderr: stderr || err.message }
        : { code: 0, stdout, stderr })
    })
  })
}

export class Sync {
  constructor({ dir, projectDir, run = defaultRun, now = Date.now }) {
    this.dir = dir
    this.projectDir = projectDir
    this.run = run
    this.now = now
    this.running = false
  }

  static checkArgs(args) {
    if (!Array.isArray(args) || !COMMANDS.has(args[0]) ||
        args.some(arg => typeof arg !== 'string' || ['reset', 'rebase', 'clean', 'checkout', '-f', '-c'].includes(arg) || arg.startsWith('--force')) ||
        (args[0] === 'config' && (args.length !== 3 || args[1] !== '--get')) ||
        (args[0] === 'push' && !(args.length === 1 || (args.length === 2 && args[1] === '--porcelain')))) {
      throw new Error('不允许的 git 命令')
    }
  }

  #git(args) {
    Sync.checkArgs(args)
    return this.run([...GLOBAL_ARGS, ...args], {
      cwd: this.dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0' },
      timeout: 60000,
    })
  }

  async #counts() {
    const result = await this.#git(['status', '--porcelain=v2', '--branch'])
    if (result.code !== 0) throw new Error(result.stderr)
    const match = result.stdout.match(/^# branch\.ab \+(\d+) -(\d+)$/m)
    return { ahead: Number(match?.[1] ?? 0), behind: Number(match?.[2] ?? 0) }
  }

  async status() {
    const refused = reason => ({ ok: false, reason, branch: null, ahead: 0, behind: 0 })
    let dir
    try { dir = await realpath(this.dir) } catch { return refused('交换文件夹还不存在') }
    const rel = relative(await realpath(this.projectDir), dir)
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      return refused('交换文件夹在代码仓库里面，不能同步')
    }
    const top = await this.#git(['rev-parse', '--show-toplevel'])
    if (top.code === 127) return refused('没有安装 git')
    if (top.code !== 0) return refused('交换文件夹还不是一个 git 仓库')
    if (await realpath(top.stdout.trim()) !== dir) return refused('交换文件夹不是一个独立的 git 仓库')
    const remote = await this.#git(['remote'])
    if (remote.code !== 0 || !remote.stdout.trim()) return refused('这个仓库没有配置远端')
    const branch = await this.#git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch.code !== 0) return refused('当前分支没有上游分支')
    const upstream = await this.#git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    if (upstream.code !== 0) return refused('当前分支没有上游分支')
    try {
      return { ok: true, reason: null, branch: branch.stdout.trim(), ...await this.#counts() }
    } catch (err) { return refused(err.message.slice(0, 200)) }
  }

  async syncOnce() {
    let pulled = 0, pushed = 0
    const failed = error => ({ ok: false, pulled, pushed, error: String(error).slice(0, 200) })
    if (this.running) return failed('上一轮同步还没结束')
    this.running = true
    try {
      const status = await this.status()
      if (!status.ok) return failed(status.reason)
      const paths = []
      for (const dir of DIRS) {
        try { await access(join(this.dir, dir)); paths.push(dir) } catch (err) { if (err.code !== 'ENOENT') throw err }
      }
      try {
        await writeFile(join(this.dir, '.gitignore'), '.seen-*.json\n*.tmp\n', { flag: 'wx' })
        paths.push('.gitignore')
      } catch (err) { if (err.code !== 'EEXIST') throw err }
      if (paths.length) {
        const added = await this.#git(['add', '-A', '--', ...paths])
        if (added.code !== 0) return failed(`暂存失败：${added.stderr}`)
      }
      const diff = await this.#git(['diff', '--cached', '--quiet'])
      if (diff.code !== 0) {
        const committed = await this.#git(['commit', '-m', `x-desk sync ${new Date(this.now()).toISOString()}`])
        if (committed.code !== 0) return failed(`提交失败：${committed.stderr}`)
      }
      const fetched = await this.#git(['fetch'])
      if (fetched.code !== 0) return failed(`拉取失败：${fetched.stderr}`)
      const { behind } = await this.#counts()
      if (behind > 0) {
        const merged = await this.#git(['merge', '--no-edit', '-X', 'ours', '@{u}'])
        if (merged.code !== 0) {
          await this.#git(['merge', '--abort'])
          return failed(`和远端合并失败：${merged.stderr}`)
        }
        const changed = await this.#git(['diff', '--name-only', 'HEAD@{1}', 'HEAD', '--', ...DIRS])
        if (changed.code !== 0) return failed(changed.stderr)
        pulled = changed.stdout.split('\n').filter(Boolean).length
      }
      const { ahead } = await this.#counts()
      if (ahead > 0) {
        const sent = await this.#git(['push', '--porcelain'])
        if (sent.code !== 0) return failed(`推送失败：${sent.stderr}`)
        pushed = ahead
      }
      return { ok: true, pulled, pushed, error: null }
    } catch (err) { return failed(err.message) } finally { this.running = false }
  }
}
