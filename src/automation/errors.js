export function failure(code, message, details, requestId) {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) }, ...(requestId ? { requestId } : {}) }
}
export function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }) }
