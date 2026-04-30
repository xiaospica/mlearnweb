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
 * - 仅覆盖 chrome **颜色**（tooltip bg/border/text、axis text、split line、legend text），
 *   保留原 option 的非颜色配置（fontSize / formatter / type / data 等）
 * - 不动 series（数据色保留 chart 自定义）
 * - chrome **颜色**总是 win：原 chart 的 #fff / #374151 / #f0f0f0 等浅色硬编码
 *   都是「无意识的浅色默认」，在暗模式下必须被覆盖
 *
 * 使用：在 ChartContainer 内部对最终 option 做一次 applyEChartsThemeChrome(option, mode)
 */
export const applyEChartsThemeChrome = (
  option: EChartsOption,
  mode: ThemeMode,
): EChartsOption => {
  const p = mode === 'dark' ? PALETTE_DARK : PALETTE_LIGHT
  const splitLineColor = mode === 'dark' ? p.borderMuted : '#f0f0f0'

  const overrideAxis = (axis: unknown): unknown => {
    if (axis == null) return axis
    if (Array.isArray(axis)) return axis.map((a) => overrideAxis(a))
    const a = axis as Record<string, unknown>
    const aLabel = (a.axisLabel as Record<string, unknown>) ?? {}
    const aLine = (a.axisLine as Record<string, unknown>) ?? {}
    const aLineStyle = (aLine.lineStyle as Record<string, unknown>) ?? {}
    const aSplit = (a.splitLine as Record<string, unknown>) ?? {}
    const aSplitStyle = (aSplit.lineStyle as Record<string, unknown>) ?? {}
    return {
      ...a,
      axisLabel: { ...aLabel, color: p.textMuted },
      axisLine: { ...aLine, lineStyle: { ...aLineStyle, color: p.border } },
      splitLine: { ...aSplit, lineStyle: { ...aSplitStyle, color: splitLineColor } },
    }
  }

  const optTooltip = (option as { tooltip?: Record<string, unknown> }).tooltip ?? {}
  const optLegend = (option as { legend?: Record<string, unknown> }).legend ?? {}
  const optTextStyle = (option as { textStyle?: Record<string, unknown> }).textStyle ?? {}

  return {
    backgroundColor: 'transparent',
    ...option,
    // 全局 textStyle.color：chrome 覆盖
    textStyle: { ...optTextStyle, color: p.textMuted },
    // tooltip：bg/border/text 全部 chrome 覆盖（保留 trigger / formatter 等业务配置）
    tooltip: {
      ...optTooltip,
      backgroundColor: p.panel,
      borderColor: p.border,
      textStyle: { ...((optTooltip.textStyle as Record<string, unknown>) ?? {}), color: p.text },
    },
    // legend：textStyle.color chrome 覆盖（保留 data / orient / top 等）
    legend: {
      ...optLegend,
      textStyle: { ...((optLegend.textStyle as Record<string, unknown>) ?? {}), color: p.textMuted },
    },
    xAxis: overrideAxis((option as { xAxis?: unknown }).xAxis) as EChartsOption['xAxis'],
    yAxis: overrideAxis((option as { yAxis?: unknown }).yAxis) as EChartsOption['yAxis'],
  }
}
