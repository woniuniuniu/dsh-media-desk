import { execFile } from 'node:child_process'
import { lstat, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const DIRS = ['posts', 'decisions', 'drafts', 'voice', 'replies', 'mine']
const COMMANDS = new Set(['rev-parse', 'status', 'add', 'commit', 'fetch', 'merge', 'push', 'remote', 'diff'])
const GLOBAL_ARGS = ['-c', 'user.name=x-desk', '-c', 'user.email=x-desk@localhost', '-c', 'core.quotepath=false',
  '-c', 'core.symlinks=false', '-c', 'push.default=upstream',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'protocol.ext.allow=never']

function defaultRun(argv, { cwd, env, timeout }) {
  return new Promise(resolve => {
    execFile('git', argv, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err
        ? { code: err.code === 'ENOENT' ? 127 : (typeof err.code === 'number' && err.code !== 0 ? err.code : -1), stdout: err.stdout ?? stdout, stderr: err.stderr ?? stderr, killed: err.killed, signal: err.signal }
        : { code: 0, stdout, stderr })
    })
  })
}

const safeText = text => String(text).replace(/(\/\/)[^\s\/]+@/g, '$1***@')
const failureText = result => result.killed || result.signal === 'SIGTERM' ? '超过 60 秒没有完成'
  : safeText(result.stderr?.trim() || result.stdout?.split('\n').filter(line => line.trim()).slice(-3).join('\n') || `git 退出码 ${result.code}`)

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
        (args[0] === 'push' && !(args.length === 1 || (args.length === 2 && args[1] === '--porcelain')))) {
      throw new Error('不允许的 git 命令')
    }
  }

  #git(args) {
    Sync.checkArgs(args)
    return this.run([...GLOBAL_ARGS, ...args], {
      cwd: this.dir,
      env: { PATH: [...new Set([...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(':'), HOME: process.env.HOME,
        ...Object.fromEntries(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']
          .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
        ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
        GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      timeout: 60000,
    })
  }

  async #counts() {
    const result = await this.#git(['status', '--porcelain=v2', '--branch'])
    if (result.code !== 0) throw new Error(failureText(result))
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
    const gitDirs = await this.#git(['rev-parse', '--absolute-git-dir', '--git-common-dir'])
    try {
      const paths = gitDirs.stdout.trim().split('\n')
      if (gitDirs.code !== 0 || paths.length !== 2 ||
          (await Promise.all(paths.map(path => realpath(resolve(dir, path))))).some(path => path !== join(dir, '.git'))) {
        return refused('交换文件夹不是一个独立的 git 仓库')
      }
    } catch { return refused('交换文件夹不是一个独立的 git 仓库') }
    const remote = await this.#git(['remote'])
    if (remote.code !== 0 || !remote.stdout.trim()) return refused('这个仓库没有配置远端')
    const branch = await this.#git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch.code !== 0) return refused('当前分支没有上游分支')
    const upstream = await this.#git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    if (upstream.code !== 0) return refused('当前分支没有上游分支')
    try {
      const head = await this.#git(['rev-parse', '--verify', 'HEAD'])
      if (head.code === 0) {
        const foreign = await this.#git(['diff', '--name-only', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'HEAD', '--', '.',
          ...[...DIRS, 'README.md', '.gitignore', '.gitattributes', 'LICENSE'].map(path => `:(exclude)${path}`)])
        if (foreign.code !== 0) return refused(failureText(foreign))
        if (foreign.stdout.trim()) return refused('这个仓库里还有交换文件以外的内容，不能当作交换文件夹')
      }
      return { ok: true, reason: null, branch: branch.stdout.trim(), ...await this.#counts() }
    } catch (err) { return refused(safeText(err.message).slice(0, 200)) }
  }

  async #directories() {
    const paths = []
    for (const dir of DIRS) {
      try {
        if (!(await lstat(join(this.dir, dir))).isDirectory()) throw new Error(`交换文件夹里的 ${dir} 不是普通文件夹，已停止同步，请检查仓库`)
        paths.push(dir)
      } catch (err) { if (err.code !== 'ENOENT') throw err }
    }
    return paths
  }

  async syncOnce() {
    let pulled = 0, pushed = 0
    let voiceChanged = false
    const failed = error => ({ ok: false, pulled, pushed, voiceChanged, error: safeText(error).slice(0, 200) })
    if (this.running) return failed('上一轮同步还没结束')
    this.running = true
    try {
      const status = await this.status()
      if (!status.ok) return failed(status.reason)
      const directories = await this.#directories()
      const paths = []
      try {
        await writeFile(join(this.dir, '.gitignore'), '.seen-*.json\n*.tmp\n', { flag: 'wx' })
        paths.push('.gitignore')
      } catch (err) { if (err.code !== 'EEXIST') throw err }
      // commit 的路径不能含空目录或仅有忽略文件的目录；三步共用有改动的目录。
      for (const dir of directories) {
        const changed = await this.#git(['status', '--porcelain', '--untracked-files=all', '--', dir])
        if (changed.code !== 0) return failed(failureText(changed))
        if (changed.stdout.trim()) paths.push(dir)
      }
      if (paths.length) {
        const added = await this.#git(['add', '-A', '--', ...paths])
        if (added.code !== 0) return failed(`暂存失败：${failureText(added)}`)
        const diff = await this.#git(['diff', '--cached', '--quiet', '--', ...paths])
        if (diff.code !== 0 && diff.code !== 1) return failed(failureText(diff))
        if (diff.code === 1) {
          const committed = await this.#git(['commit', '-m', `x-desk sync ${new Date(this.now()).toISOString()}`, '--', ...paths])
          if (committed.code !== 0) return failed(`提交失败：${failureText(committed)}`)
        }
      }
      const fetched = await this.#git(['fetch'])
      if (fetched.code !== 0) return failed(`拉取失败：${failureText(fetched)}`)
      const { behind } = await this.#counts()
      if (behind > 0) {
        const protectedFiles = await this.#git(['diff', '--name-only', 'HEAD...@{u}', '--', '.gitignore', '.gitattributes', ':(glob).seen-*.json',
          ':(glob)**/.gitignore', ':(glob)**/.gitattributes', ':(glob)**/.seen-*.json'])
        if (protectedFiles.code !== 0) return failed(failureText(protectedFiles))
        const names = protectedFiles.stdout.split('\n').filter(Boolean)
        if (names.length) return failed(`远端改动了不该改的文件（${names.slice(0, 3).join('、')}），已停止同步`)
        const merged = await this.#git(['merge', '--no-edit', '-X', 'ours', '@{u}'])
        if (merged.code !== 0) {
          await this.#git(['merge', '--abort'])
          return failed(`和远端合并失败：${failureText(merged)}`)
        }
        await this.#directories()
        const changed = await this.#git(['diff', '--name-only', 'HEAD@{1}', 'HEAD', '--', ...DIRS])
        if (changed.code !== 0) return failed(failureText(changed))
        const files = changed.stdout.split('\n').filter(Boolean)
        pulled = files.length
        voiceChanged = files.some(file => file.startsWith('voice/'))
      }
      const { ahead } = await this.#counts()
      if (ahead > 0) {
        const sent = await this.#git(['push', '--porcelain'])
        if (sent.code !== 0) return failed(`推送失败：${failureText(sent)}`)
        pushed = ahead
      }
      return { ok: true, pulled, pushed, voiceChanged, error: null }
    } catch (err) { return failed(err.message) } finally { this.running = false }
  }
}
