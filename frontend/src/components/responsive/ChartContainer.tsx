/**
 * AlphaPilot 图表容器
 *
 * 统一包 ECharts 与 Plotly，解决两个长期坑点：
 *
 * 1. **容器尺寸变化漏 resize**：window.resize 在 Tab 切换 / Drawer 开合 /
 *    Sidebar 折叠 / 父 Collapse 展开时不触发，但容器宽度变了。本组件用
 *    ResizeObserver 兜底，正确触发 echarts.resize() 与 Plotly.Plots.resize()。
 *
 * 2. **Plotly 在隐藏 Tab 内挂载渲染为 0 宽**：Plotly 的 useResizeHandler 仅
 *    监听 window.resize，初次挂载若处于 display:none 内则得到 0 宽。本组件
 *    暴露 imperative `resize()` 出口，配合 LazyMount 在 Tab 真正可见后调用。
 *
 * 用法：
 *   // ECharts
 *   <ChartContainer library="echarts" option={...} height={{xs:220, lg:320}} />
 *
 *   // Plotly
 *   <ChartContainer
 *     library="plotly"
 *     data={fig.data} layout={fig.layout}
 *     height={400}
 *   />
 *
 * 默认按断点高度：xs:220 / sm:240 / md:280 / lg:320。可显式覆盖。
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Empty, Skeleton, Tooltip } from 'antd'
import { QuestionCircleOutlined } from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import type { EChartsReactProps } from 'echarts-for-react'
import Plot from 'react-plotly.js'
import type Plotly from 'plotly.js'
import { useActiveBp } from '@/hooks/useBreakpoint'
import { observeResize, resolveChartHeight, type ChartHeightSpec } from './chart-utils'

interface BaseProps {
  /** 高度（数字或按断点）。默认 xs:220 / sm:240 / md:280 / lg:320 */
  height?: ChartHeightSpec
  loading?: boolean
  empty?: boolean
  emptyText?: ReactNode
  /** 可选标题（出现在图表上方一行） */
  title?: ReactNode
  /** 标题旁的问号 tooltip 帮助说明 */
  helpText?: ReactNode
  className?: string
  style?: CSSProperties
}

interface EChartsProps extends BaseProps {
  library: 'echarts'
  option: EChartsOption
  /** 透传到 echarts-for-react 的其它 props（不含 option/style） */
  echartsProps?: Omit<EChartsReactProps, 'option' | 'style'>
}

interface PlotlyProps extends BaseProps {
  library: 'plotly'
  data: Plotly.Data[]
  layout?: Partial<Plotly.Layout>
  config?: Partial<Plotly.Config>
}

export type ChartContainerProps = EChartsProps | PlotlyProps

export interface ChartContainerHandle {
  /** 命令式触发 resize（Tab 切换、Collapse 展开后调用） */
  resize: () => void
}

const ChartContainer = forwardRef<ChartContainerHandle, ChartContainerProps>((props, ref) => {
  const { library, height, loading, empty, emptyText, title, helpText, className, style } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const echartsRef = useRef<ReactECharts | null>(null)
  const plotlyGdRef = useRef<Plotly.PlotlyHTMLElement | null>(null)
  const bp = useActiveBp()
  const resolvedHeight = useMemo(() => resolveChartHeight(height, bp), [height, bp])

  const triggerResize = () => {
    if (library === 'echarts') {
      echartsRef.current?.getEchartsInstance().resize()
    } else if (library === 'plotly' && plotlyGdRef.current) {
      // 动态访问 window.Plotly（react-plotly 已经把 plotly.js 引入到全局）
      // 静态 import('plotly.js') 会显著增大 bundle，这里走全局对象兜底。
      const w = window as unknown as { Plotly?: { Plots?: { resize: (gd: Plotly.PlotlyHTMLElement) => void } } }
      w.Plotly?.Plots?.resize(plotlyGdRef.current)
    }
  }

  useImperativeHandle(ref, () => ({ resize: triggerResize }), [library])

  // 容器尺寸变化时自动 resize（兜住 window.resize 漏触发）
  useEffect(() => {
    if (!containerRef.current) return
    return observeResize(containerRef.current, triggerResize)
    // library 变化时重绑（理论上不会变）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library])

  // ============ 渲染状态 ============
  if (loading) {
    return (
      <div
        className={className}
        style={{ height: resolvedHeight, padding: 16, ...style }}
      >
        <Skeleton.Node active style={{ width: '100%', height: '100%' }}>
          <span style={{ color: 'var(--ap-text-dim)' }}>加载中…</span>
        </Skeleton.Node>
      </div>
    )
  }

  if (empty) {
    return (
      <div
        className={className}
        style={{
          height: resolvedHeight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style,
        }}
      >
        <Empty description={emptyText ?? '暂无数据'} />
      </div>
    )
  }

  return (
    <div className={className} style={style}>
      {(title || helpText) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 8,
            color: 'var(--ap-text)',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {title && <span>{title}</span>}
          {helpText && (
            <Tooltip title={helpText}>
              <QuestionCircleOutlined style={{ color: 'var(--ap-text-muted)', fontSize: 12 }} />
            </Tooltip>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        style={{ height: resolvedHeight, width: '100%', position: 'relative' }}
      >
        {library === 'echarts' ? (
          <ReactECharts
            ref={(r) => {
              echartsRef.current = r
            }}
            option={(props as EChartsProps).option}
            notMerge
            lazyUpdate
            style={{ width: '100%', height: '100%' }}
            {...((props as EChartsProps).echartsProps ?? {})}
          />
        ) : (
          <Plot
            data={(props as PlotlyProps).data}
            layout={{
              autosize: true,
              ...(props as PlotlyProps).layout,
            }}
            config={{
              responsive: true,
              displaylogo: false,
              ...(props as PlotlyProps).config,
            }}
            useResizeHandler
            style={{ width: '100%', height: '100%' }}
            onInitialized={(_fig, gd) => {
              plotlyGdRef.current = gd as Plotly.PlotlyHTMLElement
            }}
            onUpdate={(_fig, gd) => {
              plotlyGdRef.current = gd as Plotly.PlotlyHTMLElement
            }}
          />
        )}
      </div>
    </div>
  )
})

ChartContainer.displayName = 'ChartContainer'

export default ChartContainer
