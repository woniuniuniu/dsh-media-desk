// 界面只有中文：tr 只做占位符替换。

/**
 * 给用户看的文字。zh 是中文原文，{name} 是占位符。
 * @param {string} zh - 中文原文。
 * @param {Record<string, unknown>} [vars] - 占位符的值。
 * @returns {string} 替换后的文字。
 */
export function tr(zh, vars) {
  return vars ? zh.replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? match : String(vars[key]))) : zh
}
