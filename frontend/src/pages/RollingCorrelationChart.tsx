/**
 * 滚动相关性图表（pearson）
 *
 * 计算所有策略两两 daily return 的滚动相关性，叠加为多线时间序列图。
 * 支持调整窗口长度（默认 20 日）。
 */

import { useMemo, useState } from 'react'
import { Empty, InputNumber, Space, Tooltip, Typography } from 'antd'
import { QuestionCircleOutlined } from '@ant-design/icons'
import type { TrainingCompareRecord } from '@/types'
import ChartContainer from '@/components/responsive/ChartContainer'
import {
  CORRELATION_COLORS,
  computeRollingCorrelations,
} from './PortfolioCombo'

const { Text } = Typography

interface Props {
  records: TrainingCompareRecord[]
  height?: number
}

const RollingCorrelationChart: React.FC<Props> = ({ records, height = 320 }) => {
  const [windowSize, setWindowSize] = useState<number>(20)

  const { dates, pairs } = useMemo(() => {
    const inputs = records
      .map((r) => ({
        id: r.id,
        name: r.name || `#${r.id}`,
        dates: r.merged_report?.dates ?? [],
        cumulative: r.merged_report?.cumulative_return ?? [],
      }))
      .filter((s) => s.dates.length > 0 && s.cumulative.length > 0)
    return computeRollingCorrelations(inputs, windowSize)
  }, [records, windowSize])

  if (records.length < 2) {
    return <Empty description="至少 2 条策略才能计算相关性" style={{ padding: 40 }} />
  }
  if (pairs.length === 0 || dates.length === 0) {
    return <Empty description="无可用数据" style={{ padding: 40 }} />
  }

  const series = pairs.map((p, idx) => ({
    name: `${p.aName} vs ${p.bName}`,
    type: 'line',
    data: p.values,
    showSymbol: false,
    connectNulls: false,
    lineStyle: { width: 1.5, color: CORRELATION_COLORS[idx % CORRELATION_COLORS.length] },
    itemStyle: { color: CORRELATION_COLORS[idx % CORRELATION_COLORS.length] },
  }))

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <Space size={8} align="center">
          <Text style={{ fontSize: 13, fontWeight: 500 }}>滚动窗口</Text>
          <InputNumber
            value={windowSize}
            onChange={(v) => typeof v === 'number' && v >= 5 && v <= 252 && setWindowSize(v)}
            min={5}
            max={252}
            step={5}
            addonAfter="日"
            size="small"
            style={{ width: 110 }}
          />
          <Tooltip title="基于 cumulative_return 反推日收益序列，每日取过去 N 日做 pearson 相关性。窗口内有效双方样本不足 N/2 时跳过该点。常用 20/60/120 日。">
            <QuestionCircleOutlined style={{ color: 'var(--ap-text-muted)', fontSize: 12 }} />
          </Tooltip>
        </Space>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {pairs.length} 对策略组合 · {dates.length} 个时点
        </Text>
      </div>
      <ChartContainer
        library="echarts"
        height={height}
        option={{
          tooltip: {
            trigger: 'axis',
            valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(3) : '-'),
          },
          legend: {
            data: series.map((s) => s.name),
            top: 0,
            type: 'scroll',
            // legend 文本可读但行较密时启用滚动
          },
          grid: { left: 60, right: 30, top: 50, bottom: 60 },
          xAxis: {
            type: 'category',
            data: dates,
            axisLabel: { fontSize: 10 },
            splitLine: { show: false },
          },
          yAxis: {
            type: 'value',
            min: -1,
            max: 1,
            interval: 0.5,
            axisLabel: { formatter: (v: number) => v.toFixed(1) },
          },
          // 0 / ±0.5 / ±1 标注线
          markLine: {
            symbol: 'none',
            silent: true,
            data: [
              { yAxis: 0, lineStyle: { color: 'var(--ap-text-muted)', type: 'solid', width: 1 } },
              { yAxis: 0.5, lineStyle: { color: 'var(--ap-text-muted)', type: 'dashed', width: 1, opacity: 0.5 } },
              { yAxis: -0.5, lineStyle: { color: 'var(--ap-text-muted)', type: 'dashed', width: 1, opacity: 0.5 } },
            ],
          },
          dataZoom: [
            { type: 'slider', start: 0, end: 100, height: 20, bottom: 5 },
            { type: 'inside', start: 0, end: 100 },
          ],
          series,
        }}
      />
    </div>
  )
}

export default RollingCorrelationChart
