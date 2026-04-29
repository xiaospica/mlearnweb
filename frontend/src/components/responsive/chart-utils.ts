/**
 * AlphaPilot 图表辅助工具
 *
 * 复用 ChartContainer 与未来其它图表包装组件。仅放纯逻辑，不放 React 组件。
 */

import type { Breakpoint } from 'antd/es/_util/responsiveObserver'

/** 图表高度规格：单值或按断点（xs/sm/md/lg）声明 */
export type ChartHeightSpec = number | Partial<Record<'xs' | 'sm' | 'md' | 'lg', number>>

/** ChartContainer 默认高度（小屏紧凑、桌面充裕） */
export const DEFAULT_CHART_HEIGHTS = {
  xs: 220,
  sm: 240,
  md: 280,
  lg: 320,
} as const

/**
 * 将 ChartHeightSpec + 当前断点解析为像素值。
 * - number：直接返回
 * - 对象：合并默认值后按当前断点查表（xl/xxl 归并到 lg）
 */
export const resolveChartHeight = (
  h: ChartHeightSpec | undefined,
  bp: Breakpoint,
): number => {
  if (typeof h === 'number') return h
  const merged: Record<string, number> = { ...DEFAULT_CHART_HEIGHTS, ...(h ?? {}) }
  const lookup = bp === 'xl' || bp === 'xxl' ? 'lg' : bp
  return merged[lookup] ?? DEFAULT_CHART_HEIGHTS.xs
}

/**
 * 在元素上绑定 ResizeObserver，容器尺寸变化时调用 cb。
 * 返回清理函数，调用即停止监听。
 *
 * 用途：Tab 切换 / Drawer 开合 / Sidebar 折叠等场景，window 尺寸不变但
 * 容器尺寸变了，window.resize 监听漏掉，需要 RO 兜底。
 */
export const observeResize = (
  el: Element,
  cb: () => void,
): (() => void) => {
  if (typeof ResizeObserver === 'undefined') {
    // 老浏览器降级：不监听（极少见）
    return () => {}
  }
  const ro = new ResizeObserver(() => cb())
  ro.observe(el)
  return () => ro.disconnect()
}
