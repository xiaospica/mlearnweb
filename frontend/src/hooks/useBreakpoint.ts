/**
 * AlphaPilot 响应式断点 hooks
 *
 * 复用 AntD `Grid.useBreakpoint()`，与 src/theme/breakpoints.ts 的 BP 阶梯
 * 同源（xs<576 / sm<768 / md<992 / lg<1200 / xl<1600 / xxl≥1600）。
 *
 * 使用规则（plan F3 决策）：
 * - 这些 hook 只用于决定**布局/结构选择**：sidebar 折叠、卡片 vs 表格、
 *   Drawer 触发、Modal 全屏化等。
 * - **纯样式差异**（padding / fontSize / gap）走 CSS 变量 + global.css 的
 *   @media 阶梯，不要走 hook 触发 re-render。
 *
 * 例：
 *   const isMobile = useIsMobile()
 *   if (isMobile) return <CardList ... />
 *   return <Table ... />
 */

import { Grid } from 'antd'
import type { Breakpoint } from 'antd/es/_util/responsiveObserver'

/** 完整断点 map：{ xs: bool, sm: bool, md: bool, lg: bool, xl: bool, xxl: bool } */
export const useBp = (): Partial<Record<Breakpoint, boolean>> => Grid.useBreakpoint()

/** 视口宽度 < md (768px)：典型手机竖屏 */
export const useIsMobile = (): boolean => {
  const screens = Grid.useBreakpoint()
  return !screens.md
}

/** 视口宽度 < lg (992px)：手机 + 小尺寸平板 */
export const useIsCompact = (): boolean => {
  const screens = Grid.useBreakpoint()
  return !screens.lg
}

/** 视口宽度 ≥ xl (1200px)：宽桌面，可启用更密集布局 */
export const useIsWide = (): boolean => {
  const screens = Grid.useBreakpoint()
  return !!screens.xl
}

/**
 * 当前激活的最高断点 key（'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl'）。
 * 用于查表场景，例如根据断点查响应式高度 / 列数 map。
 */
export const useActiveBp = (): Breakpoint => {
  const s = Grid.useBreakpoint()
  if (s.xxl) return 'xxl'
  if (s.xl) return 'xl'
  if (s.lg) return 'lg'
  if (s.md) return 'md'
  if (s.sm) return 'sm'
  return 'xs'
}
