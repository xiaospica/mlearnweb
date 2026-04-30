import React from 'react'
import dayjs from 'dayjs'
import type { EquityPoint, SourceLabel } from '@/types/liveTrading'
import ChartContainer from '@/components/responsive/ChartContainer'
import type { ChartHeightSpec } from '@/components/responsive/chart-utils'

interface Props {
  data: EquityPoint[]
  sourceLabel: SourceLabel | null
  /** 单值或按断点 map，传给 ChartContainer。默认 xs:240 / sm:280 / md:320 */
  height?: ChartHeightSpec
}

const LABEL_TITLE: Record<SourceLabel, string> = {
  strategy_pnl: '策略收益 (variables)',
  position_sum_pnl: '持仓浮动盈亏',
  account_equity: '账户权益（多策略共享）',
  unavailable: '收益曲线',
}

const LABEL_HELP: Record<SourceLabel, string> = {
  strategy_pnl: '数据来源：策略 variables 中的 PnL 字段，反映策略自身口径',
  position_sum_pnl:
    '数据来源：按策略 vt_symbol 聚合其持仓的浮动盈亏；不含已实现盈亏',
  account_equity:
    '数据来源：该策略所属账户的总权益。由于账户通常被多策略共享，此数值为近似估计',
  unavailable: '当前没有可用的收益口径',
}

const DEFAULT_HEIGHT: ChartHeightSpec = { xs: 240, sm: 280, md: 320 }

const FullEquityChart: React.FC<Props> = ({ data, sourceLabel, height = DEFAULT_HEIGHT }) => {
  const label: SourceLabel = sourceLabel || 'unavailable'

  const series = (data || []).map((p) => ({
    ts: p.ts,
    v: (p.strategy_value ?? p.account_equity ?? null) as number | null,
  }))

  const valid = series.filter((p) => p.v !== null && !Number.isNaN(p.v as number))

  if (valid.length < 2) {
    return (
      <ChartContainer
        library="echarts"
        height={height}
        empty
        emptyText="暂无足够的历史快照，等待下一次刷新"
        title={LABEL_TITLE[label]}
        helpText={LABEL_HELP[label]}
        option={{}}
      />
    )
  }

  return (
    <ChartContainer
      library="echarts"
      height={height}
      title={LABEL_TITLE[label]}
      helpText={LABEL_HELP[label]}
      option={{
        grid: { left: 60, right: 20, top: 10, bottom: 30 },
        tooltip: {
          trigger: 'axis',
          formatter: (params: unknown) => {
            const arr = params as Array<{ data: [number, number] }>
            if (!arr || !arr.length) return ''
            const [ts, v] = arr[0].data
            return `${dayjs(ts).format('YYYY-MM-DD HH:mm:ss')}<br/>${v.toFixed(2)}`
          },
        },
        xAxis: {
          type: 'time',
          axisLabel: {
            formatter: (value: number) => dayjs(value).format('MM-DD HH:mm'),
          },
        },
        yAxis: {
          type: 'value',
          scale: true,
          axisLabel: {
            formatter: (v: number) => v.toLocaleString(),
          },
        },
        series: [
          {
            type: 'line',
            data: valid.map((p) => [p.ts, p.v as number]),
            showSymbol: false,
            smooth: true,
            lineStyle: { width: 2, color: '#3B82F6' },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(59,130,246,0.25)' },
                  { offset: 1, color: 'rgba(59,130,246,0.02)' },
                ],
              },
            },
          },
        ],
      }}
    />
  )
}

export default FullEquityChart
