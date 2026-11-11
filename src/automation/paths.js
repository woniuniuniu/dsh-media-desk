import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
export function automationDirectory(storeRoot, profile = 'desktop') {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(profile)) throw new Error('Invalid profile name.')
  return join(storeRoot, 'automation', ...(profile === 'desktop' ? [] : ['profiles', profile]))
}
export function automationPaths({ home = process.env.DSH_HOME || join(homedir(), '.dsh'), profile = 'desktop' } = {}) {
  const dir = automationDirectory(join(resolve(home), 'media-desk'), profile)
  return { dir, lock: join(dir, 'owner.lock'), token: join(dir, 'token'), socket: join(dir, 'rpc.sock') }
}

export function hostProfile(env = process.env) { return env.DSH_PROFILE || (env.DSH_PROFILE_DIR ? basename(env.DSH_PROFILE_DIR) : 'desktop') }
