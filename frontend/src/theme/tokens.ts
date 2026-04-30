/**
 * AlphaPilot 设计 token 单一事实源
 *
 * 所有颜色/间距/层级/排版常量在这里定义，AntD theme + CSS 变量都从此派生。
 * 永远不要在组件内部硬编码 px / hex —— 通过 token 或 CSS var 引用。
 */

/** 间距阶梯（4px 基线，覆盖 0/4/8/12/16/24/32/48/64）。索引即语义。*/
export const SPACE = [0, 4, 8, 12, 16, 24, 32, 48, 64] as const
export type SpaceIdx = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

/** 布局区域尺寸（与 sidebar / topbar / drawer / 内容容器协同）*/
export const ZONE = {
  headerH: 56,
  sidebarW: 224,
  sidebarCollapsedW: 56,
  drawerW: 280,
  /** 仅在 xl/xxl 生效，更小尺寸下走 100% */
  contentMaxWXl: 1400,
  contentMaxWXxl: 1600,
} as const

/** 字号 */
export const FS = {
  xs: 11,
  sm: 12,
  base: 14,
  md: 15,
  lg: 16,
  xl: 18,
  xxl: 22,
  display: 28,
} as const

/** 圆角 */
export const RADIUS = {
  sm: 6,
  base: 8,
  lg: 12,
  xl: 16,
  pill: 999,
} as const

/** Z-index 层级（避免硬编码冲突）*/
export const Z = {
  base: 1,
  dropdown: 100,
  sidebar: 900,
  header: 1000,
  drawer: 1100,
  modal: 1200,
  message: 1300,
  popover: 1400,
  tooltip: 1500,
} as const

/** 语义色板：每个主题一份。token 名是抽象语义（bg/panel/border/...），不是具体色名 */
export interface Palette {
  /** 整体背景（最底层） */
  bg: string
  /** 提升的面板背景（card / sidebar / topbar） */
  panel: string
  /** 二级提升（弹层 / drawer） */
  panelElevated: string
  /** 次级背景（hover / active 强调） */
  panelMuted: string
  /** 边框 */
  border: string
  /** 次要边框（更淡） */
  borderMuted: string
  /** 主文本 */
  text: string
  /** 次要文本 */
  textMuted: string
  /** 三级文本 / placeholder */
  textDim: string
  /** 品牌主色 */
  brandPrimary: string
  /** 品牌主色 hover */
  brandPrimaryHover: string
  /** 渐变起色（用于强调卡） */
  brandGradientStart: string
  /** 渐变止色 */
  brandGradientEnd: string
  /** 状态色 */
  success: string
  warning: string
  danger: string
  info: string
  /** A 股交易语义色 — 涨红跌绿（中国市场惯例） */
  marketUp: string
  marketDown: string
  /** 高亮强调（如 KPI 卡左缘 accent） */
  accent: string
  /** 阴影（rgba） */
  shadow: string
  shadowLg: string
}

export const PALETTE_DARK: Palette = {
  // 中性纯黑色板（对位 QuantDinger 截图）— 无蓝调
  // bg 与 panel 的亮度差 ~16 单位，确保卡片在页面上清晰浮起
  bg: '#0A0A0A',
  panel: '#1A1A1A',
  panelElevated: '#222222',
  panelMuted: '#202020',
  border: '#2A2A2A',
  borderMuted: '#222222',
  text: '#F5F5F5',
  textMuted: '#999999',
  textDim: '#666666',
  brandPrimary: '#3B82F6',
  brandPrimaryHover: '#60A5FA',
  brandGradientStart: '#6366F1',
  brandGradientEnd: '#8B5CF6',
  success: '#22C55E',
  warning: '#F59E0B',
  danger: '#EF4444',
  info: '#3B82F6',
  marketUp: '#EF4444',
  marketDown: '#22C55E',
  accent: '#A855F7',
  shadow: 'rgba(0, 0, 0, 0.5)',
  shadowLg: 'rgba(0, 0, 0, 0.65)',
}

export const PALETTE_LIGHT: Palette = {
  bg: '#F5F7FA',
  panel: '#FFFFFF',
  panelElevated: '#FFFFFF',
  panelMuted: '#F0F2F7',
  border: '#E5E7EB',
  borderMuted: '#EEF0F4',
  text: '#1F2937',
  textMuted: '#6B7280',
  textDim: '#9CA3AF',
  brandPrimary: '#1677FF',
  brandPrimaryHover: '#3F8EFE',
  brandGradientStart: '#1677FF',
  brandGradientEnd: '#7C3AED',
  success: '#16A34A',
  warning: '#D97706',
  danger: '#DC2626',
  info: '#2563EB',
  marketUp: '#DC2626',
  marketDown: '#16A34A',
  accent: '#7C3AED',
  shadow: 'rgba(15, 23, 42, 0.08)',
  shadowLg: 'rgba(15, 23, 42, 0.16)',
}

export type ThemeMode = 'dark' | 'light'

export const PALETTES: Record<ThemeMode, Palette> = {
  dark: PALETTE_DARK,
  light: PALETTE_LIGHT,
}

/** 共享字体栈 */
export const FONT_FAMILY =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
export const FONT_FAMILY_MONO =
  "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace"
