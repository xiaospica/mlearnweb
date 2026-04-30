/**
 * AlphaPilot 图表辅助工具
 *
 * 复用 ChartContainer 与未来其它图表包装组件。仅放纯逻辑，不放 React 组件。
 */

import type { Breakpoint } from 'antd/es/_util/responsiveObserver'
import type { EChartsOption } from 'echarts'
import { PALETTE_DARK, PALETTE_LIGHT } from '@/theme/tokens'
import type { ThemeMode } from '@/theme/tokens'

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

/**
 * 给 ECharts option 注入主题敏感的 chrome 默认色（tooltip / axis / legend / split-line / grid）。
 *
 * 设计原则：
 * - 仅设置 chrome（图表外框/轴/图例/工具提示），不动 series（数据色保留 chart 自定义）
 * - chart-specific 的 chrome 覆盖仍然生效（spread 顺序：默认在前、option 在后）
 *   *例外* tooltip.backgroundColor 等明显面向浅色主题的写死值（#fff），
 *   暗色下我们刻意覆盖为 panel 色，否则白底 tooltip 在暗页面太刺眼
 *
 * 使用：在 ChartContainer 内部对最终 option 做一次 applyEChartsThemeChrome(option, mode)
 */
export const applyEChartsThemeChrome = (
  option: EChartsOption,
  mode: ThemeMode,
): EChartsOption => {
  const p = mode === 'dark' ? PALETTE_DARK : PALETTE_LIGHT
  const splitLineColor = mode === 'dark' ? p.borderMuted : '#f0f0f0'

  const themedAxis = (axis: unknown): unknown => {
    if (axis == null) return axis
    if (Array.isArray(axis)) return axis.map((a) => themedAxis(a))
    const a = axis as Record<string, unknown>
    return {
      ...a,
      axisLabel: { color: p.textMuted, fontSize: 11, ...((a.axisLabel as Record<string, unknown>) ?? {}) },
      axisLine: { lineStyle: { color: p.border }, ...((a.axisLine as Record<string, unknown>) ?? {}) },
      splitLine: { lineStyle: { color: splitLineColor }, ...((a.splitLine as Record<string, unknown>) ?? {}) },
    }
  }

  const optTooltip = (option as { tooltip?: Record<string, unknown> }).tooltip ?? {}
  const optLegend = (option as { legend?: Record<string, unknown> }).legend ?? {}
  const optTextStyle = (option as { textStyle?: Record<string, unknown> }).textStyle ?? {}

  return {
    backgroundColor: 'transparent',
    ...option,
    textStyle: { color: p.textMuted, ...optTextStyle },
    // 强制覆盖 tooltip.bg/border/textStyle.color：浅色 chart 的硬编码 #fff 在暗页面体验差
    tooltip: {
      ...optTooltip,
      backgroundColor: p.panel,
      borderColor: p.border,
      textStyle: {
        ...((optTooltip.textStyle as Record<string, unknown>) ?? {}),
        color: p.text,
      },
    },
    legend: {
      ...optLegend,
      textStyle: {
        color: p.textMuted,
        ...((optLegend.textStyle as Record<string, unknown>) ?? {}),
      },
    },
    xAxis: themedAxis((option as { xAxis?: unknown }).xAxis) as EChartsOption['xAxis'],
    yAxis: themedAxis((option as { yAxis?: unknown }).yAxis) as EChartsOption['yAxis'],
  }
}
