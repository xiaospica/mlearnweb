import React from 'react'
import ReactECharts from 'echarts-for-react'
import { Typography } from 'antd'
import type { EquityPoint } from '@/types/liveTrading'

const { Text } = Typography

interface Props {
  points: EquityPoint[]
  height?: number
}

/**
 * Sparkline of strategy_value (or account_equity fallback) over time. Color
 * follows A-share convention: red when up, green when down, relative to the
 * first non-null sample in the series.
 */
const MiniEquityChart: React.FC<Props> = ({ points, height = 32 }) => {
  const values = (points || [])
    .map((p) => (p.strategy_value ?? p.account_equity ?? null) as number | null)
    .filter((v): v is number => v !== null && !Number.isNaN(v))

  if (values.length < 2) {
    return (
      <Text type="secondary" style={{ fontSize: 11 }}>
        暂无曲线数据
      </Text>
    )
  }

  const first = values[0]
  const last = values[values.length - 1]
  const isUp = last >= first
  const color = isUp ? '#f5222d' : '#52c41a'

  return (
    <ReactECharts
      option={{
        grid: { left: 0, right: 0, top: 4, bottom: 4 },
        xAxis: { type: 'category', show: false, data: values.map((_, i) => i) },
        yAxis: {
          type: 'value',
          show: false,
          scale: true,
        },
        tooltip: { show: false },
        series: [
          {
            type: 'line',
            data: values,
            showSymbol: false,
            smooth: true,
            lineStyle: { width: 1.5, color },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: isUp ? 'rgba(245,34,45,0.2)' : 'rgba(82,196,26,0.2)' },
                  { offset: 1, color: 'rgba(0,0,0,0)' },
                ],
              },
            },
          },
        ],
      }}
      style={{ width: '100%', height }}
    />
  )
}

export default MiniEquityChart
