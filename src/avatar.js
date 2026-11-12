// Shared by account mutations and browser rendering. Avatars never contain inline bytes.
export const AVATAR_MAX_LENGTH = 4000
export const AVATAR_LOCAL_PATTERN = '^media-desk/(assets|files)/[A-Za-z0-9_-][A-Za-z0-9._-]*\\.([jJ][pP][eE]?[gG]|[pP][nN][gG]|[wW][eE][bB][pP]|[gG][iI][fF])$'
const localImage = new RegExp(AVATAR_LOCAL_PATTERN)

export function normalizeAccountAvatar(value) {
  if (value === null || value === '') return null
  if (typeof value === 'string' && value.length <= AVATAR_MAX_LENGTH) {
    if (localImage.test(value)) return value
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value)
        if (url.hostname && ['http:', 'https:'].includes(url.protocol)) return value
      } catch { /* Invalid URL falls through to the common validation error. */ }
    }
  }
  throw new Error('Avatar must be an HTTP(S) URL or a media-desk image path (maximum 4000 characters).')
}
