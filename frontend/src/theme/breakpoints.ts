/**
 * AlphaPilot 断点系统
 * 沿用 AntD Grid 的标准断点 (Bootstrap 5 兼容)，作为整个设计系统的单一事实源。
 * TS / JS 直接读 BP；纯 CSS 走 global.css 里的 :root --bp-* 变量。
 */

export const BP = {
  xs: 0,
  sm: 576,
  md: 768,
  lg: 992,
  xl: 1200,
  xxl: 1600,
} as const

export type BPKey = keyof typeof BP

/** 媒体查询字符串生成器（不带 @media 前缀，直接拼到 styled / template literal 中）*/
export const mq = {
  up: (k: BPKey) => `(min-width: ${BP[k]}px)`,
  down: (k: BPKey) => `(max-width: ${BP[k] - 0.02}px)`,
  between: (lo: BPKey, hi: BPKey) =>
    `(min-width: ${BP[lo]}px) and (max-width: ${BP[hi] - 0.02}px)`,
}
