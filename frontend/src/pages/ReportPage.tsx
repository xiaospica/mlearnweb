import React, { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Row, Col, Card, Typography, Tabs, Tag, Button, Space, Spin, Table, Descriptions, Empty, Tooltip, message, notification, Select, Alert, Statistic, Collapse } from 'antd'
import { ArrowLeftOutlined, BarChartOutlined, SettingOutlined, TableOutlined, InfoCircleOutlined, ExperimentOutlined, LoadingOutlined, CheckCircleOutlined, CloseCircleOutlined, BulbOutlined, DotChartOutlined, LineChartOutlined } from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import Plot from 'react-plotly.js'
import dayjs from 'dayjs'
import { reportService } from '@/services/reportService'
import { trainingService } from '@/services/trainingService'
import { factorDocService } from '@/services/factorDocService'
import { FactorInfoModal } from '@/components/FactorInfoModal'
import type { ReportData, KeyMetrics, InSampleBacktestResponse, InSampleSegmentResult, FeatureImportanceData, SHAPAnalysisData, LagICAnalysis, HoldingsAnalysis, SHAPHeatmapData } from '@/types'
import { computeEqualScaleTicks, fixPlotlyFigureXAxis } from '@/utils/chartHelpers'
import PageContainer from '@/components/layout/PageContainer'
import { useIsMobile } from '@/hooks/useBreakpoint'
import ResponsiveDescriptions from '@/components/responsive/ResponsiveDescriptions'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'
import ChartContainer from '@/components/responsive/ChartContainer'
import LazyMount from '@/components/responsive/LazyMount'

const { Title, Text } = Typography

const STATUS_COLORS: Record<string, string> = {
  FINISHED: '#52c41a',
  FAILED: '#ff4d4f',
  RUNNING: '#faad14',
  KILLED: '#d9d9d9',
}

const MetricCard: React.FC<{
  title: string
  value: unknown
  suffix?: string
  format?: (v: number) => string
  color?: string
  tooltip?: string
  isCalculated?: boolean
}> = ({ title, value, suffix = '', format, color = '#1677ff', tooltip, isCalculated = false }) => {
  const numValue = typeof value === 'number' ? value : null
  const displayValue = numValue === null ? '-' : (format ? format(numValue) : numValue.toFixed(4))
  const isPositive = numValue !== null && numValue > 0

  const combinedTooltip = isCalculated && tooltip
    ? `${tooltip}\n\n此指标由收益率序列计算得出，非MLFlow直接记录`
    : tooltip || (isCalculated ? '此指标由收益率序列计算得出，非MLFlow直接记录' : undefined)

  const titleContent = (
    <span>
      {title}
      {isCalculated && (
        <InfoCircleOutlined style={{ marginLeft: 4, fontSize: 10, color: '#faad14' }} />
      )}
    </span>
  )

  return (
    <Card
      size="small"
      style={{
        background: 'var(--ap-panel)',
        border: '1px solid var(--ap-border)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        boxShadow: '0 1px 3px var(--ap-shadow)',
      }}
      styles={{ body: { padding: '14px 18px' } }}
    >
      <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {combinedTooltip ? (
          <Tooltip title={combinedTooltip}>
            {titleContent}
          </Tooltip>
        ) : (
          titleContent
        )}
      </Text>
      <div style={{ marginTop: 4 }}>
        <span style={{
          fontSize: 22,
          fontWeight: 700,
          fontFamily: "'SF Mono', 'Consolas', monospace",
          color: numValue !== null
            ? (isPositive
                ? (title.includes('回撤') || title.includes('Drawdown')
                    ? 'var(--ap-danger)'
                    : 'var(--ap-brand-primary)')
                : 'var(--ap-danger)')
            : 'var(--ap-text-dim)',
        }}>
          {displayValue}{suffix}
        </span>
      </div>
    </Card>
  )
}

const CumulativeReturnChart: React.FC<{ data: ReportData['portfolio_data'] }> = ({ data }) => {
  if (!data?.available || !data.dates || !data.cumulative_return) {
    return <Empty description="无收益数据" style={{ padding: 40 }} />
  }

  const series: Array<Record<string, unknown>> = []
  let firstValue = 1

  if (data.cumulative_return.strategy_with_cost) {
    const raw = data.cumulative_return.strategy_with_cost
    const validFirst = raw.find((v: number | null) => v !== null && v !== undefined && !isNaN(v))
    if (validFirst !== undefined) firstValue = validFirst as number

    series.push({
      name: '策略(含成本)',
      type: 'line',
      data: raw,
      lineStyle: { width: 2 },
      itemStyle: { color: '#1677ff' },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(22,119,255,0.15)' }, { offset: 1, color: 'rgba(22,119,255,0)' }] } },
    })
  }
  if (data.cumulative_return.benchmark) {
    series.push({
      name: '基准',
      type: 'line',
      data: data.cumulative_return.benchmark,
      lineStyle: { width: 1.5, type: 'dashed' },
      itemStyle: { color: '#8c8c8c' },
    })
  }

  const isRawMultiplier = firstValue < 10

  const formatPercent = (value: number) => {
    if (isRawMultiplier) {
      return `${((value - 1) * 100).toFixed(1)}%`
    } else {
      return `${value.toFixed(1)}%`
    }
  }

  const allValues: number[] = []
  if (data.cumulative_return.strategy_with_cost) {
    allValues.push(...(data.cumulative_return.strategy_with_cost.filter((v): v is number => v !== null && v !== undefined && !isNaN(v))))
  }
  if (data.cumulative_return.benchmark) {
    allValues.push(...(data.cumulative_return.benchmark.filter((v): v is number => v !== null && v !== undefined && !isNaN(v))))
  }

  let yAxisMin: number | undefined = undefined
  let yAxisMax: number | undefined = undefined
  if (allValues.length > 0) {
    const dataMin = Math.min(...allValues)
    const dataMax = Math.max(...allValues)
    const range = dataMax - dataMin
    const padding = range * 0.05 || 0.01
    yAxisMin = dataMin - padding
    yAxisMax = dataMax + padding
  }

  return (
    <ReactECharts
      option={{
        tooltip: { 
          trigger: 'axis', 
          backgroundColor: '#fff', 
          borderColor: '#e8e8e8', 
          textStyle: { color: '#374151' },
          formatter: (params: any) => {
            if (!params || !params.length) return ''
            const date = params[0].name
            const lines = params.map((item: any) => {
              const value = item.value as number
              return `${item.marker} ${item.seriesName}: ${formatPercent(value)}`
            })
            return `${date}<br/>${lines.join('<br/>')}`
          }
        },
        legend: { data: series.map(s => s.name), textStyle: { color: '#6b7280' }, top: 0 },
        grid: { left: 70, right: 30, top: 30, bottom: 60 },
        xAxis: { type: 'category', data: data.dates, axisLabel: { color: '#9ca3af', fontSize: 10 }, axisLine: { lineStyle: { color: '#e5e7eb' } }, splitLine: { show: false } },
        yAxis: { 
          type: 'value', 
          min: yAxisMin,
          max: yAxisMax,
          axisLabel: { 
            color: '#9ca3af', 
            formatter: formatPercent
          }, 
          splitLine: { lineStyle: { color: '#f0f0f0' } } 
        },
        series,
        dataZoom: [
          { type: 'slider', start: 0, end: 100, height: 20, bottom: 5, borderColor: '#e5e7eb', fillerColor: 'rgba(22,119,255,0.1)', handleStyle: { color: '#1677ff' } },
          { type: 'inside', start: 0, end: 100 }
        ],
      }}
      style={{ height: 280 }}
      notMerge={true}
    />
  )
}

const DrawdownChart: React.FC<{ data: ReportData['portfolio_data'] }> = ({ data }) => {
  if (!data?.available || !data.drawdown) return <Empty description="无回撤数据" style={{ padding: 40 }} />

  const series: Array<Record<string, unknown>> = []
  if (data.drawdown.strategy) {
    series.push({ name: '策略回撤', type: 'line', data: data.drawdown.strategy, itemStyle: { color: '#ff4d4f' }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(255,77,79,0.12)' }, { offset: 1, color: 'rgba(255,77,79,0)' }] } } })
  }
  if (data.drawdown.benchmark) {
    series.push({ name: '基准回撤', type: 'line', data: data.drawdown.benchmark, itemStyle: { color: '#bfbfbf' } })
  }

  const ddTooltipFormatter = (p: any) => {
    if (!p || !p.length) return ''
    const parts = p.map((item: any) => item.marker + item.seriesName + ': ' + ((item.value * 100).toFixed(2) + '%'))
    return (p[0]?.name || '') + '<br/>' + parts.join('<br/>')
  }

  return (
    <ReactECharts
      option={{
        tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e8e8e8', textStyle: { color: '#374151' }, formatter: ddTooltipFormatter },
        legend: { textStyle: { color: '#6b7280' }, top: 0 },
        grid: { left: 70, right: 30, top: 30, bottom: 30 },
        xAxis: { type: 'category', data: data.dates, axisLabel: { color: '#9ca3af', fontSize: 10 }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
        yAxis: { 
          type: 'value', 
          axisLabel: { 
            color: '#9ca3af', 
            formatter: (value: number) => `${(value * 100).toFixed(1)}%`
          }, 
          splitLine: { lineStyle: { color: '#f0f0f0' } } 
        },
        series,
        dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      }}
      style={{ height: 280 }}
    />
  )
}

const TurnoverChart: React.FC<{ data: ReportData['portfolio_data'] }> = ({ data }) => {
  if (!data?.available || !data.turnover) return <Empty description="无换手率数据" style={{ padding: 40 }} />

  return (
    <ReactECharts
      option={{
        tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e8e8e8', textStyle: { color: '#374151' }, formatter: (p: any) => p?.[0]?.name + '<br/>' + p?.[0]?.marker + '换手率: ' + ((p?.[0]?.value * 100)?.toFixed(2) || '0') + '%' },
        grid: { left: 60, right: 30, top: 20, bottom: 30 },
        xAxis: { type: 'category', data: data.dates, axisLabel: { color: '#9ca3af', fontSize: 10 }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
        yAxis: { type: 'value', axisLabel: { color: '#9ca3af', formatter: '{value}%' }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
        series: [{ name: '换手率', type: 'bar', data: data.turnover, itemStyle: { color: '#722ed1', borderRadius: [2, 2, 0, 0] }, barWidth: '60%' }],
        dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      }}
      style={{ height: 280 }}
    />
  )
}

const ICChart: React.FC<{ data: ReportData['ic_analysis'] }> = ({ data }) => {
  if (!data?.available || !data.ic_series) return <Empty description="无IC数据" style={{ padding: 40 }} />
  const icValues = data.ic_series.values.map((v: number | null) => v === null ? 0 : v)

  return (
    <ReactECharts
      option={{
        tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e8e8e8', textStyle: { color: '#374151' } },
        legend: { data: ['IC值'], textStyle: { color: '#6b7280' }, top: 0 },
        grid: { left: 60, right: 60, top: 30, bottom: 30 },
        xAxis: { type: 'category', data: data.ic_series.dates, axisLabel: { color: '#9ca3af', fontSize: 9 }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
        yAxis: { type: 'value', axisLabel: { color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
        series: [{
          name: 'IC值',
          type: 'bar',
          data: icValues,
          itemStyle: (params: any) => ({
            color: params.value >= 0 ? '#52c41a' : '#ff4d4f',
            borderRadius: [1, 1, 0, 0],
          }),
        }],
        markLine: {
          data: [
            { yAxis: data.summary?.mean_ic || 0, name: '均值', lineStyle: { color: '#8c8c8c', type: 'dashed' } },
            { yAxis: 0, name: '零线', lineStyle: { color: '#d9d9d9', type: 'solid' } },
          ],
          label: { formatter: '{c}', color: '#6b7280' },
        },
        dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      }}
      style={{ height: 280 }}
    />
  )
}

const ICDistributionChart: React.FC<{ data: ReportData['ic_analysis'] }> = ({ data }) => {
  if (!data?.available || !data.ic_series) return <Empty description="无IC数据" style={{ padding: 40 }} />

  const icValues = data.ic_series.values.filter((v: number | null) => v !== null) as number[]
  if (icValues.length === 0) return <Empty description="无有效IC数据" style={{ padding: 40 }} />

  const min = Math.min(...icValues)
  const max = Math.max(...icValues)
  const binCount = 30
  const binWidth = (max - min) / binCount || 1
  const bins = new Array(binCount).fill(0)
  icValues.forEach((v: number) => {
    const idx = Math.min(Math.floor((v - min) / binWidth), binCount - 1)
    bins[idx]++
  })
  const binLabels = Array.from({ length: binCount }, (_, i) => (min + i * binWidth).toFixed(3))

  return (
    <ReactECharts
      option={{
        tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e8e8e8', textStyle: { color: '#374151' } },
        grid: { left: 60, right: 30, top: 20, bottom: 50 },
        xAxis: { type: 'category', data: binLabels, axisLabel: { color: '#9ca3af', fontSize: 9, rotate: 45 }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
        yAxis: { type: 'value', axisLabel: { color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
        series: [{ name: '频次', type: 'bar', data: bins, itemStyle: { color: '#1677ff', borderRadius: [2, 2, 0, 0] } }],
        markLine: {
          data: [
            { xAxis: data.summary?.mean_ic?.toFixed(3) || '0', name: '均值', lineStyle: { color: '#fa8c16', type: 'dashed' } },
          ],
          label: { formatter: '均值: {c}', color: '#6b7280' },
        },
      }}
      style={{ height: 280 }}
    />
  )
}

const PredictionHistogram: React.FC<{ data: ReportData['prediction_stats'] }> = ({ data }) => {
  if (!data?.available || !data.histogram) return <Empty description="无预测数据" style={{ padding: 40 }} />

  const { counts, bin_centers } = data.histogram

  return (
    <ReactECharts
      option={{
        tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e8e8e8', textStyle: { color: '#374151' } },
        grid: { left: 60, right: 30, top: 20, bottom: 30 },
        xAxis: { type: 'category', data: bin_centers.map((v: number) => v.toFixed(4)), axisLabel: { color: '#9ca3af', fontSize: 9 }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
        yAxis: { type: 'value', axisLabel: { color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
        series: [{ name: '频次', type: 'bar', data: counts, itemStyle: { color: '#1677ff', borderRadius: [2, 2, 0, 0] } }],
      }}
      style={{ height: 280 }}
    />
  )
}

const RiskMetricsTable: React.FC<{ data: ReportData['risk_metrics'] }> = ({ data }) => {
  if (!data?.available) return <Empty description="无风险指标数据" style={{ padding: 40 }} />

  const metrics = data.metrics || {}
  const entries = Object.entries(metrics)

  return (
    <Table
      size="small"
      dataSource={entries.map(([k, v]) => ({ key: k, value: typeof v === 'number' ? v.toFixed(6) : String(v) }))}
      pagination={false}
      columns={[
        { title: '指标', dataIndex: 'key', key: 'key', render: (t: string) => <Text code style={{ color: '#6b7280', fontSize: 13 }}>{t}</Text> },
        { title: '值', dataIndex: 'value', key: 'value', align: 'right', render: (t: string) => <Text style={{ color: '#374151', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14 }}>{t}</Text> },
      ]}
      rowKey="key"
    />
  )
}

const useContainerSize = (defaultW = 400, defaultH = 280) => {
  const ref = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState({ w: defaultW, h: defaultH })
  React.useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const apply = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setSize({ w: rect.width, h: rect.height })
      }
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, size }
}

const PredLabelScatterChart: React.FC<{ data?: { available: boolean; labels?: number[]; scores?: number[]; correlation?: number; count?: number } }> = ({ data }) => {
  const GRID = { left: 60, right: 30, top: 20, bottom: 40 }
  const { ref, size } = useContainerSize(400, 280)
  if (!data?.available || !data.labels || !data.scores) {
    return <Empty description="无预测-标签数据" style={{ padding: 40 }} />
  }

  const { labels, scores, correlation, count } = data
  const sampleData = labels.map((label, i) => [scores[i], label]).slice(0, 3000)
  const plotW = Math.max(size.w - GRID.left - GRID.right, 1)
  const plotH = Math.max(size.h - GRID.top - GRID.bottom, 1)
  const ticks = computeEqualScaleTicks(scores, labels, plotW, plotH)

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>样本数: <Text strong>{count}</Text></Text>
        <Text type="secondary" style={{ fontSize: 12 }}>相关系数: <Text strong style={{ color: correlation && correlation > 0 ? '#52c41a' : '#ff4d4f' }}>{correlation?.toFixed(4) || '-'}</Text></Text>
      </div>
      <div ref={ref} style={{ width: '100%', height: 280 }}>
        <ReactECharts
          option={{
            tooltip: { trigger: 'item', backgroundColor: '#fff', borderColor: '#e8e8e8', textStyle: { color: '#374151' }, formatter: (p: any) => `Score: ${p.value[0]?.toFixed(4)}<br/>Label: ${p.value[1]?.toFixed(4)}` },
            grid: GRID,
            xAxis: { type: 'value', min: ticks.xMin, max: ticks.xMax, interval: ticks.interval, name: '预测分数', nameLocation: 'middle', nameGap: 25, axisLabel: { color: '#9ca3af', fontSize: 10 }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
            yAxis: { type: 'value', min: ticks.yMin, max: ticks.yMax, interval: ticks.interval, name: '真实标签', nameLocation: 'middle', nameGap: 40, axisLabel: { color: '#9ca3af', fontSize: 10 }, axisLine: { lineStyle: { color: '#e5e7eb' } }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
            series: [{
              type: 'scatter',
              data: sampleData,
              symbolSize: 5,
              itemStyle: (params: any) => {
                const score = params.data[0]
                const label = params.data[1]
                const isCorrect = (score > 0 && label > 0) || (score < 0 && label < 0)
                return {
                  color: isCorrect ? '#52c41a' : '#ff4d4f',
                  opacity: 0.6,
                }
              },
            }],
          }}
          style={{ width: '100%', height: '100%' }}
          notMerge
        />
      </div>
    </div>
  )
}

const RollingStatsChart: React.FC<{ data?: { available: boolean; dates?: string[]; rolling_return?: (number | null)[]; rolling_volatility?: (number | null)[]; rolling_sharpe?: (number | null)[] } }> = ({ data }) => {
  if (!data?.available || !data.dates || !data.rolling_sharpe) {
    return <Empty description="无滚动统计数据" style={{ padding: 40 }} />
  }

  const validDates = data.dates.filter((_, i) => data.rolling_sharpe?.[i] !== null)
  const validSharpe = data.rolling_sharpe?.filter(v => v !== null) || []
  const validVol = data.rolling_volatility?.filter(v => v !== null) || []

  return (
    <ReactECharts
      option={{
        tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e8e8e8', textStyle: { color: '#374151' } },
        legend: { data: ['滚动夏普', '滚动波动率'], textStyle: { color: '#6b7280' }, top: 0 },
        grid: { left: 60, right: 60, top: 30, bottom: 30 },
        xAxis: { type: 'category', data: validDates, axisLabel: { color: '#9ca3af', fontSize: 9 }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
        yAxis: [
          { type: 'value', name: '夏普比率', axisLabel: { color: '#9ca3af' }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
          { type: 'value', name: '波动率', axisLabel: { color: '#9ca3af' }, splitLine: { show: false } },
        ],
        series: [
          { name: '滚动夏普', type: 'line', data: validSharpe, itemStyle: { color: '#1677ff' }, lineStyle: { width: 1.5 } },
          { name: '滚动波动率', type: 'line', data: validVol, yAxisIndex: 1, itemStyle: { color: '#fa8c16' }, lineStyle: { width: 1.5, type: 'dashed' } },
        ],
        dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      }}
      style={{ height: 280 }}
    />
  )
}

const MonthlyReturnHistogram: React.FC<{ data?: { available: boolean; histogram?: { values: number[]; labels: string[] } } }> = ({ data }) => {
  if (!data?.available || !data.histogram || !data.histogram.values) {
    return <Empty description="无月度收益数据" style={{ padding: 40 }} />
  }

  const { values, labels } = data.histogram

  return (
    <ReactECharts
      option={{
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
          formatter: (p: any) => {
            if (!p || !p.length) return ''
            const item = p[0]
            return `${item.name}<br/>月度收益: ${(item.value * 100).toFixed(2)}%`
          },
        },
        grid: { left: 60, right: 30, top: 20, bottom: 60 },
        xAxis: {
          type: 'category',
          data: labels,
          axisLabel: { color: '#9ca3af', fontSize: 9, rotate: 45 },
          axisLine: { lineStyle: { color: '#e5e7eb' } },
        },
        yAxis: {
          type: 'value',
          axisLabel: { 
            color: '#9ca3af', 
            formatter: (value: number) => `${(value * 100).toFixed(1)}%` 
          },
          splitLine: { lineStyle: { color: '#f0f0f0' } },
        },
        series: [{
          type: 'bar',
          data: values.map((v, i) => ({
            value: v,
            itemStyle: { color: v >= 0 ? '#52c41a' : '#ff4d4f' },
          })),
          barWidth: '60%',
        }],
      }}
      style={{ height: 280 }}
    />
  )
}

const MonthlyReturnHeatmap: React.FC<{ data?: { available: boolean; years?: number[]; months?: string[]; heatmap_data?: Array<[number, number, number]> } }> = ({ data }) => {
  if (!data?.available || !data.years?.length || !data.months?.length || !data.heatmap_data?.length) {
    return <Empty description="无月度收益数据" style={{ padding: 40 }} />
  }

  const { years, months, heatmap_data } = data
  const yearLabels = years.map(String)

  const convertedData = heatmap_data.map(([year, monthIdx, ret]) => {
    const yearIndex = years.indexOf(year)
    return [monthIdx, yearIndex, ret]
  })

  const minReturn = Math.min(...heatmap_data.map(d => d[2]))
  const maxReturn = Math.max(...heatmap_data.map(d => d[2]))
  const absMax = Math.max(Math.abs(minReturn), Math.abs(maxReturn), 0.01)

  return (
    <ReactECharts
      option={{
        tooltip: {
          position: 'top',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
          formatter: (p: any) => {
            if (!p || !p.data) return ''
            const [monthIdx, yearIndex, ret] = p.data
            return `${yearLabels[yearIndex]}年${months[monthIdx]}<br/>月度收益: ${(ret * 100).toFixed(2)}%`
          },
        },
        grid: { left: 60, right: 80, top: 20, bottom: 40 },
        xAxis: {
          type: 'category',
          data: months,
          splitArea: { show: true },
          axisLabel: { color: '#6b7280', fontSize: 10 },
        },
        yAxis: {
          type: 'category',
          data: yearLabels,
          splitArea: { show: true },
          axisLabel: { color: '#6b7280', fontSize: 10 },
        },
        visualMap: {
          min: -absMax,
          max: absMax,
          calculable: true,
          orient: 'vertical',
          right: 10,
          top: 'center',
          inRange: {
            color: ['#ff4d4f', '#fff5f5', '#f6ffed', '#52c41a'],
          },
          formatter: (value: number) => `${(value * 100).toFixed(1)}%`,
        },
        series: [{
          type: 'heatmap',
          data: convertedData,
          label: {
            show: true,
            formatter: (p: any) => p.data[2] !== undefined ? `${(p.data[2] * 100).toFixed(1)}%` : '',
            fontSize: 9,
            color: '#374151',
          },
          emphasis: {
            itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.5)' },
          },
        }],
      }}
      style={{ height: 280 }}
    />
  )
}

const AnnualReturnHistogram: React.FC<{ data?: { available: boolean; annual_returns?: Record<string, number>; benchmark_annual_returns?: Record<string, number> } }> = ({ data }) => {
  if (!data?.available || !data.annual_returns) {
    return <Empty description="无年度收益数据" style={{ padding: 40 }} />
  }

  const annualReturns = data.annual_returns
  const benchmarkReturns = data.benchmark_annual_returns || {}
  
  const years = Object.keys(annualReturns).sort()
  if (years.length === 0) return <Empty description="无年度收益数据" style={{ padding: 40 }} />

  const values = Object.values(annualReturns)
  const dataMin = Math.min(...values)
  const dataMax = Math.max(...values)
  const dataRange = dataMax - dataMin
  const padding = Math.max(dataRange * 0.15, 0.02)
  
  let minVal: number, maxVal: number
  if (dataMin >= 0) {
    minVal = 0
    maxVal = dataMax + padding
  } else if (dataMax <= 0) {
    minVal = dataMin - padding
    maxVal = 0
  } else {
    minVal = dataMin - padding
    maxVal = dataMax + padding
  }

  const barData = years.map(year => ({
    year,
    strategy: annualReturns[year],
    benchmark: benchmarkReturns[year],
    excess: (annualReturns[year] || 0) - (benchmarkReturns[year] || 0),
  }))

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>年数: <Text strong>{years.length}</Text></Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          平均年化收益: 
          <Text strong style={{ color: values.reduce((a, b) => a + b, 0) / values.length >= 0 ? '#52c41a' : '#ff4d4f' }}>
            {((values.reduce((a, b) => a + b, 0) / values.length) * 100).toFixed(2)}%
          </Text>
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          最佳年份: <Text strong style={{ color: '#52c41a' }}>{Math.max(...values) > 0 ? '+' : ''}{(Math.max(...values) * 100).toFixed(2)}%</Text> ({years[values.indexOf(Math.max(...values))]})
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          最差年份: <Text strong style={{ color: '#ff4d4f' }}>{(Math.min(...values) * 100).toFixed(2)}%</Text> ({years[values.indexOf(Math.min(...values))]})
        </Text>
      </div>
      <ReactECharts
        option={{
          tooltip: {
            trigger: 'axis',
            backgroundColor: '#fff',
            borderColor: '#e8e8e8',
            textStyle: { color: '#374151' },
            formatter: (p: any) => {
              if (!p || !p.length) return ''
              const item = p[0]
              const d = barData.find(b => b.year === item.name)
              let tooltip = `${item.name}年<br/>`
              tooltip += `策略收益: ${((d?.strategy || 0) * 100).toFixed(2)}%<br/>`
              if (d?.benchmark !== undefined) {
                tooltip += `基准收益: ${((d.benchmark || 0) * 100).toFixed(2)}%<br/>`
                tooltip += `超额收益: <span style="color:${d.excess >= 0 ? '#52c41a' : '#ff4d4f'}">${(d.excess * 100).toFixed(2)}%</span>`
              }
              return tooltip
            },
          },
          legend: {
            data: ['策略年化收益', '基准年化收益'],
            textStyle: { color: '#6b7280', fontSize: 11 },
            top: 0,
          },
          grid: { left: 60, right: 30, top: 30, bottom: 50 },
          xAxis: {
            type: 'category',
            data: years,
            axisLabel: { color: '#9ca3af', fontSize: 11 },
            axisLine: { lineStyle: { color: '#e5e7eb' } },
          },
          yAxis: {
            type: 'value',
            min: minVal,
            max: maxVal,
            axisLabel: {
              color: '#9ca3af',
              formatter: (value: number) => `${(value * 100).toFixed(0)}%`,
            },
            splitLine: { lineStyle: { color: '#f0f0f0' } },
            name: '收益率',
            nameLocation: 'middle',
            nameGap: 40,
            nameTextStyle: { color: '#6b7280' },
          },
          series: [
            {
              name: '策略年化收益',
              type: 'bar',
              data: barData.map(d => ({
                value: d.strategy,
                itemStyle: {
                  color: d.strategy >= 0 ? '#52c41a' : '#ff4d4f',
                  borderRadius: [3, 3, 0, 0],
                },
              })),
              barWidth: '50%',
              z: 10,
            },
            ...(Object.keys(benchmarkReturns).length > 0 ? [{
              name: '基准年化收益',
              type: 'bar',
              data: barData.map(d => ({
                value: d.benchmark !== undefined ? d.benchmark : null,
                itemStyle: {
                  color: '#8c8c8c',
                  borderRadius: [3, 3, 0, 0],
                  opacity: 0.6,
                },
              })),
              barWidth: '35%',
              z: 5,
            }] : []),
          ],
          markLine: {
            data: [{ yAxis: 0, name: '零线', lineStyle: { color: '#d9d9d9', type: 'solid' } }],
          },
        }}
        style={{ height: 280 }}
      />
    </div>
  )
}

// 新增：日收益率分布直方图组件
const DailyReturnDistributionChart: React.FC<{ data?: { available: boolean; histogram?: { counts: number[]; bins: number[]; bin_centers: number[] }; mean?: number; std?: number; positive_ratio?: number; negative_days?: number; count?: number } }> = ({ data }) => {
  if (!data?.available || !data.histogram) {
    return <Empty description="无日收益率分布数据" style={{ padding: 40 }} />
  }

  const { histogram, mean, std, positive_ratio, negative_days, count } = data
  const { counts, bin_centers } = histogram

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>交易日数: <Text strong>{count}</Text></Text>
        <Text type="secondary" style={{ fontSize: 12 }}>均值: <Text strong>{mean ? ((mean * 100).toFixed(3)) + '%' : '-'}</Text></Text>
        <Text type="secondary" style={{ fontSize: 12 }}>标准差: <Text strong>{std ? ((std * 100).toFixed(3)) + '%' : '-'}</Text></Text>
        <Text type="secondary" style={{ fontSize: 12 }}>正收益比例: <Text strong style={{ color: '#52c41a' }}>{positive_ratio ? ((positive_ratio * 100).toFixed(1)) + '%' : '-'}</Text></Text>
        <Text type="secondary" style={{ fontSize: 12 }}>负收益天数: <Text strong style={{ color: '#ff4d4f' }}>{negative_days || 0}</Text></Text>
      </div>
      <ReactECharts
        option={{
          tooltip: {
            trigger: 'axis',
            backgroundColor: '#fff',
            borderColor: '#e8e8e8',
            textStyle: { color: '#374151' },
            formatter: (p: any) => {
              if (!p || !p.length) return ''
              const item = p[0]
              return `区间: ${item.name}<br/>频次: ${item.value}<br/>占比: ${((item.value / (count || 1)) * 100).toFixed(1)}%`
            },
          },
          grid: { left: 60, right: 30, top: 20, bottom: 50 },
          xAxis: {
            type: 'category',
            data: bin_centers.map((v: number) => (v * 100).toFixed(3)),
            axisLabel: {
              color: '#9ca3af',
              fontSize: 9,
              rotate: 45,
              formatter: (value: string) => `${value}%`,
            },
            axisLine: { lineStyle: { color: '#e5e7eb' } },
            name: '收益率',
            nameLocation: 'middle',
            nameGap: 35,
            nameTextStyle: { color: '#6b7280' },
          },
          yAxis: {
            type: 'value',
            axisLabel: { color: '#9ca3af' },
            splitLine: { lineStyle: { color: '#f0f0f0' } },
            name: '频次',
            nameLocation: 'middle',
            nameGap: 45,
            nameTextStyle: { color: '#6b7280' },
          },
          series: [{
            name: '频次',
            type: 'bar',
            data: counts.map((c: number, i: number) => ({
              value: c,
              itemStyle: {
                color: bin_centers[i] >= 0 ? '#52c41a' : '#ff4d4f',
                borderRadius: [1, 1, 0, 0],
              },
            })),
            barWidth: '90%',
          }],
          markLine: {
            data: [
              { xAxis: mean ? (mean * 100).toFixed(3) : '0', name: '均值', lineStyle: { color: '#fa8c16', type: 'dashed' } },
              { xAxis: '0', name: '零线', lineStyle: { color: '#d9d9d9', type: 'solid' } },
            ],
            label: { formatter: '{c}%', color: '#6b7280' },
          },
        }}
        style={{ height: 320 }}
      />
    </div>
  )
}

// 新增：模型性能指标表格组件
const ModelPerformanceTable: React.FC<{ data?: { available: boolean; sample_count?: number; direction_accuracy?: number; classification_metrics?: { accuracy: number; precision: number; recall: number; specificity: number; f1_score: number; confusion_matrix: { tp: number; fp: number; tn: number; fn: number } }; quantile_analysis?: { long_short_return: number; group_returns: Record<string, number> }; rank_ic?: number; rank_ic_pvalue?: number; mse?: number; mae?: number } }> = ({ data }) => {
  if (!data?.available) {
    return <Empty description="无模型性能数据" style={{ padding: 40 }} />
  }

  const { sample_count, direction_accuracy, classification_metrics, quantile_analysis, rank_ic, rank_ic_pvalue, mse, mae } = data

  // 分类指标数据
  const classificationData = classification_metrics ? [
    { key: '准确率 (Accuracy)', value: (classification_metrics.accuracy * 100).toFixed(2) + '%', desc: '(TP+TN)/Total' },
    { key: '精确率 (Precision)', value: (classification_metrics.precision * 100).toFixed(2) + '%', desc: 'TP/(TP+FP)' },
    { key: '召回率 (Recall)', value: (classification_metrics.recall * 100).toFixed(2) + '%', desc: 'TP/(TP+FN)' },
    { key: '特异度 (Specificity)', value: (classification_metrics.specificity * 100).toFixed(2) + '%', desc: 'TN/(TN+FP)' },
    { key: 'F1 分数', value: classification_metrics.f1_score.toFixed(4), desc: '2*P*R/(P+R)' },
  ] : []

  // 回归指标数据
  const regressionData = [
    { key: '方向准确率', value: direction_accuracy ? (direction_accuracy * 100).toFixed(2) + '%' : '-', desc: '预测方向与实际方向一致的比例' },
    { key: 'Rank IC', value: rank_ic ? rank_ic.toFixed(4) : '-', desc: 'Spearman相关系数' },
    { key: 'Rank IC P-Value', value: rank_ic_pvalue ? rank_ic_pvalue.toFixed(4) : '-', desc: '' },
    { key: 'MSE (均方误差)', value: mse ? mse.toExponential(4) : '-', desc: '' },
    { key: 'MAE (平均绝对误差)', value: mae ? mae.toExponential(4) : '-', desc: '' },
  ]

  // 混淆矩阵数据
  const confusionMatrixData = classification_metrics?.confusion_matrix ? [
    { key: '真阳性 (TP)', value: String(classification_metrics.confusion_matrix.tp), desc: '正确预测为正' },
    { key: '假阳性 (FP)', value: String(classification_metrics.confusion_matrix.fp), desc: '错误预测为正' },
    { key: '真阴性 (TN)', value: String(classification_metrics.confusion_matrix.tn), desc: '正确预测为负' },
    { key: '假阴性 (FN)', value: String(classification_metrics.confusion_matrix.fn), desc: '错误预测为负' },
  ] : []

  // 分位数分析数据
  const quantileData = quantile_analysis ? Object.entries(quantile_analysis.group_returns).map(([k, v]) => ({
    key: k,
    value: (v * 100).toFixed(3) + '%',
    desc: k === 'Q5' || k === 'Q1' ? (k === 'Q5' ? '最高分位组' : '最低分位组') : '',
  })) : []

  return (
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <Card title={`模型性能概览 (样本数: ${sample_count || 0})`} size="small">
          <ResponsiveDescriptions
            size="small"
            bordered
            columns={{ xxl: 3, xl: 3, lg: 3, md: 3, sm: 2, xs: 1 }}
            items={[
              { key: 'samples', label: '样本总数', value: sample_count || 0 },
              {
                key: 'dir-acc',
                label: '方向准确率',
                value: (
                  <Text style={{ color: direction_accuracy && direction_accuracy > 0.5 ? 'var(--ap-success)' : 'var(--ap-danger)' }}>
                    {direction_accuracy ? (direction_accuracy * 100).toFixed(2) + '%' : '-'}
                  </Text>
                ),
              },
              {
                key: 'rank-ic',
                label: 'Rank IC',
                value: (
                  <Text style={{ color: rank_ic && rank_ic > 0 ? 'var(--ap-success)' : 'var(--ap-danger)' }}>
                    {rank_ic?.toFixed(4) || '-'}
                  </Text>
                ),
              },
              { key: 'mse', label: 'MSE', value: mse?.toExponential(4) || '-' },
              { key: 'mae', label: 'MAE', value: mae?.toExponential(4) || '-' },
              {
                key: 'ls',
                label: '多空收益差',
                value: (
                  <Text style={{ color: quantile_analysis?.long_short_return && quantile_analysis.long_short_return > 0 ? 'var(--ap-success)' : 'var(--ap-danger)' }}>
                    {quantile_analysis?.long_short_return ? ((quantile_analysis.long_short_return) * 100).toFixed(3) + '%' : '-'}
                  </Text>
                ),
              },
            ]}
          />
        </Card>
      </Col>

      {classificationData.length > 0 && (
        <Col xs={24} lg={12}>
          <Card title="分类指标 (阈值=0)" size="small">
            <ResponsiveTable<{ key: string; value: string; desc: string }>
              size="small"
              dataSource={classificationData}
              pagination={false}
              rowKey="key"
              columns={[
                { title: '指标', dataIndex: 'key', key: 'key', mobileRole: 'title', render: (t: string) => <Text code style={{ color: 'var(--ap-brand-primary)', fontSize: 13 }}>{t}</Text> },
                { title: '值', dataIndex: 'value', key: 'value', align: 'right', mobileRole: 'badge', render: (t: string) => <Text strong style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14 }}>{t}</Text> },
                { title: '说明', dataIndex: 'desc', key: 'desc', mobileRole: 'subtitle', render: (t: string) => <Text type="secondary" style={{ fontSize: 11 }}>{t}</Text> },
              ]}
            />
          </Card>
        </Col>
      )}

      {confusionMatrixData.length > 0 && (
        <Col xs={24} lg={12}>
          <Card title="混淆矩阵" size="small">
            <ResponsiveTable<{ key: string; value: string; desc: string }>
              size="small"
              dataSource={confusionMatrixData}
              pagination={false}
              rowKey="key"
              columns={[
                { title: '指标', dataIndex: 'key', key: 'key', mobileRole: 'title', render: (t: string) => <Text code style={{ color: 'var(--ap-accent)', fontSize: 13 }}>{t}</Text> },
                { title: '数量', dataIndex: 'value', key: 'value', align: 'right', mobileRole: 'badge', render: (t: string) => <Text strong style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14 }}>{t}</Text> },
                { title: '说明', dataIndex: 'desc', key: 'desc', mobileRole: 'subtitle', render: (t: string) => <Text type="secondary" style={{ fontSize: 11 }}>{t}</Text> },
              ]}
            />
          </Card>
        </Col>
      )}

      {quantileData.length > 0 && (
        <Col xs={24} lg={12}>
          <Card title="分位数收益分析 (5组)" size="small">
            <ResponsiveTable<{ key: string; value: string; desc: string }>
              size="small"
              dataSource={quantileData}
              pagination={false}
              rowKey="key"
              columns={[
                { title: '分组', dataIndex: 'key', key: 'key', width: 80, mobileRole: 'title', render: (t: string) => <Tag color={['#ff4d4f', '#ff7875', '#faad14', '#95de64', '#52c41a'][['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].indexOf(t)]}>{t}</Tag> },
                { title: '平均收益', dataIndex: 'value', key: 'value', align: 'right', mobileRole: 'badge', render: (t: string) => <Text strong style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14, color: t.includes('-') ? 'var(--ap-market-down)' : 'var(--ap-market-up)' }}>{t}</Text> },
                { title: '说明', dataIndex: 'desc', key: 'desc', mobileRole: 'subtitle', render: (t: string) => <Text type="secondary" style={{ fontSize: 11 }}>{t}</Text> },
              ]}
            />
          </Card>
        </Col>
      )}
    </Row>
  )
}

const QLibAnalysisPanel: React.FC<{ expId: string; runId: string }> = ({ expId, runId }) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['qlib-figures', expId, runId],
    queryFn: async () => {
      console.log('[QLibAnalysisPanel] Fetching QLib figures for:', { expId, runId })
      const result = await reportService.getQLibFigures(expId, runId)
      console.log('[QLibAnalysisPanel] API response:', result)
      return result
    },
    enabled: !!expId && !!runId,
  })

  if (isLoading) return <Spin style={{ display: 'block', margin: '40px auto' }} />
  
  if (error) {
    console.error('[QLibAnalysisPanel] Error:', error)
    return <Empty description={`加载失败: ${(error as Error).message}`} style={{ padding: 40 }} />
  }
  
  if (!data?.success) {
    console.log('[QLibAnalysisPanel] API returned failure:', data)
    return <Empty description={data?.message || "无QLib分析数据"} style={{ padding: 40 }} />
  }
  
  if (!data?.data?.available) {
    console.log('[QLibAnalysisPanel] Data not available:', data?.data)
    return <Empty description="无QLib分析数据" style={{ padding: 40 }} />
  }

  const figures = data.data

  const nanoToDateString = (ns: number): string => {
    try {
      const ms = ns / 1e6
      const date = new Date(ms)
      if (isNaN(date.getTime())) return String(ns)
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    } catch {
      return String(ns)
    }
  }

  const isNanoTimestamp = (value: any): boolean => {
    if (typeof value !== 'number') return false
    return value > 1e15 && value < 2e18
  }

  const fixFigureXAxis = (fig: any, index: number): any => {
    if (!fig || !fig.data) return fig
    
    const hasHistogram = fig.data.some((trace: any) => trace?.type === 'histogram')
    
    const fixedData = fig.data.map((trace: any) => {
      if (!trace) return trace
      
      const fixedTrace = { ...trace }
      
      if (trace.type === 'histogram') {
        return fixedTrace
      }
      
      if (trace.x && Array.isArray(trace.x)) {
        const sampleValue = trace.x.find((v: any) => v !== null && v !== undefined)
        
        if (isNanoTimestamp(sampleValue)) {
          fixedTrace.x = trace.x.map((v: any) => 
            v !== null && v !== undefined ? nanoToDateString(v) : v
          )
        } else {
          const hasDateLikeValues = trace.x.some((v: any) => 
            typeof v === 'string' && (v.includes('-') || v.includes('/') || v.match(/^\d{4}/))
          )
          
          if (!hasDateLikeValues) {
            if (trace.text && Array.isArray(trace.text) && trace.text.length > 0) {
              const textSample = trace.text[0]
              if (typeof textSample === 'string' && (textSample.includes('-') || textSample.match(/^\d{4}/))) {
                fixedTrace.x = trace.text
              }
            }
          }
        }
      }
      
      return fixedTrace
    })
    
    const fixedLayout = { ...fig.layout }
    
    if (!hasHistogram) {
      if (fixedLayout.xaxis) {
        fixedLayout.xaxis = {
          ...fixedLayout.xaxis,
          type: 'category',
          tickangle: -45,
          tickfont: { size: 10 },
        }
      } else {
        fixedLayout.xaxis = {
          type: 'category',
          tickangle: -45,
          tickfont: { size: 10 },
        }
      }
      if (fixedLayout.xaxis2) {
        fixedLayout.xaxis2 = {
          ...fixedLayout.xaxis2,
          type: 'category',
          tickangle: -45,
          tickfont: { size: 10 },
        }
      }
      if (fixedLayout.xaxis3) {
        fixedLayout.xaxis3 = {
          ...fixedLayout.xaxis3,
          type: 'category',
          tickangle: -45,
          tickfont: { size: 10 },
        }
      }
      if (fixedLayout.xaxis4) {
        fixedLayout.xaxis4 = {
          ...fixedLayout.xaxis4,
          type: 'category',
          tickangle: -45,
          tickfont: { size: 10 },
        }
      }
    }
    
    return {
      ...fig,
      data: fixedData,
      layout: fixedLayout,
    }
  }

  return (
    <Row gutter={[16, 16]}>
      {figures.report_figures?.map((fig, i) => (
        <Col span={24} key={`report-${i}`}>
          <Card title={`回报分析 ${i + 1}`} size="small">
            <Plot 
              data={fig.data} 
              layout={{ ...fig.layout, height: 800, autosize: true }} 
              style={{ width: '100%', minHeight: 800 }} 
            />
          </Card>
        </Col>
      ))}
      {figures.risk_figures?.map((fig, i) => (
        <Col xs={24} lg={12} key={`risk-${i}`}>
          <Card title={`风险分析 ${i + 1}`} size="small">
            <Plot 
              data={fig.data} 
              layout={{ ...fig.layout, height: 350, autosize: true }} 
              style={{ width: '100%', minHeight: 350 }} 
            />
          </Card>
        </Col>
      ))}
      {figures.ic_figures?.map((fig, i) => {
        const fixedFig = fixFigureXAxis(fig, i)
        return (
          <Col xs={24} lg={12} key={`ic-${i}`}>
            <Card title={`IC分析 ${i + 1}`} size="small">
              <Plot 
                data={fixedFig.data} 
                layout={{ ...fixedFig.layout, height: 350, autosize: true }} 
                style={{ width: '100%', minHeight: 350 }} 
              />
            </Card>
          </Col>
        )
      })}
      {figures.model_figures?.map((fig, i) => {
        const fixedFig = fixFigureXAxis(fig, i)
        return (
          <Col xs={24} lg={12} key={`model-${i}`}>
            <Card title={`模型性能 ${i + 1}`} size="small">
              <Plot 
                data={fixedFig.data} 
                layout={{ ...fixedFig.layout, height: 350, autosize: true }} 
                style={{ width: '100%', minHeight: 350 }} 
              />
            </Card>
          </Col>
        )
      })}
    </Row>
  )
}

const ModelParamsPanel: React.FC<{ params: Record<string, unknown>; config?: Record<string, unknown> }> = ({ params, config }) => {
  const modelInfo = (params?.model as Record<string, unknown>) || {}
  const datasetInfo = (params?.dataset as Record<string, unknown>) || {}
  const segments = (params?.segments as Record<string, unknown>) || {}
  const handler = (params?.handler as Record<string, unknown>) || {}

  const renderParamTable = (data: Record<string, unknown>, title: string) => {
    const entries = Object.entries(data || {}).filter(([k]) => k !== 'class' && k !== 'module_path')
    if (entries.length === 0) return null

    return (
      <Card size="small" title={<Text strong style={{ color: '#1677ff', fontSize: 13 }}>{title}</Text>} style={{ marginBottom: 12 }}>
        <Table
          size="small"
          dataSource={entries.map(([key, val]) => ({ key, value: typeof val === 'object' ? JSON.stringify(val) : String(val) }))}
          columns={[
            { title: '参数', dataIndex: 'key', key: 'key', width: 200, render: (t: string) => <Text code style={{ color: '#6b7280', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14 }}>{t}</Text> },
            { title: '值', dataIndex: 'value', key: 'value', render: (t: string) => <Text style={{ color: '#374151', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14 }} ellipsis>{t}</Text> },
          ]}
          pagination={false}
          rowKey="key"
        />
      </Card>
    )
  }

  return (
    <div>
      <ResponsiveDescriptions
        size="small"
        bordered
        columns={{ xxl: 2, xl: 2, lg: 2, md: 2, sm: 1, xs: 1 }}
        style={{ marginBottom: 16 }}
        items={[
          { key: 'model-class', label: '模型类名', value: <span style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 13 }}>{String(modelInfo.class || '-')}</span> },
          { key: 'model-module', label: '模块路径', value: <span style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 13 }}>{String(modelInfo.module_path || '-')}</span> },
          { key: 'dataset-class', label: '数据集类名', value: <span style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 13 }}>{String(datasetInfo.class || '-')}</span> },
          { key: 'dataset-module', label: '数据集模块', value: <span style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 13 }}>{String((datasetInfo as Record<string, unknown>).module_path || '-')}</span> },
        ]}
      />

      {renderParamTable((modelInfo.kwargs as Record<string, unknown>) || {}, '模型超参数')}
      {renderParamTable(handler, 'Handler配置')}
      {renderParamTable(segments, '时间段配置')}
      {renderParamTable(params?.record_config ? params.record_config as Record<string, unknown> : {}, 'Record配置')}

      {config && (
        <Card size="small" title={<Text strong style={{ color: '#fa8c16', fontSize: 13 }}>完整配置快照</Text>}>
          <pre style={{ color: '#4b5563', fontSize: 11, maxHeight: 300, overflow: 'auto', margin: 0, fontFamily: "'SF Mono', 'Consolas', monospace", whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#fafafa', padding: 12, borderRadius: 6 }}>
            {JSON.stringify(config, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  )
}

const FullMetricsTable: React.FC<{ metrics: Record<string, unknown> }> = ({ metrics }) => {
  const entries = Object.entries(metrics || {})
  if (entries.length === 0) return <Empty description="无指标数据" style={{ padding: 40 }} />

  // 定义分组顺序和匹配规则
  const groupOrder = ['收益/风险', 'IC指标', '模型损失', '交易成本', '其他']
  
  const grouped = entries.reduce<Record<string, Array<[string, unknown]>>>((acc, [k, v]) => {
    const lowerKey = k.toLowerCase()
    let group = '其他'
    
    // 按优先级匹配分组
    if (lowerKey.includes('l2.')) {
      group = '模型损失'
    } else if (lowerKey.includes('ic') || lowerKey.includes('rank_ic')) {
      group = 'IC指标'
    } else if (
      lowerKey.includes('return') || 
      lowerKey.includes('drawdown') || 
      lowerKey.includes('sharpe') || 
      lowerKey.includes('information_ratio') || 
      lowerKey.includes('mean') || 
      lowerKey.includes('std')
    ) {
      group = '收益/风险'
    } else if (lowerKey.includes('turnover')) {
      group = '交易成本'
    }
    // ffr, pa, pos 等指标不匹配任何规则，归类到"其他"
    
    if (!acc[group]) acc[group] = []
    acc[group].push([k, v])
    return acc
  }, {})

  // 按预定义顺序排序分组
  const sortedGroups = groupOrder.filter(g => grouped[g] && grouped[g].length > 0)

  return (
    <Tabs
      defaultActiveKey="all"
      size="small"
      items={[
        { key: 'all', label: `全部 (${entries.length})`, children: (
          <Table
            size="small"
            dataSource={entries.map(([k, v]) => ({ key: k, value: typeof v === 'number' ? v.toFixed(6) : String(v) }))}
            pagination={{ pageSize: 15, size: 'small' }}
            columns={[
              { title: '指标名称', dataIndex: 'key', key: 'key', render: (t: string) => <Text code style={{ color: '#6b7280', fontSize: 13 }}>{t}</Text> },
              { title: '值', dataIndex: 'value', key: 'value', align: 'right', render: (t: string) => <Text style={{ color: '#374151', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14 }}>{t}</Text> },
            ]}
            rowKey="key"
          />
        )},
        ...sortedGroups.map((group) => ({
          key: group,
          label: `${group} (${grouped[group].length})`,
          children: (
            <Table
              size="small"
              dataSource={grouped[group].map(([k, v]) => ({ key: k, value: typeof v === 'number' ? v.toFixed(6) : String(v) }))}
              pagination={false}
              columns={[
                { title: '指标', dataIndex: 'key', key: 'key', render: (t: string) => <Text code style={{ color: '#6b7280', fontSize: 13 }}>{t}</Text> },
                { title: '值', dataIndex: 'value', key: 'value', align: 'right', render: (t: string) => <Text style={{ color: '#374151', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14 }}>{t}</Text> },
              ]}
              rowKey="key"
            />
          ),
        })),
      ]}
    />
  )
}

// Segment color configuration
const SEGMENT_CONFIG: Record<string, { color: string; bgColor: string; label: string }> = {
  train: { color: '#2196F3', bgColor: 'rgba(33,150,243,0.08)', label: '训练集' },
  valid: { color: '#FF9800', bgColor: 'rgba(255,152,0,0.08)', label: '验证集' },
  test: { color: '#4CAF50', bgColor: 'rgba(76,175,80,0.08)', label: '测试集' },
}

const InSampleMetricCard: React.FC<{
  title: string
  value: number | undefined | null
  format?: (v: number) => string
  suffix?: string
  segmentColor: string
  highlight?: boolean
  tooltip?: string
}> = ({ title, value, format, suffix = '', segmentColor, highlight = false, tooltip }) => {
  const displayValue = value == null ? '-' : (format ? format(value) : value.toFixed(4))
  const isPositive = value != null && value > 0

  const content = (
    <div style={{
      background: highlight ? '#fff7e6' : '#fafafa',
      borderRadius: 6,
      padding: '10px 14px',
      borderLeft: `3px solid ${segmentColor}`,
      transition: 'all 0.3s',
    }}>
      <Text type="secondary" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block' }}>
        {title}
      </Text>
      <span style={{
        fontSize: 16,
        fontWeight: 700,
        fontFamily: "'SF Mono', 'Consolas', monospace",
        color: value != null ? (isPositive ? '#1677ff' : '#ff4d4f') : '#9ca3af',
      }}>
        {displayValue}{suffix}
      </span>
    </div>
  )

  if (tooltip) {
    return <Tooltip title={tooltip}>{content}</Tooltip>
  }
  return content
}

const InSampleSegmentCard: React.FC<{
  segName: string
  data: InSampleSegmentResult
}> = ({ segName, data }) => {
  const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', bgColor: '#f5f5f5', label: segName }
  const rm = data.risk_metrics

  if (!rm.available) {
    return (
      <Col xs={24} lg={8}>
        <Card
          size="small"
          title={<span><Tag color={config.color}>{config.label}</Tag> 无数据</span>}
          style={{ borderLeft: `4px solid ${config.color}` }}
        >
          <Empty description="该分段暂无风险指标数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      </Col>
    )
  }

  return (
    <Col xs={24} lg={8}>
      <Card
        size="small"
        title={
          <Space>
            <Tag color={config.color} style={{ margin: 0 }}>{config.label}</Tag>
            {data.time_range && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {data.time_range[0].slice(0, 10)} ~ {data.time_range[1].slice(0, 10)}
              </Text>
            )}
          </Space>
        }
        style={{ borderLeft: `4px solid ${config.color}` }}
        styles={{ body: { background: config.bgColor } }}
      >
        {data.n_stocks != null && (
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>标的数量: </Text>
            <Text strong style={{ fontSize: 13, color: config.color }}>{data.n_stocks}</Text>
          </div>
        )}
        <Row gutter={[10, 10]}>
          <Col span={12}>
            <InSampleMetricCard
              title="总收益"
              value={rm.total_return}
              format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`}
              segmentColor={config.color}
              tooltip="复利累计: (1+r1)*(1+r2)*...*(1+rn)-1"
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="年化收益"
              value={rm.annualized_return}
              format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`}
              segmentColor={config.color}
              tooltip="复利年化: (1+累计收益)^(252/天数)-1"
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="夏普比率"
              value={rm.sharpe_ratio}
              format={(v) => v.toFixed(3)}
              segmentColor={config.color}
              tooltip="Sharpe = mean(daily_return) / std(daily_return) * sqrt(252)"
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="最大回撤"
              value={rm.max_drawdown}
              format={(v) => `${(Math.abs(v) * 100).toFixed(2)}%`}
              segmentColor={config.color}
              tooltip="复利回撤: (累计净值/历史最高净值-1)的最小值"
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="信息比率"
              value={rm.information_ratio}
              format={(v) => v.toFixed(3)}
              segmentColor={config.color}
              tooltip="IR = mean(策略收益-基准收益) / std(策略收益-基准收益) * sqrt(252)"
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="年化波动率"
              value={rm.annualized_volatility}
              format={(v) => `${(v * 100).toFixed(2)}%`}
              segmentColor={config.color}
              tooltip="std(daily_return) * sqrt(252)"
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="胜率"
              value={rm.win_rate}
              format={(v) => `${(v * 100).toFixed(1)}%`}
              segmentColor={config.color}
              tooltip="日收益>0的比例"
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="超额年化收益"
              value={rm.excess_annualized_return}
              format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`}
              segmentColor={config.color}
              tooltip="策略年化收益 - 基准年化收益"
            />
          </Col>
        </Row>

        {data.indicator_dict && Object.keys(data.indicator_dict).length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>额外指标</Text>
            <Table
              size="small"
              dataSource={Object.entries(data.indicator_dict).map(([k, v]) => ({
                key: k,
                value: typeof v === 'number' ? v.toFixed(6) : String(v),
              }))}
              pagination={false}
              columns={[
                { title: '指标', dataIndex: 'key', key: 'key', render: (t: string) => <Text code style={{ fontSize: 11 }}>{t}</Text> },
                { title: '值', dataIndex: 'value', key: 'value', align: 'right', render: (t: string) => <Text style={{ fontSize: 12, fontFamily: "'SF Mono', 'Consolas', monospace" }}>{t}</Text> },
              ]}
              rowKey="key"
              scroll={{ y: 120 }}
            />
          </div>
        )}
      </Card>
    </Col>
  )
}

// 新增：三阶段累计收益率对比曲线图
const InSampleCumulativeReturnChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  // 按照固定顺序处理：train -> valid -> test
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])
  
  if (orderedSegmentNames.length === 0) {
    return <Empty description="无数据" style={{ padding: 40 }} />
  }

  // 收集所有阶段的日收益率数据，按日期排序
  const allDailyReturns: Array<{ date: string; dailyReturn: number; segment: string; rawDate: Date }> = []

  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const portfolio = segData.portfolio_data

    if (!portfolio?.available || !portfolio.dates || !portfolio.daily_return?.strategy) {
      return
    }

    const dates = portfolio.dates
    const dailyReturns = portfolio.daily_return.strategy

    dates.forEach((date, i) => {
      if (dailyReturns[i] != null) {
        allDailyReturns.push({
          date,
          dailyReturn: dailyReturns[i],
          segment: segName,
          rawDate: new Date(date),
        })
      }
    })
  })

  if (allDailyReturns.length === 0) {
    return <Empty description="无有效数据" style={{ padding: 40 }} />
  }

  // 按日期排序所有数据
  allDailyReturns.sort((a, b) => a.rawDate.getTime() - b.rawDate.getTime())

  // 计算累计收益率（从1开始）
  let cumulativeValue = 1
  const allData: Array<{ date: string; cumulativeReturn: number; segment: string }> = []
  const segmentBoundaries: Array<{ startIndex: number; segment: string; color: string; startDate: string }> = []

  let lastSegment = ''
  allDailyReturns.forEach((item, idx) => {
    cumulativeValue *= (1 + item.dailyReturn)
    allData.push({
      date: item.date,
      cumulativeReturn: cumulativeValue,
      segment: item.segment,
    })

    // 记录阶段边界
    if (item.segment !== lastSegment) {
      const config = SEGMENT_CONFIG[item.segment] || { color: '#8c8c8c', label: item.segment }
      segmentBoundaries.push({
        startIndex: idx,
        segment: config.label,
        color: config.color,
        startDate: item.date,
      })
      lastSegment = item.segment
    }
  })

  // 准备图表数据
  const dates = allData.map(d => d.date)
  const values = allData.map(d => d.cumulativeReturn)

  // 构建垂直分隔线
  const markLineData: Array<{ xAxis: string; name: string; lineStyle: any }> = []
  segmentBoundaries.forEach((boundary, idx) => {
    if (idx > 0 && boundary.startIndex < dates.length) {
      markLineData.push({
        xAxis: dates[boundary.startIndex],
        name: boundary.segment,
        lineStyle: {
          color: boundary.color,
          type: 'dashed',
          width: 2,
        },
      })
    }
  })

  const formatPercent = (value: number) => {
    return `${((value - 1) * 100).toFixed(2)}%`
  }

  return (
    <ReactECharts
      option={{
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
          formatter: (params: any) => {
            if (!params || !params.length) return ''
            const date = params[0].name
            const value = params[0].value as number
            const dataIndex = params[0].dataIndex
            // 找到对应的 segment
            let segmentLabel = ''
            for (let i = segmentBoundaries.length - 1; i >= 0; i--) {
              if (dataIndex >= segmentBoundaries[i].startIndex) {
                segmentLabel = segmentBoundaries[i].segment
                break
              }
            }
            return `${date}<br/>${segmentLabel}<br/>累计收益: ${formatPercent(value)}`
          },
        },
        legend: {
          data: segmentBoundaries.map(b => b.segment),
          textStyle: { color: '#6b7280' },
          top: 0,
        },
        grid: { left: 70, right: 30, top: 40, bottom: 60 },
        xAxis: {
          type: 'category',
          data: dates,
          axisLabel: {
            color: '#9ca3af',
            fontSize: 10,
            rotate: 45,
          },
          axisLine: { lineStyle: { color: '#e5e7eb' } },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          axisLabel: {
            color: '#9ca3af',
            formatter: formatPercent,
          },
          splitLine: { lineStyle: { color: '#f0f0f0' } },
        },
        series: [
          {
            name: '累计收益',
            type: 'line',
            data: values,
            lineStyle: { width: 2.5, color: '#1677ff' },
            itemStyle: { color: '#1677ff' },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(22,119,255,0.15)' },
                  { offset: 1, color: 'rgba(22,119,255,0)' },
                ],
              },
            },
            markLine: {
              silent: true,
              symbol: 'none',
              data: markLineData,
              label: {
                show: true,
                formatter: '{b}',
                position: 'start',
                color: '#6b7280',
                fontSize: 10,
              },
            },
          },
        ],
        dataZoom: [
          {
            type: 'slider',
            start: 0,
            end: 100,
            height: 20,
            bottom: 5,
            borderColor: '#e5e7eb',
            fillerColor: 'rgba(22,119,255,0.1)',
            handleStyle: { color: '#1677ff' },
          },
          { type: 'inside', start: 0, end: 100 },
        ],
      }}
      style={{ height: 350 }}
      notMerge={true}
    />
  )
}

// 新增：三阶段回撤对比曲线图
const InSampleDrawdownChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  // 按照固定顺序处理：train -> valid -> test
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])

  // 收集所有阶段的回撤数据，按日期排序
  const allDrawdowns: Array<{ date: string; drawdown: number; segment: string; rawDate: Date }> = []
  const segmentBoundaries: Array<{ startIndex: number; segment: string; color: string }> = []

  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const portfolio = segData.portfolio_data

    if (!portfolio?.available || !portfolio.dates || !portfolio.drawdown?.strategy) {
      return
    }

    const dates = portfolio.dates
    const drawdowns = portfolio.drawdown.strategy

    dates.forEach((date, i) => {
      if (drawdowns[i] != null) {
        allDrawdowns.push({
          date,
          drawdown: drawdowns[i],
          segment: segName,
          rawDate: new Date(date),
        })
      }
    })
  })

  if (allDrawdowns.length === 0) {
    return <Empty description="无回撤数据" style={{ padding: 40 }} />
  }

  // 按日期排序
  allDrawdowns.sort((a, b) => a.rawDate.getTime() - b.rawDate.getTime())

  // 记录阶段边界
  let lastSegment = ''
  allDrawdowns.forEach((item, idx) => {
    if (item.segment !== lastSegment) {
      const config = SEGMENT_CONFIG[item.segment] || { color: '#8c8c8c', label: item.segment }
      segmentBoundaries.push({
        startIndex: idx,
        segment: config.label,
        color: config.color,
      })
      lastSegment = item.segment
    }
  })

  const dates = allDrawdowns.map(d => d.date)
  const values = allDrawdowns.map(d => d.drawdown)

  // 构建垂直分隔线
  const markLineData: Array<{ xAxis: string; name: string; lineStyle: any }> = []
  segmentBoundaries.forEach((boundary, idx) => {
    if (idx > 0 && boundary.startIndex < dates.length) {
      markLineData.push({
        xAxis: dates[boundary.startIndex],
        name: boundary.segment,
        lineStyle: {
          color: boundary.color,
          type: 'dashed',
          width: 2,
        },
      })
    }
  })

  return (
    <ReactECharts
      option={{
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
          formatter: (params: any) => {
            if (!params || !params.length) return ''
            const date = params[0].name
            const value = params[0].value as number
            return `${date}<br/>回撤: ${(value * 100).toFixed(2)}%`
          },
        },
        legend: {
          data: segmentBoundaries.map(b => b.segment),
          textStyle: { color: '#6b7280' },
          top: 0,
        },
        grid: { left: 70, right: 30, top: 40, bottom: 30 },
        xAxis: {
          type: 'category',
          data: dates,
          axisLabel: { color: '#9ca3af', fontSize: 10 },
          axisLine: { lineStyle: { color: '#e5e7eb' } },
        },
        yAxis: {
          type: 'value',
          axisLabel: {
            color: '#9ca3af',
            formatter: (value: number) => `${(value * 100).toFixed(1)}%`,
          },
          splitLine: { lineStyle: { color: '#f0f0f0' } },
        },
        series: [
          {
            name: '回撤',
            type: 'line',
            data: values,
            lineStyle: { width: 2, color: '#ff4d4f' },
            itemStyle: { color: '#ff4d4f' },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(255,77,79,0.15)' },
                  { offset: 1, color: 'rgba(255,77,79,0)' },
                ],
              },
            },
            markLine: {
              silent: true,
              symbol: 'none',
              data: markLineData,
              label: {
                show: true,
                formatter: '{b}',
                position: 'start',
                color: '#6b7280',
                fontSize: 10,
              },
            },
          },
        ],
        dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      }}
      style={{ height: 280 }}
    />
  )
}

// 新增：三阶段日收益率分布对比图
const InSampleDailyReturnDistributionChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const series: Array<Record<string, unknown>> = []

  // 按照固定顺序处理：train -> valid -> test
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])

  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
    const dist = segData.daily_return_distribution

    if (!dist?.available || !dist.histogram) {
      return
    }

    series.push({
      name: config.label,
      type: 'bar',
      data: dist.histogram.counts,
      itemStyle: { color: config.color, borderRadius: [2, 2, 0, 0] },
      barWidth: '25%',
    })
  })

  if (series.length === 0) {
    return <Empty description="无日收益率分布数据" style={{ padding: 40 }} />
  }

  // 使用第一个 segment 的 bin_centers 作为 x 轴
  const firstSegmentName = orderedSegmentNames[0]
  const binCenters = segments[firstSegmentName]?.daily_return_distribution?.histogram?.bin_centers || []

  return (
    <ReactECharts
      option={{
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
          axisPointer: { type: 'shadow' },
        },
        legend: {
          data: series.map(s => s.name as string),
          textStyle: { color: '#6b7280' },
          top: 0,
        },
        grid: { left: 70, right: 30, top: 40, bottom: 50 },
        xAxis: {
          type: 'category',
          data: binCenters.map((v: number) => (v * 100).toFixed(2)),
          axisLabel: {
            color: '#9ca3af',
            fontSize: 9,
            rotate: 45,
            formatter: (value: string) => `${value}%`,
          },
          axisLine: { lineStyle: { color: '#e5e7eb' } },
          name: '日收益率',
          nameLocation: 'middle',
          nameGap: 35,
          nameTextStyle: { color: '#6b7280' },
        },
        yAxis: {
          type: 'value',
          axisLabel: { color: '#9ca3af' },
          splitLine: { lineStyle: { color: '#f0f0f0' } },
          name: '频次',
          nameLocation: 'middle',
          nameGap: 50,
          nameTextStyle: { color: '#6b7280' },
        },
        series,
      }}
      style={{ height: 280 }}
    />
  )
}

// 新增：三阶段换手率对比图
const InSampleTurnoverChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  // 按照固定顺序处理：train -> valid -> test
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])

  // 收集所有阶段的换手率数据，按日期排序
  const allTurnovers: Array<{ date: string; turnover: number; segment: string; rawDate: Date }> = []
  const segmentBoundaries: Array<{ startIndex: number; segment: string; color: string }> = []

  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const portfolio = segData.portfolio_data

    if (!portfolio?.available || !portfolio.dates || !portfolio.turnover) {
      return
    }

    const dates = portfolio.dates
    const turnovers = portfolio.turnover

    dates.forEach((date, i) => {
      if (turnovers[i] != null) {
        allTurnovers.push({
          date,
          turnover: turnovers[i],
          segment: segName,
          rawDate: new Date(date),
        })
      }
    })
  })

  if (allTurnovers.length === 0) {
    return <Empty description="无换手率数据" style={{ padding: 40 }} />
  }

  // 按日期排序
  allTurnovers.sort((a, b) => a.rawDate.getTime() - b.rawDate.getTime())

  // 记录阶段边界
  let lastSegment = ''
  allTurnovers.forEach((item, idx) => {
    if (item.segment !== lastSegment) {
      const config = SEGMENT_CONFIG[item.segment] || { color: '#8c8c8c', label: item.segment }
      segmentBoundaries.push({
        startIndex: idx,
        segment: config.label,
        color: config.color,
      })
      lastSegment = item.segment
    }
  })

  const dates = allTurnovers.map(d => d.date)
  const values = allTurnovers.map(d => d.turnover)

  // 构建垂直分隔线
  const markLineData: Array<{ xAxis: string; name: string; lineStyle: any }> = []
  segmentBoundaries.forEach((boundary, idx) => {
    if (idx > 0 && boundary.startIndex < dates.length) {
      markLineData.push({
        xAxis: dates[boundary.startIndex],
        name: boundary.segment,
        lineStyle: {
          color: boundary.color,
          type: 'dashed',
          width: 2,
        },
      })
    }
  })

  return (
    <ReactECharts
      option={{
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
          formatter: (params: any) => {
            if (!params || !params.length) return ''
            const date = params[0].name
            const value = params[0].value as number
            return `${date}<br/>换手率: ${(value * 100).toFixed(2)}%`
          },
        },
        legend: {
          data: segmentBoundaries.map(b => b.segment),
          textStyle: { color: '#6b7280' },
          top: 0,
        },
        grid: { left: 70, right: 30, top: 40, bottom: 30 },
        xAxis: {
          type: 'category',
          data: dates,
          axisLabel: { color: '#9ca3af', fontSize: 10 },
          axisLine: { lineStyle: { color: '#e5e7eb' } },
        },
        yAxis: {
          type: 'value',
          axisLabel: {
            color: '#9ca3af',
            formatter: '{value}%',
          },
          splitLine: { lineStyle: { color: '#f0f0f0' } },
        },
        series: [
          {
            name: '换手率',
            type: 'line',
            data: values,
            lineStyle: { width: 1.5, color: '#52c41a' },
            itemStyle: { color: '#52c41a' },
            symbol: 'none',
            markLine: {
              silent: true,
              symbol: 'none',
              data: markLineData,
              label: {
                show: true,
                formatter: '{b}',
                position: 'start',
                color: '#6b7280',
                fontSize: 10,
              },
            },
          },
        ],
        dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      }}
      style={{ height: 280 }}
    />
  )
}

// 新增：风险指标雷达图
const InSampleRadarChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const indicators = [
    { name: '年化收益', max: 1 },
    { name: '夏普比率', max: 3 },
    { name: '信息比率', max: 2 },
    { name: '胜率', max: 1 },
    { name: '最大回撤', max: 0.5 },
  ]

  const seriesData: Array<{ value: number[]; name: string; itemStyle: any }> = []

  // 按照固定顺序处理：train -> valid -> test
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])

  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
    const rm = segData.risk_metrics

    if (!rm.available) return

    // 归一化指标值
    const annReturn = rm.annualized_return != null ? Math.min(Math.max(rm.annualized_return, -1), 1) : 0
    const sharpe = rm.sharpe_ratio != null ? Math.min(Math.max(rm.sharpe_ratio / 3, 0), 1) : 0
    const ir = rm.information_ratio != null ? Math.min(Math.max(rm.information_ratio / 2, 0), 1) : 0
    const winRate = rm.win_rate != null ? rm.win_rate : 0.5
    // 最大回撤：取绝对值，归一化到0-0.5范围
    const maxDrawdown = rm.max_drawdown != null ? Math.min(Math.abs(rm.max_drawdown), 0.5) : 0

    seriesData.push({
      value: [annReturn, sharpe * 3, ir * 2, winRate, maxDrawdown],
      name: config.label,
      itemStyle: { color: config.color },
    })
  })

  if (seriesData.length === 0) {
    return <Empty description="无风险指标数据" style={{ padding: 40 }} />
  }

  return (
    <ReactECharts
      option={{
        tooltip: {
          trigger: 'item',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
        },
        legend: {
          data: seriesData.map(s => s.name),
          textStyle: { color: '#6b7280' },
          top: 0,
        },
        radar: {
          indicator: indicators,
          shape: 'polygon',
          splitNumber: 5,
          axisName: {
            color: '#6b7280',
            fontSize: 11,
          },
          splitLine: {
            lineStyle: { color: '#e5e7eb' },
          },
          splitArea: {
            show: true,
            areaStyle: {
              color: ['rgba(22,119,255,0.02)', 'rgba(22,119,255,0.05)'],
            },
          },
          axisLine: {
            lineStyle: { color: '#e5e7eb' },
          },
        },
        series: [{
          type: 'radar',
          data: seriesData,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.1 },
        }],
      }}
      style={{ height: 320 }}
    />
  )
}

// 新增：指标对比表格
const InSampleMetricsComparisonTable: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  // 按照固定顺序处理：train -> valid -> test
  const segmentNames = ['train', 'valid', 'test'].filter(name => segments[name])
  
  if (segmentNames.length === 0) {
    return <Empty description="无数据" style={{ padding: 40 }} />
  }

  const metrics = [
    { key: 'total_return', label: '总收益', format: (v: number) => `${(v * 100).toFixed(2)}%` },
    { key: 'annualized_return', label: '年化收益', format: (v: number) => `${(v * 100).toFixed(2)}%` },
    { key: 'sharpe_ratio', label: '夏普比率', format: (v: number) => v.toFixed(3) },
    { key: 'max_drawdown', label: '最大回撤', format: (v: number) => `${(Math.abs(v) * 100).toFixed(2)}%` },
    { key: 'information_ratio', label: '信息比率', format: (v: number) => v.toFixed(3) },
    { key: 'annualized_volatility', label: '年化波动率', format: (v: number) => `${(v * 100).toFixed(2)}%` },
    { key: 'win_rate', label: '胜率', format: (v: number) => `${(v * 100).toFixed(1)}%` },
    { key: 'excess_annualized_return', label: '超额年化收益', format: (v: number) => `${(v * 100).toFixed(2)}%` },
    { key: 'mean_turnover', label: '平均换手率', format: (v: number) => `${(v * 100).toFixed(2)}%` },
  ]

  const columns = [
    {
      title: '指标',
      dataIndex: 'metric',
      key: 'metric',
      fixed: 'left' as const,
      width: 140,
      render: (text: string) => <Text strong style={{ color: '#374151' }}>{text}</Text>,
    },
    ...segmentNames.map(segName => {
      const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
      return {
        title: <Tag color={config.color}>{config.label}</Tag>,
        dataIndex: segName,
        key: segName,
        align: 'right' as const,
        render: (value: string | number, record: any) => {
          const metricKey = record.key
          const rm = segments[segName].risk_metrics
          const rawValue = rm[metricKey as keyof typeof rm]
          const numValue = typeof rawValue === 'number' ? rawValue : null
          const isNegative = numValue != null && numValue < 0
          // 最大回撤不需要红色高亮（负值是正常的）
          const shouldHighlight = isNegative && metricKey !== 'max_drawdown'
          
          return (
            <Text 
              style={{ 
                fontFamily: "'SF Mono', 'Consolas', monospace", 
                fontSize: 13,
                color: shouldHighlight ? '#cf1322' : undefined,
                fontWeight: shouldHighlight ? 600 : undefined,
              }}
            >
              {value}
            </Text>
          )
        },
      }
    }),
  ]

  const dataSource = metrics.map(metric => {
    const row: Record<string, any> = {
      key: metric.key,
      metric: metric.label,
    }
    segmentNames.forEach(segName => {
      const rm = segments[segName].risk_metrics
      const value = rm[metric.key as keyof typeof rm]
      row[segName] = value != null ? metric.format(value as number) : '-'
    })
    return row
  })

  return (
    <Table
      size="small"
      dataSource={dataSource}
      columns={columns}
      pagination={false}
      scroll={{ x: 'max-content' }}
      bordered
    />
  )
}

// 新增：特征重要性图表组件
const FeatureImportanceChart: React.FC<{ data: FeatureImportanceData }> = ({ data }) => {
  const [sortBy, setSortBy] = useState<'gain' | 'split'>('gain')
  const [topN, setTopN] = useState(20)
  const [selectedFactor, setSelectedFactor] = useState<string | null>(null)
  const [modalVisible, setModalVisible] = useState(false)
  const [factorDescriptions, setFactorDescriptions] = useState<Record<string, string>>({})

  // 获取因子描述
  useEffect(() => {
    const fetchDescriptions = async () => {
      try {
        const response = await factorDocService.getAlpha158Docs()
        if (response.success && response.data?.factors) {
          const descMap: Record<string, string> = {}
          response.data.factors.forEach(f => {
            descMap[f.name] = f.description
          })
          setFactorDescriptions(descMap)
        }
      } catch (e) {
        console.log('Failed to fetch factor descriptions', e)
      }
    }
    fetchDescriptions()
  }, [])

  if (!data?.available) {
    return (
      <Empty 
        description={data?.error || "无特征重要性数据"} 
        style={{ padding: 40 }} 
      />
    )
  }

  if (!data.features?.length) {
    return <Empty description="无特征数据" style={{ padding: 40 }} />
  }

  const sortedFeatures = [...data.features]
    .sort((a, b) => sortBy === 'gain' 
      ? b.importance_gain - a.importance_gain 
      : b.importance_split - a.importance_split
    )
    .slice(0, topN)

  const featureNames = sortedFeatures.map(f => f.name)
  const gainValues = sortedFeatures.map(f => f.importance_gain)
  const splitValues = sortedFeatures.map(f => f.importance_split)

  const maxGain = Math.max(...gainValues) || 1
  const maxSplit = Math.max(...splitValues) || 1

  const handleChartClick = (params: any) => {
    if (params && params.name) {
      setSelectedFactor(params.name)
      setModalVisible(true)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center' }}>
        <Space>
          <Text type="secondary">排序方式:</Text>
          <Select value={sortBy} onChange={setSortBy} style={{ width: 120 }} size="small">
            <Select.Option value="gain">Gain Importance</Select.Option>
            <Select.Option value="split">Split Importance</Select.Option>
          </Select>
        </Space>
        <Space>
          <Text type="secondary">显示数量:</Text>
          <Select value={topN} onChange={setTopN} style={{ width: 80 }} size="small">
            <Select.Option value={10}>Top 10</Select.Option>
            <Select.Option value={20}>Top 20</Select.Option>
            <Select.Option value={30}>Top 30</Select.Option>
            <Select.Option value={50}>Top 50</Select.Option>
          </Select>
        </Space>
        <Text type="secondary" style={{ fontSize: 11 }}>
          模型类型: <Tag color="blue">{data.model_type}</Tag>
          总特征数: <Tag>{data.total_features}</Tag>
        </Text>
        <Tooltip title="点击柱子查看因子详情">
          <InfoCircleOutlined style={{ color: '#1677ff' }} />
        </Tooltip>
      </div>

      <ReactECharts
        option={{
          tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
            backgroundColor: '#fff',
            borderColor: '#e8e8e8',
            textStyle: { color: '#374151' },
            formatter: (params: any) => {
              if (!params || params.length < 2) return ''
              const name = params[0].name
              const gain = params[0].value
              const split = params[1].value
              const desc = factorDescriptions[name]
              const descHtml = desc ? `<div style="color:#6b7280;font-size:11px;margin-top:4px;max-width:300px;white-space:normal;">${desc}</div>` : ''
              return `<div style="font-weight:600">${name}</div>Gain: ${gain.toFixed(2)}<br/>Split: ${split}${descHtml}<div style="color:#1677ff;font-size:11px;margin-top:4px">点击查看因子详情</div>`
            },
          },
          legend: {
            data: ['Gain Importance', 'Split Importance'],
            textStyle: { color: '#6b7280' },
            top: 0,
          },
          grid: { left: 180, right: 50, top: 40, bottom: 30 },
          xAxis: [
            {
              type: 'value',
              name: 'Gain',
              nameTextStyle: { color: '#6b7280' },
              axisLabel: { color: '#9ca3af', formatter: (v: number) => v.toFixed(0) },
              splitLine: { lineStyle: { color: '#f0f0f0' } },
              max: Math.ceil(maxGain * 1.1),
            },
            {
              type: 'value',
              name: 'Split',
              nameTextStyle: { color: '#6b7280' },
              axisLabel: { color: '#9ca3af', formatter: (v: number) => v.toFixed(0) },
              splitLine: { show: false },
              max: Math.ceil(maxSplit * 1.1),
            },
          ],
          yAxis: {
            type: 'category',
            data: featureNames,
            axisLabel: { 
              color: '#374151', 
              fontSize: 11,
              width: 160,
              overflow: 'truncate',
            },
            axisLine: { lineStyle: { color: '#e5e7eb' } },
          },
          series: [
            {
              name: 'Gain Importance',
              type: 'bar',
              data: gainValues,
              barWidth: '35%',
              itemStyle: { 
                color: {
                  type: 'linear',
                  x: 0, y: 0, x2: 1, y2: 0,
                  colorStops: [
                    { offset: 0, color: '#1677ff' },
                    { offset: 1, color: '#69b1ff' },
                  ],
                },
                borderRadius: [0, 2, 2, 0],
              },
            },
            {
              name: 'Split Importance',
              type: 'bar',
              xAxisIndex: 1,
              data: splitValues,
              barWidth: '35%',
              itemStyle: { 
                color: {
                  type: 'linear',
                  x: 0, y: 0, x2: 1, y2: 0,
                  colorStops: [
                    { offset: 0, color: '#52c41a' },
                    { offset: 1, color: '#95de64' },
                  ],
                },
                borderRadius: [0, 2, 2, 0],
              },
            },
          ],
        }}
        style={{ height: Math.max(400, topN * 20) }}
        notMerge={true}
        onEvents={{ click: handleChartClick }}
      />
      
      <FactorInfoModal
        visible={modalVisible}
        factorName={selectedFactor}
        onClose={() => setModalVisible(false)}
      />
    </div>
  )
}

// 新增：SHAP Summary Plot 组件
const SHAPSummaryPlot: React.FC<{ data: SHAPAnalysisData }> = ({ data }) => {
  const [topN, setTopN] = useState(15)

  if (!data?.available) {
    return (
      <Empty 
        description={data?.error || "无SHAP分析数据"} 
        style={{ padding: 40 }} 
      />
    )
  }

  if (!data.shap_values?.length || !data.feature_names?.length) {
    return <Empty description="SHAP数据不完整" style={{ padding: 40 }} />
  }

  const shapValues = data.shap_values
  const featureValues = data.feature_values || []
  const featureNames = data.feature_names

  const featureStats = data.feature_stats || {}
  const sortedFeatures = Object.entries(featureStats)
    .sort((a, b) => (b[1] as any).mean_abs_shap - (a[1] as any).mean_abs_shap)
    .slice(0, topN)
    .map(([name]) => name)

  if (sortedFeatures.length === 0) {
    return <Empty description="无有效特征数据" style={{ padding: 40 }} />
  }

  const plotData: Array<{
    feature: string
    shap: number
    value: number
    sampleIndex: number
  }> = []

  sortedFeatures.forEach(featureName => {
    const featureIdx = featureNames.indexOf(featureName)
    if (featureIdx === -1) return

    for (let i = 0; i < shapValues.length; i++) {
      const shapVal = shapValues[i][featureIdx]
      const featVal = featureValues[i]?.[featureIdx] ?? 0

      if (shapVal != null && !isNaN(shapVal)) {
        plotData.push({
          feature: featureName,
          shap: shapVal,
          value: featVal,
          sampleIndex: i,
        })
      }
    }
  })

  const allValues = plotData.map(d => d.value).filter(v => !isNaN(v))
  const valueMin = Math.min(...allValues)
  const valueMax = Math.max(...allValues)
  const valueRange = valueMax - valueMin || 1

  const visualMapPieces = [
    { min: valueMin, max: valueMin + valueRange * 0.5, color: '#3b82f6', label: '低' },
    { min: valueMin + valueRange * 0.5, max: valueMax, color: '#ef4444', label: '高' },
  ]

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center' }}>
        <Space>
          <Text type="secondary">显示特征数:</Text>
          <Select value={topN} onChange={setTopN} style={{ width: 100 }} size="small">
            <Select.Option value={10}>Top 10</Select.Option>
            <Select.Option value={15}>Top 15</Select.Option>
            <Select.Option value={20}>Top 20</Select.Option>
          </Select>
        </Space>
        <Text type="secondary" style={{ fontSize: 11 }}>
          样本数: <Tag>{data.sample_size}</Tag>
          基准值: <Tag color="purple">{data.base_value?.toFixed(4) || '-'}</Tag>
        </Text>
      </div>

      <ReactECharts
        option={{
          tooltip: {
            trigger: 'item',
            backgroundColor: '#fff',
            borderColor: '#e8e8e8',
            textStyle: { color: '#374151' },
            formatter: (params: any) => {
              const d = params.data
              return `${d[3]}<br/>SHAP: ${d[0].toFixed(4)}<br/>特征值: ${d[1].toFixed(4)}`
            },
          },
          grid: { left: 180, right: 60, top: 20, bottom: 40 },
          xAxis: {
            type: 'value',
            name: 'SHAP Value',
            nameLocation: 'middle',
            nameGap: 25,
            nameTextStyle: { color: '#6b7280' },
            axisLabel: { color: '#9ca3af' },
            splitLine: { lineStyle: { color: '#f0f0f0' } },
          },
          yAxis: {
            type: 'category',
            data: sortedFeatures,
            inverse: true,
            axisLabel: { color: '#374151', fontSize: 11 },
            axisLine: { lineStyle: { color: '#e5e7eb' } },
          },
          visualMap: {
            min: valueMin,
            max: valueMax,
            dimension: 1,
            orient: 'vertical',
            right: 10,
            top: 'center',
            text: ['高', '低'],
            textStyle: { color: '#6b7280' },
            inRange: {
              color: ['#3b82f6', '#93c5fd', '#fca5a5', '#ef4444'],
            },
            calculable: true,
          },
          series: [
            {
              type: 'scatter',
              data: plotData.map(d => [
                d.shap,
                d.value,
                d.sampleIndex,
                d.feature,
              ]),
              symbolSize: 5,
              encode: { x: 0, y: 3 },
              itemStyle: {
                opacity: 0.6,
              },
            },
          ],
        }}
        style={{ height: Math.max(400, topN * 25) }}
        notMerge={true}
      />

      <div style={{ marginTop: 16, padding: 12, background: '#fafafa', borderRadius: 6 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          <strong>说明：</strong>
          每个点代表一个样本。X轴为SHAP值（正值表示正向贡献，负值表示负向贡献）。
          颜色表示特征值高低（红色=高值，蓝色=低值）。
          特征按平均|SHAP|值排序。
        </Text>
      </div>
    </div>
  )
}

// 新增：SHAP 依赖图组件
const SHAPDependencePlot: React.FC<{ 
  data: SHAPAnalysisData
  selectedFeature: string
}> = ({ data, selectedFeature }) => {
  if (!data?.available || !data.shap_values?.length || !selectedFeature) {
    return <Empty description="请选择特征查看依赖图" style={{ padding: 40 }} />
  }

  const featureIdx = data.feature_names.indexOf(selectedFeature)
  if (featureIdx === -1) {
    return <Empty description="特征不存在" style={{ padding: 40 }} />
  }

  const plotData: Array<[number, number, number]> = []
  for (let i = 0; i < data.shap_values.length; i++) {
    const shapVal = data.shap_values[i][featureIdx]
    const featVal = data.feature_values?.[i]?.[featureIdx]
    if (shapVal != null && featVal != null && !isNaN(shapVal) && !isNaN(featVal)) {
      plotData.push([featVal, shapVal, i])
    }
  }

  if (plotData.length === 0) {
    return <Empty description="无有效数据点" style={{ padding: 40 }} />
  }

  const featValues = plotData.map(d => d[0])
  const featMin = Math.min(...featValues)
  const featMax = Math.max(...featValues)

  return (
    <div>
      <ReactECharts
        option={{
          tooltip: {
            trigger: 'item',
            backgroundColor: '#fff',
            borderColor: '#e8e8e8',
            textStyle: { color: '#374151' },
            formatter: (params: any) => {
              const d = params.data
              return `特征值: ${d[0].toFixed(4)}<br/>SHAP: ${d[1].toFixed(4)}`
            },
          },
          grid: { left: 70, right: 60, top: 20, bottom: 50 },
          xAxis: {
            type: 'value',
            name: selectedFeature,
            nameLocation: 'middle',
            nameGap: 30,
            nameTextStyle: { color: '#6b7280' },
            axisLabel: { color: '#9ca3af' },
            splitLine: { lineStyle: { color: '#f0f0f0' } },
          },
          yAxis: {
            type: 'value',
            name: 'SHAP Value',
            nameLocation: 'middle',
            nameGap: 45,
            nameTextStyle: { color: '#6b7280' },
            axisLabel: { color: '#9ca3af' },
            splitLine: { lineStyle: { color: '#f0f0f0' } },
          },
          visualMap: {
            min: featMin,
            max: featMax,
            dimension: 0,
            orient: 'vertical',
            right: 10,
            top: 'center',
            text: ['高', '低'],
            textStyle: { color: '#6b7280' },
            inRange: {
              color: ['#3b82f6', '#ef4444'],
            },
            calculable: true,
          },
          series: [
            {
              type: 'scatter',
              data: plotData,
              symbolSize: 6,
              itemStyle: { opacity: 0.7 },
            },
          ],
        }}
        style={{ height: 350 }}
        notMerge={true}
      />
    </div>
  )
}

// Lag IC 衰减曲线组件
const LagICDecayCurve: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const lags = [1, 2, 3, 5, 10]
  const orderedSegs = ['train', 'valid', 'test'].filter(s => segments[s])

  const hasAnyData = orderedSegs.some(seg => {
    const lagIC = segments[seg].lag_ic as LagICAnalysis | undefined
    return lagIC && Object.keys(lagIC).length > 0
  })

  const explanationTooltip = (
    <div style={{ maxWidth: 380, lineHeight: 1.7 }}>
      <div style={{ fontWeight: 'bold', marginBottom: 6 }}>Lag IC 衰减曲线 — 原理与解读</div>
      <div><b>计算对象：</b>LightGBM 模型每日输出的截面预测得分（prediction score）</div>
      <div><b>计算方法：</b>将 N 天前的预测得分与今天的真实收益（label）计算 Spearman IC</div>
      <div style={{ marginTop: 4 }}><b>如何解读：</b></div>
      <ul style={{ paddingLeft: 16, margin: '2px 0' }}>
        <li><b>Lag=1：</b>昨天的预测今天还有多少预测力（= 模型信号 1 日残留有效性）</li>
        <li><b>Lag=5：</b>5 日前的信号是否仍有统计显著性</li>
        <li><b>衰减越快</b>（IC 随 lag 增大快速降至 0）→ 信号短效，当前 T+1 日调仓频率合理</li>
        <li><b>衰减缓慢</b>（高 lag 仍有较高 IC）→ 信号存在持续性，可考虑降低换手频率</li>
      </ul>
      <div style={{ marginTop: 4, color: '#faad14' }}>⚠ 各 segment 均在本 segment 时间范围内独立计算</div>
    </div>
  )

  if (!hasAnyData) {
    return <Empty description="暂无 Lag IC 数据（需重新运行 In-Sample 回测）" style={{ padding: 40 }} />
  }

  const series = orderedSegs.map(segName => {
    const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
    const lagIC = (segments[segName].lag_ic || {}) as LagICAnalysis
    const data = lags.map(lag => {
      const entry = lagIC[String(lag)]
      return entry ? parseFloat(entry.mean_ic.toFixed(4)) : null
    })
    return {
      name: config.label,
      type: 'line',
      data,
      itemStyle: { color: config.color },
      lineStyle: { color: config.color, width: 2 },
      symbol: 'circle',
      symbolSize: 8,
    }
  })

  const option = {
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#e8e8e8',
      textStyle: { color: '#374151' },
      formatter: (params: any[]) => {
        if (!params?.length) return ''
        const lag = lags[params[0].dataIndex]
        let lines = [`<b>Lag ${lag} 天</b>`]
        params.forEach(p => {
          if (p.value === null || p.value === undefined) return
          const segKey = orderedSegs[p.seriesIndex]
          const entry = ((segments[segKey]?.lag_ic || {}) as LagICAnalysis)[String(lag)]
          lines.push(
            `${p.marker}${p.seriesName}: Mean IC = <b>${p.value}</b>` +
            (entry ? `，Std = ${entry.std_ic.toFixed(4)}，N = ${entry.n_dates}` : '')
          )
        })
        return lines.join('<br/>')
      },
    },
    legend: {
      data: orderedSegs.map(s => (SEGMENT_CONFIG[s] || { label: s }).label),
      textStyle: { color: '#6b7280' },
      top: 0,
    },
    grid: { left: 70, right: 30, top: 40, bottom: 60 },
    xAxis: {
      type: 'category',
      data: lags.map(l => `Lag ${l}天`),
      name: 'Lag 天数（N 天前的模型预测得分）',
      nameLocation: 'middle',
      nameGap: 32,
      nameTextStyle: { color: '#6b7280' },
      axisLabel: { color: '#9ca3af' },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
    },
    yAxis: {
      type: 'value',
      name: 'Mean IC',
      nameTextStyle: { color: '#6b7280' },
      axisLabel: { color: '#9ca3af' },
      axisLine: { show: true, lineStyle: { color: '#e5e7eb' } },
      splitLine: { lineStyle: { color: '#f0f0f0', type: 'dashed' } },
    },
    series,
  }

  return (
    <div>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          对象：LightGBM 模型预测得分（prediction score）。X轴为滞后天数，Y轴为 Spearman IC。
        </Text>
        <Tooltip title={explanationTooltip} placement="topLeft">
          <InfoCircleOutlined style={{ color: '#1677ff', cursor: 'pointer', fontSize: 14 }} />
        </Tooltip>
      </div>
      <ReactECharts option={option} style={{ height: 350 }} notMerge />
    </div>
  )
}

// 仓位时序分析图（持仓数量 + 最大/最小权重，使用 markLine 分割 train/valid/test）
const PositionAnalysisChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const orderedSegs = ['train', 'valid', 'test'].filter(s => segments[s]?.position_analysis?.available)

  if (orderedSegs.length === 0) {
    return <Empty description="暂无仓位数据（需 positions_normal_1day.pkl 存在）" style={{ padding: 40 }} />
  }

  // 合并所有 segment 的时序数据，保留 segment 归属
  type PosRow = { date: string; numStocks: number; maxW: number; minW: number; seg: string }
  const allRows: PosRow[] = []

  orderedSegs.forEach(seg => {
    const pa = segments[seg].position_analysis!
    const dates = pa.dates || []
    dates.forEach((d, i) => {
      allRows.push({
        date: d,
        numStocks: pa.num_stocks?.[i] ?? 0,
        maxW: pa.max_weights?.[i] ?? 0,
        minW: pa.min_weights?.[i] ?? 0,
        seg,
      })
    })
  })

  allRows.sort((a, b) => a.date.localeCompare(b.date))

  const dates = allRows.map(r => r.date)
  const numStocksData = allRows.map(r => r.numStocks)
  const maxWData = allRows.map(r => r.maxW)
  const minWData = allRows.map(r => r.minW)

  // 计算每个 segment 的边界索引，用于 markLine 分割线
  const segmentBoundaries: Array<{ startIndex: number; segment: string; color: string }> = []
  let lastSeg = ''
  allRows.forEach((row, idx) => {
    if (row.seg !== lastSeg) {
      const config = SEGMENT_CONFIG[row.seg] || { color: '#8c8c8c', label: row.seg }
      segmentBoundaries.push({
        startIndex: idx,
        segment: config.label,
        color: config.color,
      })
      lastSeg = row.seg
    }
  })

  // 构建垂直分隔线（跳过第一个边界）
  const markLineData: Array<{ xAxis: string; name: string; lineStyle: any }> = []
  segmentBoundaries.forEach((boundary, idx) => {
    if (idx > 0 && boundary.startIndex < dates.length) {
      markLineData.push({
        xAxis: dates[boundary.startIndex],
        name: boundary.segment,
        lineStyle: {
          color: boundary.color,
          type: 'dashed',
          width: 2,
        },
      })
    }
  })

  const option = {
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#e8e8e8',
      textStyle: { color: '#374151' },
      formatter: (params: any[]) => {
        if (!params?.length) return ''
        const idx = params[0].dataIndex
        const row = allRows[idx]
        const cfg = SEGMENT_CONFIG[row.seg] || { label: row.seg }
        return [
          `<b>${params[0].name}</b> [${cfg.label}]`,
          ...params.map(p => `${p.marker}${p.seriesName}: <b>${typeof p.value === 'number' ? p.value.toFixed(p.seriesIndex === 0 ? 0 : 2) : p.value}</b>${p.seriesIndex > 0 ? '%' : '只'}`)
        ].join('<br/>')
      },
    },
    legend: {
      data: segmentBoundaries.map(b => b.segment),
      textStyle: { color: '#6b7280' },
      top: 0,
    },
    grid: { left: 70, right: 60, top: 40, bottom: 60 },
    xAxis: {
      type: 'category',
      data: dates,
      axisLabel: {
        color: '#9ca3af',
        fontSize: 10,
        rotate: 45,
      },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      splitLine: { show: false },
      boundaryGap: false,
    },
    yAxis: [
      {
        type: 'value',
        name: '持仓数量（只）',
        nameTextStyle: { fontSize: 11, color: '#6b7280' },
        minInterval: 1,
        position: 'left',
        axisLabel: { color: '#9ca3af' },
        splitLine: { lineStyle: { color: '#f0f0f0' } },
      },
      {
        type: 'value',
        name: '权重 (%)',
        nameTextStyle: { fontSize: 11, color: '#6b7280' },
        position: 'right',
        axisLabel: {
          color: '#9ca3af',
          formatter: '{value}%',
        },
        axisLine: { show: true, lineStyle: { color: '#e5e7eb' } },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '持仓数量',
        type: 'line',
        yAxisIndex: 0,
        data: numStocksData,
        itemStyle: { color: '#5470c6' },
        lineStyle: { color: '#5470c6', width: 1.5 },
        symbol: 'none',
        markLine: {
          silent: true,
          symbol: 'none',
          data: markLineData,
          label: {
            show: true,
            formatter: '{b}',
            position: 'start',
            color: '#6b7280',
            fontSize: 10,
          },
        },
      },
      {
        name: '最大权重',
        type: 'line',
        yAxisIndex: 1,
        data: maxWData,
        itemStyle: { color: '#ee6666' },
        lineStyle: { color: '#ee6666', width: 1, type: 'dashed' },
        symbol: 'none',
      },
      {
        name: '最小权重',
        type: 'line',
        yAxisIndex: 1,
        data: minWData,
        itemStyle: { color: '#91cc75' },
        lineStyle: { color: '#91cc75', width: 1, type: 'dashed' },
        symbol: 'none',
      },
    ],
    dataZoom: [
      {
        type: 'slider',
        start: 0,
        end: 100,
        height: 20,
        bottom: 5,
        borderColor: '#e5e7eb',
        fillerColor: 'rgba(22,119,255,0.1)',
        handleStyle: { color: '#1677ff' },
      },
      { type: 'inside', start: 0, end: 100 },
    ],
  }

  return <ReactECharts option={option} style={{ height: 350 }} notMerge />
}

// 持仓分析图组件
const HoldingsAnalysisChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  // 优先展示 test，其次 train
  const segName = ['test', 'train', 'valid'].find(s => segments[s]?.holdings_analysis)
  const holdings = segName ? (segments[segName].holdings_analysis as HoldingsAnalysis | undefined) : undefined

  if (!holdings || !holdings.top_stocks || holdings.top_stocks.length === 0) {
    return <Empty description="暂无持仓分析数据（需重新运行 In-Sample 回测）" style={{ padding: 40 }} />
  }

  const stocks = [...holdings.top_stocks].reverse() // 从小到大排列，最大值在顶部
  const option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: '#fff',
      borderColor: '#e8e8e8',
      textStyle: { color: '#374151' },
      formatter: (params: any) => {
        const p = params[0]
        const stock = holdings.top_stocks.find(s => s.stock_id === p.name) ||
          holdings.top_stocks[holdings.top_stocks.length - 1 - p.dataIndex]
        return `${p.name}<br/>持仓天数: ${stock?.hold_days ?? '-'}<br/>持仓频率: ${((stock?.hold_rate ?? 0) * 100).toFixed(1)}%`
      },
    },
    grid: { top: 10, right: 80, bottom: 10, left: 120, containLabel: true },
    xAxis: {
      type: 'value',
      name: '持仓频率 (%)',
      nameTextStyle: { color: '#6b7280' },
      axisLabel: {
        color: '#9ca3af',
        formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
      },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
      max: 1,
    },
    yAxis: {
      type: 'category',
      data: stocks.map(s => s.stock_id),
      axisLabel: { fontSize: 11, color: '#6b7280' },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
    },
    series: [
      {
        type: 'bar',
        data: stocks.map(s => parseFloat(s.hold_rate.toFixed(4))),
        itemStyle: { color: '#5470c6' },
        label: {
          show: true,
          position: 'right',
          formatter: (p: any) => `${(p.value * 100).toFixed(1)}%`,
          fontSize: 11,
          color: '#6b7280',
        },
      },
    ],
  }

  const segLabel = (SEGMENT_CONFIG[segName!] || { label: segName }).label

  return (
    <div>
      <div style={{ marginBottom: 8, display: 'flex', gap: 24 }}>
        <Text type="secondary">数据段: <Tag color="blue">{segLabel}</Tag></Text>
        <Text type="secondary">持仓股票总数: <strong>{holdings.unique_stocks}</strong></Text>
        <Text type="secondary">平均持仓天数: <strong>{holdings.avg_holding_days}</strong></Text>
        <Text type="secondary">总交易日: <strong>{holdings.total_days}</strong></Text>
      </div>
      <ReactECharts option={option} style={{ height: Math.max(350, stocks.length * 26 + 40) }} notMerge />
    </div>
  )
}

// SHAP 跨 Rolling Period 热力图组件
const SHAPHeatmapChart: React.FC<{ expId: string; runId: string }> = ({ expId, runId }) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['shap-heatmap', expId],
    queryFn: () => reportService.getSHAPHeatmap(expId, runId),
    staleTime: 15 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <Spin />
        <div style={{ marginTop: 8 }}><Text type="secondary">加载 SHAP 热力图...</Text></div>
      </div>
    )
  }

  if (error) {
    return <Alert type="error" message="加载失败" description={(error as any).message} showIcon />
  }

  const heatmap = data?.data as SHAPHeatmapData | undefined
  if (!heatmap || !heatmap.features.length || !heatmap.periods.length) {
    return <Empty description="暂无跨期 SHAP 数据（需各 rolling period 含 shap_analysis.pkl）" style={{ padding: 40 }} />
  }

  const { features, periods, matrix } = heatmap
  // ECharts 热力图数据格式: [periodIdx, featureIdx, value]
  const echartsData: [number, number, number][] = []
  matrix.forEach((row, featureIdx) => {
    row.forEach((val, periodIdx) => {
      echartsData.push([periodIdx, featureIdx, val])
    })
  })

  const maxVal = Math.max(...matrix.flat())

  const option = {
    tooltip: {
      formatter: (p: any) => {
        const feat = features[p.data[1]]
        const period = periods[p.data[0]]
        return `特征: ${feat}<br/>Period: ${period}<br/>Mean |SHAP|: ${p.data[2].toFixed(6)}`
      },
    },
    grid: { top: 20, right: 120, bottom: 80, left: 20, containLabel: true },
    xAxis: {
      type: 'category',
      data: periods,
      axisLabel: { rotate: 30, fontSize: 10 },
      name: 'Rolling Period',
      nameLocation: 'middle',
      nameGap: 55,
    },
    yAxis: {
      type: 'category',
      data: features,
      axisLabel: { fontSize: 10 },
    },
    visualMap: {
      min: 0,
      max: maxVal,
      calculable: true,
      orient: 'vertical',
      right: 10,
      top: 'center',
      inRange: { color: ['#f0f9e8', '#43a2ca', '#0868ac'] },
    },
    series: [
      {
        type: 'heatmap',
        data: echartsData,
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } },
      },
    ],
  }

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary">Top {features.length} 特征 × {periods.length} 个 Rolling Period — 颜色越深表示 SHAP 重要性越高</Text>
      </div>
      <ReactECharts option={option} style={{ height: Math.max(400, features.length * 22 + 120) }} notMerge />
    </div>
  )
}

// 新增：模型可解释性分析面板
const ModelInterpretabilityPanel: React.FC<{ expId: string; runId: string }> = ({ expId, runId }) => {
  const [activeSubTab, setActiveSubTab] = useState('importance')
  const [selectedFeature, setSelectedFeature] = useState<string>('')
  const [sampleSize, setSampleSize] = useState(500)

  const { data: featureData, isLoading: loadingFeature, error: errorFeature } = useQuery({
    queryKey: ['feature-importance', expId, runId],
    queryFn: async () => {
      console.log('[ModelInterpretability] Fetching feature importance for:', { expId, runId })
      const result = await reportService.getFeatureImportance(expId, runId)
      console.log('[ModelInterpretability] Feature importance result:', result)
      return result
    },
    staleTime: 10 * 60 * 1000,
  })

  const { data: shapData, isLoading: loadingShap, error: errorShap } = useQuery({
    queryKey: ['shap-analysis', expId, runId, sampleSize],
    queryFn: async () => {
      console.log('[ModelInterpretability] Fetching SHAP analysis for:', { expId, runId, sampleSize })
      const result = await reportService.getSHAPAnalysis(expId, runId, sampleSize, 'test')
      console.log('[ModelInterpretability] SHAP analysis result:', result)
      console.log('[ModelInterpretability] SHAP available:', result?.data?.available)
      if (result?.data?.available === false) {
        console.log('[ModelInterpretability] SHAP error:', result?.data?.error)
      }
      return result
    },
    staleTime: 10 * 60 * 1000,
    enabled: activeSubTab === 'shap' || activeSubTab === 'dependence',
  })

  useEffect(() => {
    if (shapData?.data?.feature_names?.length && !selectedFeature) {
      const stats = shapData.data.feature_stats || {}
      const topFeature = Object.entries(stats)
        .sort((a, b) => (b[1] as any).mean_abs_shap - (a[1] as any).mean_abs_shap)[0]
      if (topFeature) {
        setSelectedFeature(topFeature[0])
      }
    }
  }, [shapData, selectedFeature])

  const isLoading = loadingFeature || (activeSubTab !== 'importance' && loadingShap)
  const hasError = errorFeature || (activeSubTab !== 'importance' && errorShap)
  
  const shapAvailable = shapData?.data?.available === true
  const shapError = shapData?.data?.available === false ? shapData?.data?.error : null

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
        <div style={{ marginTop: 16 }}>
          <Text type="secondary">
            {activeSubTab === 'importance' ? '正在加载特征重要性...' : '正在计算SHAP值...'}
          </Text>
        </div>
      </div>
    )
  }

  if (hasError) {
    return (
      <Alert
        type="error"
        message="加载失败"
        description={(hasError as any)?.message || '请检查后端服务是否正常运行'}
        showIcon
      />
    )
  }

  const shapFeatureOptions = shapData?.data?.feature_names?.map(name => ({
    label: name,
    value: name,
  })) || []

  return (
    <div>
      <Tabs
        activeKey={activeSubTab}
        onChange={setActiveSubTab}
        items={[
          {
            key: 'importance',
            label: <span><BarChartOutlined /> 特征重要性</span>,
            children: (
              <Card size="small" style={{ border: 'none', boxShadow: 'none' }}>
                {featureData?.data?.available === false && (
                  <Alert type="warning" message={featureData?.data?.error || '特征重要性不可用'} style={{ marginBottom: 16 }} />
                )}
                {featureData?.data && <FeatureImportanceChart data={featureData.data} />}
              </Card>
            ),
          },
          {
            key: 'shap',
            label: <span><DotChartOutlined /> SHAP Summary</span>,
            children: (
              <div>
                {shapError && (
                  <Alert type="warning" message="SHAP分析不可用" description={shapError} showIcon style={{ marginBottom: 16 }} />
                )}
                <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center' }}>
                  <Space>
                    <Text type="secondary">采样数量:</Text>
                    <Select value={sampleSize} onChange={setSampleSize} style={{ width: 100 }} size="small">
                      <Select.Option value={300}>300</Select.Option>
                      <Select.Option value={500}>500</Select.Option>
                      <Select.Option value={1000}>1000</Select.Option>
                    </Select>
                  </Space>
                </div>
                {shapAvailable && shapData?.data && <SHAPSummaryPlot data={shapData.data} />}
              </div>
            ),
          },
          {
            key: 'dependence',
            label: <span><LineChartOutlined /> SHAP 依赖图</span>,
            children: (
              <div>
                <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center' }}>
                  <Space>
                    <Text type="secondary">选择特征:</Text>
                    <Select
                      showSearch
                      value={selectedFeature}
                      onChange={setSelectedFeature}
                      style={{ width: 250 }}
                      size="small"
                      placeholder="搜索或选择特征"
                      filterOption={(input, option) =>
                        (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                      }
                      options={shapFeatureOptions}
                    />
                  </Space>
                </div>
                {shapData?.data && selectedFeature && (
                  <SHAPDependencePlot data={shapData.data} selectedFeature={selectedFeature} />
                )}
              </div>
            ),
          },
          {
            key: 'shap-heatmap',
            label: <span><BarChartOutlined /> SHAP 热力图</span>,
            children: (
              <Card size="small" style={{ border: 'none', boxShadow: 'none' }}>
                <SHAPHeatmapChart expId={expId} runId={runId} />
              </Card>
            ),
          },
        ]}
      />
    </div>
  )
}

// 新增：IC 曲线对比图组件
const InSampleICChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])

  const allICData: Array<{ date: string; ic: number; segment: string; rawDate: Date }> = []
  const segmentBoundaries: Array<{ startIndex: number; segment: string; color: string }> = []

  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
    const icAnalysis = segData.ic_analysis

    if (!icAnalysis?.available || !icAnalysis.dates || !icAnalysis.ic_values) {
      return
    }

    const dates = icAnalysis.dates
    const icValues = icAnalysis.ic_values

    dates.forEach((date, i) => {
      if (icValues[i] != null && !isNaN(icValues[i])) {
        allICData.push({
          date,
          ic: icValues[i],
          segment: segName,
          rawDate: new Date(date),
        })
      }
    })
  })

  if (allICData.length === 0) {
    return <Empty description="无IC数据" style={{ padding: 40 }} />
  }

  allICData.sort((a, b) => a.rawDate.getTime() - b.rawDate.getTime())

  let lastSegment = ''
  allICData.forEach((item, idx) => {
    if (item.segment !== lastSegment) {
      const config = SEGMENT_CONFIG[item.segment] || { color: '#8c8c8c', label: item.segment }
      segmentBoundaries.push({
        startIndex: idx,
        segment: config.label,
        color: config.color,
      })
      lastSegment = item.segment
    }
  })

  const dates = allICData.map(d => d.date)
  const icValues = allICData.map(d => d.ic)

  const markLineData: Array<{ xAxis: string; name: string; lineStyle: any }> = []
  segmentBoundaries.forEach((boundary, idx) => {
    if (idx > 0 && boundary.startIndex < dates.length) {
      markLineData.push({
        xAxis: dates[boundary.startIndex],
        name: boundary.segment,
        lineStyle: {
          color: boundary.color,
          type: 'dashed',
          width: 2,
        },
      })
    }
  })

  const icArr = icValues.filter(v => !isNaN(v))
  const meanIC = icArr.length > 0 ? icArr.reduce((a, b) => a + b, 0) / icArr.length : 0

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>IC样本数: <Text strong>{icArr.length}</Text></Text>
        <Text type="secondary" style={{ fontSize: 12 }}>均值IC: <Text strong style={{ color: meanIC > 0 ? '#52c41a' : '#ff4d4f' }}>{meanIC.toFixed(4)}</Text></Text>
        <Text type="secondary" style={{ fontSize: 12 }}>胜率: <Text strong>{((icArr.filter(v => v > 0).length / icArr.length) * 100).toFixed(1)}%</Text></Text>
      </div>
      <ReactECharts
        option={{
          tooltip: {
            trigger: 'axis',
            backgroundColor: '#fff',
            borderColor: '#e8e8e8',
            textStyle: { color: '#374151' },
            formatter: (params: any) => {
              if (!params || !params.length) return ''
              const date = params[0].name
              const ic = params[0].value
              return `${date}<br/>IC: ${ic.toFixed(4)}`
            },
          },
          legend: {
            data: segmentBoundaries.map(b => b.segment),
            textStyle: { color: '#6b7280' },
            top: 0,
          },
          grid: { left: 70, right: 30, top: 40, bottom: 60 },
          xAxis: {
            type: 'category',
            data: dates,
            axisLabel: {
              color: '#9ca3af',
              fontSize: 10,
              rotate: 45,
            },
            axisLine: { lineStyle: { color: '#e5e7eb' } },
            splitLine: { show: false },
          },
          yAxis: {
            type: 'value',
            axisLabel: {
              color: '#9ca3af',
              formatter: (value: number) => value.toFixed(2),
            },
            splitLine: { lineStyle: { color: '#f0f0f0' } },
            name: 'IC值',
            nameLocation: 'middle',
            nameGap: 45,
            nameTextStyle: { color: '#6b7280' },
          },
          series: [
            {
              name: 'IC',
              type: 'bar',
              data: icValues.map(v => ({
                value: v,
                itemStyle: {
                  color: v >= 0 ? '#52c41a' : '#ff4d4f',
                  borderRadius: [1, 1, 0, 0],
                },
              })),
              barWidth: '60%',
              markLine: {
                silent: true,
                symbol: 'none',
                data: [
                  { yAxis: meanIC, name: '均值', lineStyle: { color: '#fa8c16', type: 'dashed', width: 2 } },
                  { yAxis: 0, name: '零线', lineStyle: { color: '#d9d9d9', type: 'solid' } },
                  ...markLineData,
                ],
                label: {
                  show: true,
                  formatter: '{b}',
                  position: 'start',
                  color: '#6b7280',
                  fontSize: 10,
                },
              },
            },
          ],
          dataZoom: [
            {
              type: 'slider',
              start: 0,
              end: 100,
              height: 20,
              bottom: 5,
              borderColor: '#e5e7eb',
              fillerColor: 'rgba(22,119,255,0.1)',
              handleStyle: { color: '#1677ff' },
            },
            { type: 'inside', start: 0, end: 100 },
          ],
        }}
        style={{ height: 350 }}
        notMerge={true}
      />
    </div>
  )
}

// 新增：滚动 ICIR 曲线组件
const InSampleICIRChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])

  const allICIRData: Array<{ date: string; icir: number | null; segment: string; rawDate: Date }> = []
  const segmentBoundaries: Array<{ startIndex: number; segment: string; color: string }> = []

  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
    const icAnalysis = segData.ic_analysis

    if (!icAnalysis?.available || !icAnalysis.dates || !icAnalysis.rolling_icir) {
      return
    }

    const dates = icAnalysis.dates
    const rollingICIR = icAnalysis.rolling_icir

    dates.forEach((date, i) => {
      if (i < rollingICIR.length && rollingICIR[i] != null && !isNaN(rollingICIR[i]!)) {
        allICIRData.push({
          date,
          icir: rollingICIR[i],
          segment: segName,
          rawDate: new Date(date),
        })
      }
    })
  })

  if (allICIRData.length === 0) {
    return <Empty description="无滚动ICIR数据（需要至少20个IC样本）" style={{ padding: 40 }} />
  }

  allICIRData.sort((a, b) => a.rawDate.getTime() - b.rawDate.getTime())

  let lastSegment = ''
  allICIRData.forEach((item, idx) => {
    if (item.segment !== lastSegment) {
      const config = SEGMENT_CONFIG[item.segment] || { color: '#8c8c8c', label: item.segment }
      segmentBoundaries.push({
        startIndex: idx,
        segment: config.label,
        color: config.color,
      })
      lastSegment = item.segment
    }
  })

  const dates = allICIRData.map(d => d.date)
  const icirValues = allICIRData.map(d => d.icir)

  const markLineData: Array<{ xAxis: string; name: string; lineStyle: any }> = []
  segmentBoundaries.forEach((boundary, idx) => {
    if (idx > 0 && boundary.startIndex < dates.length) {
      markLineData.push({
        xAxis: dates[boundary.startIndex],
        name: boundary.segment,
        lineStyle: {
          color: boundary.color,
          type: 'dashed',
          width: 2,
        },
      })
    }
  })

  return (
    <ReactECharts
      option={{
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
          formatter: (params: any) => {
            if (!params || !params.length) return ''
            const date = params[0].name
            const icir = params[0].value
            return `${date}<br/>滚动ICIR: ${icir?.toFixed(3) || '-'}`
          },
        },
        legend: {
          data: segmentBoundaries.map(b => b.segment),
          textStyle: { color: '#6b7280' },
          top: 0,
        },
        grid: { left: 70, right: 30, top: 40, bottom: 30 },
        xAxis: {
          type: 'category',
          data: dates,
          axisLabel: { color: '#9ca3af', fontSize: 10 },
          axisLine: { lineStyle: { color: '#e5e7eb' } },
        },
        yAxis: {
          type: 'value',
          axisLabel: {
            color: '#9ca3af',
            formatter: (value: number) => value.toFixed(1),
          },
          splitLine: { lineStyle: { color: '#f0f0f0' } },
          name: '滚动ICIR',
          nameLocation: 'middle',
          nameGap: 45,
          nameTextStyle: { color: '#6b7280' },
        },
        series: [
          {
            name: '滚动ICIR',
            type: 'line',
            data: icirValues,
            lineStyle: { width: 2, color: '#722ed1' },
            itemStyle: { color: '#722ed1' },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(114,46,209,0.15)' },
                  { offset: 1, color: 'rgba(114,46,209,0)' },
                ],
              },
            },
            markLine: {
              silent: true,
              symbol: 'none',
              data: [
                { yAxis: 0, name: '零线', lineStyle: { color: '#d9d9d9', type: 'solid' } },
                ...markLineData,
              ],
              label: {
                show: true,
                formatter: '{b}',
                position: 'start',
                color: '#6b7280',
                fontSize: 10,
              },
            },
          },
        ],
        dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      }}
      style={{ height: 280 }}
    />
  )
}

// 新增：预测值 vs 标签值 散点图组件
const InSampleScatterChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const GRID = { left: 70, right: 30, top: 50, bottom: 50 }
  const { ref, size } = useContainerSize(500, 350)
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])

  const series: Array<Record<string, unknown>> = []
  const allScores: number[] = []
  const allLabels: number[] = []

  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
    const predLabelData = segData.pred_label_data

    if (!predLabelData?.available || !predLabelData.scores || !predLabelData.labels) {
      return
    }

    const scores = predLabelData.scores
    const labels = predLabelData.labels

    const sampleSize = Math.min(scores.length, 2000)
    const step = Math.max(1, Math.floor(scores.length / sampleSize))
    const sampledData: Array<[number, number]> = []

    for (let i = 0; i < scores.length; i += step) {
      if (scores[i] != null && labels[i] != null && !isNaN(scores[i]) && !isNaN(labels[i])) {
        sampledData.push([scores[i], labels[i]])
        allScores.push(scores[i])
        allLabels.push(labels[i])
      }
    }

    if (sampledData.length > 0) {
      series.push({
        name: config.label,
        type: 'scatter',
        data: sampledData,
        symbolSize: 3,
        itemStyle: {
          color: config.color,
          opacity: 0.5,
        },
      })
    }
  })

  if (series.length === 0) {
    return <Empty description="无预测值-标签值数据" style={{ padding: 40 }} />
  }

  const plotW = Math.max(size.w - GRID.left - GRID.right, 1)
  const plotH = Math.max(size.h - GRID.top - GRID.bottom, 1)
  const ticks = computeEqualScaleTicks(allScores, allLabels, plotW, plotH)

  return (
    <div ref={ref} style={{ width: '100%', height: 350 }}>
      <ReactECharts
        option={{
          tooltip: {
            trigger: 'item',
            backgroundColor: '#fff',
            borderColor: '#e8e8e8',
            textStyle: { color: '#374151' },
            formatter: (params: any) => {
              return `预测值: ${params.value[0]?.toFixed(4)}<br/>标签值: ${params.value[1]?.toFixed(4)}`
            },
          },
          legend: {
            data: series.map(s => s.name as string),
            textStyle: { color: '#6b7280' },
            top: 0,
          },
          grid: GRID,
          xAxis: {
            type: 'value',
            min: ticks.xMin,
            max: ticks.xMax,
            interval: ticks.interval,
            name: '预测值 (Score)',
            nameLocation: 'middle',
            nameGap: 30,
            axisLabel: { color: '#9ca3af' },
            axisLine: { lineStyle: { color: '#e5e7eb' } },
            splitLine: { lineStyle: { color: '#f0f0f0' } },
          },
          yAxis: {
            type: 'value',
            min: ticks.yMin,
            max: ticks.yMax,
            interval: ticks.interval,
            name: '标签值 (Label)',
            nameLocation: 'middle',
            nameGap: 50,
            axisLabel: { color: '#9ca3af' },
            axisLine: { lineStyle: { color: '#e5e7eb' } },
            splitLine: { lineStyle: { color: '#f0f0f0' } },
          },
          series,
        }}
        style={{ width: '100%', height: '100%' }}
        notMerge
      />
    </div>
  )
}

// 新增：预测值分布直方图
const InSampleScoreHistogramChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])
  
  const series: Array<Record<string, unknown>> = []
  
  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
    const predLabelData = segData.pred_label_data
    
    if (!predLabelData?.available || !predLabelData.score_histogram) {
      return
    }
    
    const histogram = predLabelData.score_histogram
    
    series.push({
      name: config.label,
      type: 'bar',
      data: histogram.counts,
      xAxisData: histogram.bin_centers.map((c: number) => c.toFixed(4)),
      itemStyle: {
        color: config.color,
        opacity: 0.7,
        borderRadius: [2, 2, 0, 0],
      },
    })
  })
  
  if (series.length === 0) {
    return <Empty description="无预测值分布数据" style={{ padding: 40 }} />
  }
  
  const xAxisData = series[0].xAxisData as string[]
  
  return (
    <ReactECharts
      option={{
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
        },
        legend: {
          data: series.map(s => s.name as string),
          textStyle: { color: '#6b7280' },
          top: 0,
        },
        grid: { left: 70, right: 30, top: 50, bottom: 60 },
        xAxis: {
          type: 'category',
          data: xAxisData,
          axisLabel: { color: '#9ca3af', fontSize: 9, rotate: 45 },
          axisLine: { lineStyle: { color: '#e5e7eb' } },
        },
        yAxis: {
          type: 'value',
          name: '频次',
          axisLabel: { color: '#9ca3af' },
          splitLine: { lineStyle: { color: '#f0f0f0' } },
        },
        series: series.map(s => ({
          name: s.name,
          type: 'bar',
          data: s.data,
          itemStyle: s.itemStyle,
        })),
      }}
      style={{ height: 300 }}
    />
  )
}

// 新增：标签值分布直方图
const InSampleLabelHistogramChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])
  
  const series: Array<Record<string, unknown>> = []
  
  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
    const predLabelData = segData.pred_label_data
    
    if (!predLabelData?.available || !predLabelData.label_histogram) {
      return
    }
    
    const histogram = predLabelData.label_histogram
    
    series.push({
      name: config.label,
      type: 'bar',
      data: histogram.counts,
      xAxisData: histogram.bin_centers.map((c: number) => c.toFixed(4)),
      itemStyle: {
        color: config.color,
        opacity: 0.7,
        borderRadius: [2, 2, 0, 0],
      },
    })
  })
  
  if (series.length === 0) {
    return <Empty description="无标签值分布数据" style={{ padding: 40 }} />
  }
  
  const xAxisData = series[0].xAxisData as string[]
  
  return (
    <ReactECharts
      option={{
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#fff',
          borderColor: '#e8e8e8',
          textStyle: { color: '#374151' },
        },
        legend: {
          data: series.map(s => s.name as string),
          textStyle: { color: '#6b7280' },
          top: 0,
        },
        grid: { left: 70, right: 30, top: 50, bottom: 60 },
        xAxis: {
          type: 'category',
          data: xAxisData,
          axisLabel: { color: '#9ca3af', fontSize: 9, rotate: 45 },
          axisLine: { lineStyle: { color: '#e5e7eb' } },
        },
        yAxis: {
          type: 'value',
          name: '频次',
          axisLabel: { color: '#9ca3af' },
          splitLine: { lineStyle: { color: '#f0f0f0' } },
        },
        series: series.map(s => ({
          name: s.name,
          type: 'bar',
          data: s.data,
          itemStyle: s.itemStyle,
        })),
      }}
      style={{ height: 300 }}
    />
  )
}

// 分层回测：调用后端 qlib model_performance_graph，三列并排展示 train/valid/test
const InsampleLayeredBacktest: React.FC<{ expId: string; runId: string }> = ({ expId, runId }) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['insample-layered', expId, runId],
    queryFn: () => reportService.getInsampleLayered(expId, runId),
    enabled: !!expId && !!runId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  if (isLoading) return <Spin style={{ display: 'block', margin: '40px auto' }} />
  if (error) return <Empty description={`加载失败: ${(error as Error).message}`} style={{ padding: 40 }} />
  if (!data?.success || !data.data?.available) {
    return <Empty description={data?.message || '暂无分层回测数据（需要 MultiSegmentSignalRecord 产出的 pred_*.pkl / label_*.pkl）'} style={{ padding: 40 }} />
  }

  const segments = data.data.segments
  const orderedSegmentNames = ['train', 'valid', 'test']

  return (
    <Row gutter={[12, 12]}>
      {orderedSegmentNames.map(segName => {
        const seg = segments[segName]
        const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName, bgColor: 'rgba(140,140,140,0.08)' }
        return (
          <Col xs={24} lg={8} key={segName}>
            <Card
              size="small"
              title={
                <Space>
                  <Tag color={config.color}>{config.label}</Tag>
                  {seg?.available && seg.sample_count != null && (
                    <Text type="secondary" style={{ fontSize: 11 }}>样本: {seg.sample_count.toLocaleString()}</Text>
                  )}
                  {seg?.available && seg.time_range && (
                    <Text type="secondary" style={{ fontSize: 11 }}>{seg.time_range[0]} ~ {seg.time_range[1]}</Text>
                  )}
                </Space>
              }
              style={{ background: config.bgColor }}
            >
              {!seg || !seg.available ? (
                <Empty description={seg?.detail || seg?.error || '该段无分层回测数据'} style={{ padding: 24 }} />
              ) : (
                <div>
                  {(seg.figures || []).map((fig, i) => {
                    const fixedFig = fixPlotlyFigureXAxis(fig)
                    return (
                      <div key={`${segName}-fig-${i}`} style={{ marginBottom: 12 }}>
                        <Plot
                          data={fixedFig.data}
                          layout={{ ...fixedFig.layout, height: 300, autosize: true, margin: { l: 45, r: 20, t: 30, b: 50 } }}
                          style={{ width: '100%', minHeight: 300 }}
                          useResizeHandler
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          </Col>
        )
      })}
    </Row>
  )
}

// 新增：IC 综合分析图表（四条曲线：IC、ICIR、Rank IC、Rank ICIR）
const InSampleICComprehensiveChart: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const orderedSegmentNames = ['train', 'valid', 'test'].filter(name => segments[name])

  interface DataPoint {
    date: string
    rawDate: Date
    segment: string
    ic: number | null
    icir: number | null
    rankIc: number | null
    rankIcir: number | null
  }

  const allData: DataPoint[] = []
  const segmentBoundaries: Array<{ date: string; segment: string; color: string }> = []

  // 计算每个segment的统计指标
  const segmentStats: Record<string, { 
    icValues: number[], 
    rankIcValues: number[],
    meanIC: number, 
    meanRankIC: number,
    icir: number,
    rankIcir: number
  }> = {}

  orderedSegmentNames.forEach(segName => {
    const segData = segments[segName]
    const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
    const icAnalysis = segData.ic_analysis
    const rankIcAnalysis = segData.rank_ic_analysis

    if (!icAnalysis?.available && !rankIcAnalysis?.available) {
      return
    }

    const icDates = icAnalysis?.dates || []
    const icValues = icAnalysis?.ic_values || []
    const icirValues = icAnalysis?.rolling_icir || []
    const rankIcDates = rankIcAnalysis?.dates || []
    const rankIcValues = rankIcAnalysis?.rank_ic_values || []
    const rankIcirValues = rankIcAnalysis?.rolling_rank_icir || []

    // 计算该segment的统计指标
    const segIcValues = icValues.filter((v): v is number => v != null && !isNaN(v))
    const segRankIcValues = rankIcValues.filter((v): v is number => v != null && !isNaN(v))
    
    const meanIC = segIcValues.length > 0 ? segIcValues.reduce((a, b) => a + b, 0) / segIcValues.length : 0
    const meanRankIC = segRankIcValues.length > 0 ? segRankIcValues.reduce((a, b) => a + b, 0) / segRankIcValues.length : 0
    const stdIC = segIcValues.length > 1 ? Math.sqrt(segIcValues.map(v => (v - meanIC) ** 2).reduce((a, b) => a + b, 0) / segIcValues.length) : 0
    const stdRankIC = segRankIcValues.length > 1 ? Math.sqrt(segRankIcValues.map(v => (v - meanRankIC) ** 2).reduce((a, b) => a + b, 0) / segRankIcValues.length) : 0

    segmentStats[segName] = {
      icValues: segIcValues,
      rankIcValues: segRankIcValues,
      meanIC,
      meanRankIC,
      icir: stdIC > 0 ? meanIC / stdIC : 0,
      rankIcir: stdRankIC > 0 ? meanRankIC / stdRankIC : 0,
    }

    const dateSet = new Set([...icDates, ...rankIcDates])
    const sortedDates = Array.from(dateSet).sort()

    sortedDates.forEach(date => {
      const icIdx = icDates.indexOf(date)
      const rankIcIdx = rankIcDates.indexOf(date)

      const ic = icIdx >= 0 && icValues[icIdx] != null && !isNaN(icValues[icIdx]) ? icValues[icIdx] : null
      const icir = icIdx >= 0 && icirValues[icIdx] != null && !isNaN(icirValues[icIdx]!) ? icirValues[icIdx] : null
      const rankIc = rankIcIdx >= 0 && rankIcValues[rankIcIdx] != null && !isNaN(rankIcValues[rankIcIdx]) ? rankIcValues[rankIcIdx] : null
      const rankIcir = rankIcIdx >= 0 && rankIcirValues[rankIcIdx] != null && !isNaN(rankIcirValues[rankIcIdx]!) ? rankIcirValues[rankIcIdx] : null

      if (ic !== null || icir !== null || rankIc !== null || rankIcir !== null) {
        allData.push({
          date,
          rawDate: new Date(date),
          segment: segName,
          ic,
          icir,
          rankIc,
          rankIcir,
        })
      }
    })
  })

  if (allData.length === 0) {
    return <Empty description="无IC分析数据" style={{ padding: 40 }} />
  }

  allData.sort((a, b) => a.rawDate.getTime() - b.rawDate.getTime())

  let lastSegment = ''
  allData.forEach(item => {
    if (item.segment !== lastSegment) {
      const config = SEGMENT_CONFIG[item.segment] || { color: '#8c8c8c', label: item.segment }
      segmentBoundaries.push({
        date: item.date,
        segment: config.label,
        color: config.color,
      })
      lastSegment = item.segment
    }
  })

  const dates = allData.map(d => d.date)
  const icData = allData.map(d => d.ic)
  const icirData = allData.map(d => d.icir)
  const rankIcData = allData.map(d => d.rankIc)
  const rankIcirData = allData.map(d => d.rankIcir)

  const validIC = icData.filter(v => v !== null) as number[]
  const validRankIC = rankIcData.filter(v => v !== null) as number[]
  const meanIC = validIC.length > 0 ? validIC.reduce((a, b) => a + b, 0) / validIC.length : 0
  const meanRankIC = validRankIC.length > 0 ? validRankIC.reduce((a, b) => a + b, 0) / validRankIC.length : 0

  // 创建分隔线数据（和累计收益曲线一样的方案）
  const markLineData: Array<{ xAxis: string; name: string; lineStyle: any; label: any }> = []
  
  segmentBoundaries.forEach((boundary, idx) => {
    if (idx > 0) {
      markLineData.push({
        xAxis: boundary.date,
        name: boundary.segment,
        lineStyle: {
          color: boundary.color,
          type: 'dashed',
          width: 2,
        },
        label: {
          show: true,
          formatter: boundary.segment,
          position: 'start',
          color: boundary.color,
          fontSize: 11,
        },
      })
    }
  })

  return (
    <div>
      {/* 分阶段统计指标 */}
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {orderedSegmentNames.map(segName => {
          const stats = segmentStats[segName]
          const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
          if (!stats) return null
          return (
            <div key={segName} style={{ padding: '4px 8px', background: '#fafafa', borderRadius: 4 }}>
              <Tag color={config.color} style={{ marginRight: 4 }}>{config.label}</Tag>
              <Text type="secondary" style={{ fontSize: 11, marginRight: 8 }}>
                IC: <Text strong style={{ color: stats.meanIC > 0 ? '#52c41a' : '#ff4d4f' }}>{stats.meanIC.toFixed(4)}</Text>
              </Text>
              <Text type="secondary" style={{ fontSize: 11, marginRight: 8 }}>
                RankIC: <Text strong style={{ color: stats.meanRankIC > 0 ? '#52c41a' : '#ff4d4f' }}>{stats.meanRankIC.toFixed(4)}</Text>
              </Text>
              <Text type="secondary" style={{ fontSize: 11, marginRight: 8 }}>
                ICIR: <Text strong style={{ color: stats.icir > 0 ? '#52c41a' : '#ff4d4f' }}>{stats.icir.toFixed(2)}</Text>
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                RankICIR: <Text strong style={{ color: stats.rankIcir > 0 ? '#52c41a' : '#ff4d4f' }}>{stats.rankIcir.toFixed(2)}</Text>
              </Text>
            </div>
          )
        })}
      </div>
      
      {/* 总体统计 */}
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          总样本数: <Text strong>{validIC.length}</Text>
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          总体均值IC: <Text strong style={{ color: meanIC > 0 ? '#52c41a' : '#ff4d4f' }}>{meanIC.toFixed(4)}</Text>
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          总体均值Rank IC: <Text strong style={{ color: meanRankIC > 0 ? '#52c41a' : '#ff4d4f' }}>{meanRankIC.toFixed(4)}</Text>
        </Text>
        <Tooltip title={
          <div>
            <div><b>IC</b>: 日度信息系数，预测值与真实标签的Spearman相关系数</div>
            <div><b>Rank IC</b>: 日度秩相关系数，预测值排名与标签排名的Pearson相关系数</div>
            <div><b>ICIR</b>: IC信息比率 = Mean(IC) / Std(IC)</div>
            <div><b>Rank ICIR</b>: Rank IC信息比率</div>
          </div>
        }>
          <InfoCircleOutlined style={{ color: '#1677ff', cursor: 'pointer' }} />
        </Tooltip>
      </div>
      <ReactECharts
        option={{
          tooltip: {
            trigger: 'axis',
            backgroundColor: '#fff',
            borderColor: '#e8e8e8',
            textStyle: { color: '#374151' },
            formatter: (params: any[]) => {
              if (!params || !params.length) return ''
              const date = params[0].name
              let lines = [date]
              params.forEach(p => {
                if (p.value !== null && p.value !== undefined) {
                  lines.push(`${p.marker}${p.seriesName}: ${p.value.toFixed(4)}`)
                }
              })
              return lines.join('<br/>')
            },
          },
          legend: {
            data: ['IC', 'ICIR', 'Rank IC', 'Rank ICIR'],
            textStyle: { color: '#6b7280' },
            top: 0,
            selected: {
              'IC': true,
              'ICIR': true,
              'Rank IC': true,
              'Rank ICIR': true,
            },
          },
          grid: { left: 70, right: 30, top: 50, bottom: 60 },
          xAxis: {
            type: 'category',
            data: dates,
            axisLabel: {
              color: '#9ca3af',
              fontSize: 10,
              rotate: 45,
            },
            axisLine: { lineStyle: { color: '#e5e7eb' } },
            splitLine: { show: false },
          },
          yAxis: {
            type: 'value',
            axisLabel: {
              color: '#9ca3af',
              formatter: (value: number) => value.toFixed(2),
            },
            splitLine: { lineStyle: { color: '#f0f0f0' } },
            name: '值',
            nameLocation: 'middle',
            nameGap: 45,
            nameTextStyle: { color: '#6b7280' },
          },
          series: [
            {
              name: 'IC',
              type: 'line',
              data: icData,
              lineStyle: { width: 1.5, color: '#1677ff' },
              itemStyle: { color: '#1677ff' },
              symbol: 'none',
              connectNulls: false,
              markLine: {
                silent: true,
                symbol: 'none',
                data: [
                  { yAxis: 0, name: '零线', lineStyle: { color: '#d9d9d9', type: 'solid' } },
                  ...markLineData,
                ],
                label: {
                  show: true,
                  formatter: '{b}',
                  position: 'start',
                  color: '#6b7280',
                  fontSize: 10,
                },
              },
            },
            {
              name: 'ICIR',
              type: 'line',
              data: icirData,
              lineStyle: { width: 1.5, color: '#722ed1' },
              itemStyle: { color: '#722ed1' },
              symbol: 'none',
              connectNulls: false,
            },
            {
              name: 'Rank IC',
              type: 'line',
              data: rankIcData,
              lineStyle: { width: 1.5, color: '#52c41a' },
              itemStyle: { color: '#52c41a' },
              symbol: 'none',
              connectNulls: false,
            },
            {
              name: 'Rank ICIR',
              type: 'line',
              data: rankIcirData,
              lineStyle: { width: 1.5, color: '#fa8c16' },
              itemStyle: { color: '#fa8c16' },
              symbol: 'none',
              connectNulls: false,
            },
          ],
          dataZoom: [
            {
              type: 'slider',
              start: 0,
              end: 100,
              height: 20,
              bottom: 5,
              borderColor: '#e5e7eb',
              fillerColor: 'rgba(22,119,255,0.1)',
              handleStyle: { color: '#1677ff' },
            },
            { type: 'inside', start: 0, end: 100 },
          ],
        }}
        style={{ height: 400 }}
        notMerge={true}
      />
      <div style={{ marginTop: 8, padding: 8, background: '#fafafa', borderRadius: 4 }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          <strong>说明：</strong>点击图例可隐藏/显示对应曲线。IC = Spearman相关系数，Rank IC = Pearson(rank(score), rank(label))，ICIR = IC均值/IC标准差。
        </Text>
      </div>
    </div>
  )
}

// 新增：IC 指标对比表格
const InSampleICMetricsTable: React.FC<{ segments: Record<string, InSampleSegmentResult> }> = ({ segments }) => {
  const segmentNames = ['train', 'valid', 'test'].filter(name => segments[name])
  
  if (segmentNames.length === 0) {
    return null
  }

  const hasICData = segmentNames.some(name => segments[name].ic_analysis?.available)
  if (!hasICData) {
    return null
  }

  const columns = [
    {
      title: 'IC指标',
      dataIndex: 'metric',
      key: 'metric',
      fixed: 'left' as const,
      width: 120,
      render: (text: string) => <Text strong style={{ color: '#374151' }}>{text}</Text>,
    },
    ...segmentNames.map(segName => {
      const config = SEGMENT_CONFIG[segName] || { color: '#8c8c8c', label: segName }
      return {
        title: <Tag color={config.color}>{config.label}</Tag>,
        dataIndex: segName,
        key: segName,
        align: 'right' as const,
        render: (value: string) => (
          <Text style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 13 }}>
            {value}
          </Text>
        ),
      }
    }),
  ]

  const metrics = [
    { key: 'mean_ic', label: '均值IC', format: (v: number) => v.toFixed(4) },
    { key: 'std_ic', label: 'IC标准差', format: (v: number) => v.toFixed(4) },
    { key: 'icir', label: 'ICIR', format: (v: number) => v.toFixed(3) },
    { key: 'hit_rate', label: 'IC胜率', format: (v: number) => `${(v * 100).toFixed(1)}%` },
  ]

  const dataSource = metrics.map(metric => {
    const row: Record<string, any> = {
      key: metric.key,
      metric: metric.label,
    }
    segmentNames.forEach(segName => {
      const ic = segments[segName].ic_analysis
      const value = ic?.[metric.key as keyof typeof ic]
      row[segName] = value != null ? metric.format(value as number) : '-'
    })
    return row
  })

  return (
    <Table
      size="small"
      dataSource={dataSource}
      columns={columns}
      pagination={false}
      scroll={{ x: 'max-content' }}
      bordered
    />
  )
}

interface InSampleAnalysisPanelProps {
  expId: string
  runId: string
  externalTrigger?: number
}

const InSampleAnalysisPanel: React.FC<InSampleAnalysisPanelProps> = ({ expId, runId, externalTrigger }) => {
  const queryClient = useQueryClient()

  // 首先尝试加载已有的 In-Sample 结果
  const { data: existingResult, isLoading: isLoadingExisting } = useQuery({
    queryKey: ['insample-existing', expId, runId],
    queryFn: async () => {
      console.log('[InSample] Fetching existing results for:', { expId, runId })
      const result = await trainingService.getExistingInSampleResults(expId, runId)
      console.log('[InSample] Existing result:', result)
      if (result?.data?.segments) {
        Object.entries(result.data.segments).forEach(([name, seg]) => {
          const segData = seg as any
          console.log(`[InSample] Segment ${name}:`, {
            hasIC: !!segData.ic_analysis,
            hasRankIC: !!segData.rank_ic_analysis,
            icAvailable: segData.ic_analysis?.available,
            rankICAvailable: segData.rank_ic_analysis?.available,
            icDates: segData.ic_analysis?.dates?.length,
            icValues: segData.ic_analysis?.ic_values?.length,
            rankICDates: segData.rank_ic_analysis?.dates?.length,
            rankICValues: segData.rank_ic_analysis?.rank_ic_values?.length,
          })
        })
      }
      return result
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  const mutation = useMutation({
    mutationFn: () => trainingService.runInSampleBacktest(expId, runId),
    onSuccess: (data) => {
      queryClient.setQueryData(['insample-existing', expId, runId], data)
      if (data.success) {
        notification.success({
          message: 'In-Sample 回测完成',
          description: data.message || '已成功生成 train/valid/test 三段回测结果',
          placement: 'topRight',
          duration: 4,
        })
      } else {
        notification.error({
          message: 'In-Sample 回测失败',
          description: data.message || '未知错误',
          placement: 'topRight',
          duration: 6,
        })
      }
    },
    onError: (error: Error) => {
      notification.error({
        message: 'In-Sample 回测执行失败',
        description: error.message || '网络错误或服务端异常',
        placement: 'topRight',
        duration: 6,
      })
    },
  })

  React.useEffect(() => {
    if (externalTrigger != null && externalTrigger > 0) {
      mutation.mutate()
    }
  }, [externalTrigger])

  const result = mutation.data || existingResult
  const isLoading = mutation.isPending || isLoadingExisting
  const hasExistingResult = existingResult?.success && existingResult.data

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Tooltip title="功能开发中，暂不可用">
          <Button
            type="primary"
            icon={isLoading ? <LoadingOutlined /> : <ExperimentOutlined />}
            loading={isLoading}
            onClick={() => mutation.mutate()}
            style={{ borderColor: '#722ed1', background: '#722ed1' }}
            disabled
          >
            {isLoading ? '正在执行回测...' : hasExistingResult ? '重新运行 In-Sample 回测' : '运行 In-Sample 回测'}
          </Button>
        </Tooltip>
        {hasExistingResult && !mutation.isPending && (
          <Tag color="green">已有 {Object.keys(existingResult.data.segments).length} 个 segment 的结果</Tag>
        )}
        {mutation.isError && (
          <Text type="danger" style={{ fontSize: 12 }}>
            <CloseCircleOutlined style={{ marginRight: 4 }} />
            执行失败: {(mutation.error as Error)?.message || '未知错误'}
          </Text>
        )}
        {mutation.isSuccess && result?.success && (
          <Text type="success" style={{ fontSize: 12 }}>
            <CheckCircleOutlined style={{ marginRight: 4 }} />
            {result.message || '回测完成'}
          </Text>
        )}
      </div>

      {isLoading && (
        <Spin tip="正在执行 In-Sample 回测，请稍候..." style={{ display: 'block', margin: '40px auto' }} />
      )}

      {!isLoading && result?.success && result.data && (
        <Row gutter={[16, 16]}>
          {/* 指标对比表格 */}
          <Col span={24}>
            <Card title="风险指标详细对比" size="small">
              <InSampleMetricsComparisonTable segments={result.data.segments} />
            </Card>
          </Col>

          {/* 累计收益率曲线图 */}
          <Col span={24}>
            <Card 
              title={
                <Space>
                  <span>累计收益率曲线</span>
                  <Text type="secondary" style={{ fontSize: 11, fontWeight: 'normal' }}>
                    （虚线分隔不同阶段：训练集 → 验证集 → 测试集）
                  </Text>
                </Space>
              } 
              size="small"
            >
              <InSampleCumulativeReturnChart segments={result.data.segments} />
            </Card>
          </Col>

          {/* 分层回测（train/valid/test 三列并排，qlib model_performance_graph） */}
          <Col span={24}>
            <Card
              title={
                <Space>
                  <span>分层回测对比（5 组分位 + Long-Short）</span>
                  <Text type="secondary" style={{ fontSize: 11, fontWeight: 'normal' }}>
                    （基于 qlib model_performance_graph，训练集 / 验证集 / 测试集 三列并排，用于判断分层单调性与过拟合）
                  </Text>
                </Space>
              }
              size="small"
            >
              <InsampleLayeredBacktest expId={expId} runId={runId} />
            </Card>
          </Col>

          {/* IC 综合分析图表（移到回测曲线之后） */}
          <Col span={24}>
            <Card 
              title={
                <Space>
                  <span>IC 综合分析</span>
                  <Text type="secondary" style={{ fontSize: 11, fontWeight: 'normal' }}>
                    （IC/ICIR/Rank IC/Rank ICIR，点击图例可隐藏曲线）
                  </Text>
                </Space>
              } 
              size="small"
            >
              <InSampleICComprehensiveChart segments={result.data.segments} />
            </Card>
          </Col>

          {/* 回撤曲线对比 */}
          <Col span={24}>
            <Card title="回撤曲线对比" size="small">
              <InSampleDrawdownChart segments={result.data.segments} />
            </Card>
          </Col>

          {/* 换手率对比 */}
          <Col span={24}>
            <Card title="换手率对比" size="small">
              <InSampleTurnoverChart segments={result.data.segments} />
            </Card>
          </Col>

          {/* 风险指标雷达图 + 日收益率分布对比 */}
          <Col xs={24} lg={12}>
            <Card title="风险指标雷达图对比" size="small">
              <InSampleRadarChart segments={result.data.segments} />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card title="日收益率分布对比" size="small">
              <InSampleDailyReturnDistributionChart segments={result.data.segments} />
            </Card>
          </Col>

          {/* 预测值 vs 标签值 散点图 */}
          <Col xs={24} lg={12}>
            <Card title="预测值 vs 标签值 散点图" size="small">
              <InSampleScatterChart segments={result.data.segments} />
            </Card>
          </Col>

          {/* 预测值分布直方图 */}
          <Col xs={24} lg={12}>
            <Card title="预测值分布" size="small">
              <InSampleScoreHistogramChart segments={result.data.segments} />
            </Card>
          </Col>

          {/* 标签值分布直方图 */}
          <Col xs={24} lg={12}>
            <Card title="标签值分布" size="small">
              <InSampleLabelHistogramChart segments={result.data.segments} />
            </Card>
          </Col>

          {/* 仓位时序分析 */}
          <Col xs={24}>
            <Card title="仓位分析（持仓数量 & 权重）" size="small" extra={<Text type="secondary">按 train / valid / test 时间段着色，左轴：持仓只数，右轴：最大/最小权重%</Text>}>
              <PositionAnalysisChart segments={result.data.segments} />
            </Card>
          </Col>

          {/* Lag IC 衰减曲线 */}
          <Col xs={24}>
            <Card title="Lag IC 衰减曲线" size="small" extra={<Text type="secondary">信号在不同 lag 天数下的预测能力衰减情况</Text>}>
              <LagICDecayCurve segments={result.data.segments} />
            </Card>
          </Col>

          {/* 持仓频率分析 */}
          <Col xs={24}>
            <Card title="持仓频率分析 Top 20" size="small" extra={<Text type="secondary">模拟 TopK 持仓中各股票出现频率</Text>}>
              <HoldingsAnalysisChart segments={result.data.segments} />
            </Card>
          </Col>
        </Row>
      )}

      {!isLoading && !result && (
        <Empty description="点击上方按钮运行 In-Sample 回测分析" style={{ padding: 60 }} />
      )}
    </div>
  )
}

const ReportPage: React.FC = () => {
  const { expId, runId } = useParams<{ expId: string; runId: string }>()
  const navigate = useNavigate()
  const [inSampleTrigger, setInSampleTrigger] = React.useState(0)
  const [isInSampleLoading, setIsInSampleLoading] = React.useState(false)
  // 移动端把图表总览的 11 张卡折叠展示，仅前 2 张默认展开（避免一次性挂载所有 echarts/plotly 实例）
  const isMobile = useIsMobile()

  const { data: reportData, isLoading, error } = useQuery({
    queryKey: ['report', expId, runId],
    queryFn: () => reportService.getFullReport(expId!, runId!),
    enabled: !!expId && !!runId,
  })

  const handleRunInSample = () => {
    setIsInSampleLoading(true)
    setInSampleTrigger(prev => prev + 1)
    const hide = message.loading({ content: '正在启动 In-Sample 回测...', duration: 0, key: 'insample' })
    
    setTimeout(() => {
      setIsInSampleLoading(false)
      hide()
    }, 3000)
  }

  const report = reportData?.data
  const km = report?.key_metrics as KeyMetrics | undefined
  const runInfo = (report?.run_info || {}) as Record<string, unknown>

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Text type="danger">加载报告失败</Text>
        <br /><br />
        <Button onClick={() => navigate(-1)}>返回</Button>
      </div>
    )
  }

  if (isLoading || !report) {
    return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
  }

  const runName = (runInfo.run_name as string) || runId || '未知运行'
  const status = (runInfo.status as string) || 'UNKNOWN'
  const durationSeconds = runInfo.duration_seconds as number | undefined

  return (
    <PageContainer
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/experiments/${expId}`)} size="small">
            返回实验
          </Button>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {runName}
          </span>
        </span>
      }
      tags={
        <Space size={8} wrap>
          <Tag color={STATUS_COLORS[status] || '#d9d9d9'} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11 }}>
            {status}
          </Tag>
          <Text type="secondary" style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11 }}>
            ID: {runId?.slice(0, 16)}...
          </Text>
          {durationSeconds && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              耗时: {(durationSeconds / 60).toFixed(1)}min
            </Text>
          )}
        </Space>
      }
    >
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6} md={4}>
          <MetricCard
            title="累计收益率"
            value={km?.cumulative_return ?? null}
            suffix="%"
            format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}`}
            color="#52c41a"
            tooltip="复利累计: (1+r1)*(1+r2)*...*(1+rn)-1"
            isCalculated={true}
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <MetricCard
            title="年化收益率"
            value={km?.annualized_return ?? null}
            suffix="%"
            format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}`}
            color="#52c41a"
            tooltip="复利年化: (1+累计收益)^(252/天数)-1，含交易成本"
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <MetricCard
            title="夏普比率"
            value={km?.sharpe_ratio ?? null}
            format={(v) => v.toFixed(3)}
            color="#1677ff"
            tooltip="Sharpe = mean(daily_return) / std(daily_return) * sqrt(252)"
            isCalculated={true}
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <MetricCard
            title="最大回撤"
            value={km?.max_drawdown ?? null}
            suffix="%"
            format={(v) => `${(Math.abs(v) * 100).toFixed(2)}`}
            color="#ff4d4f"
            tooltip="复利回撤: (累计净值/历史最高净值-1)的最小值，含交易成本"
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <MetricCard
            title="信息比率"
            value={km?.icir ?? km?.information_ratio ?? null}
            format={(v) => v.toFixed(3)}
            color="#1677ff"
            tooltip="IR = mean(策略收益-基准收益) / std(策略收益-基准收益) * sqrt(252)"
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <MetricCard
            title="Rank IC"
            value={km?.rank_ic ?? null}
            format={(v) => v.toFixed(4)}
            color="#722ed1"
            tooltip="Rank IC: 预测值与标签的秩相关系数"
          />
        </Col>
      </Row>

      <Tabs
        defaultActiveKey="overview"
        items={[
          {
            key: 'overview',
            label: <span><BarChartOutlined /> 图表总览</span>,
            children: (() => {
              // 11 张图统一为数组，桌面 Row/Col 网格，移动 Collapse 折叠
              const charts: Array<{
                key: string
                title: string
                /** 桌面占据的栅格宽度：'full' = 24 列；'half' = lg+ 占 12 列、xs 占 24 */
                span: 'full' | 'half'
                node: React.ReactNode
              }> = [
                { key: 'cumulative', title: '累计收益曲线', span: 'full', node: <CumulativeReturnChart data={report.portfolio_data} /> },
                { key: 'drawdown', title: '回撤分析', span: 'half', node: <DrawdownChart data={report.portfolio_data} /> },
                { key: 'turnover', title: '换手率', span: 'half', node: <TurnoverChart data={report.portfolio_data} /> },
                { key: 'ic', title: 'IC 时序分析', span: 'half', node: <ICChart data={report.ic_analysis} /> },
                { key: 'ic-dist', title: 'IC 分布直方图', span: 'half', node: <ICDistributionChart data={report.ic_analysis} /> },
                { key: 'pred-hist', title: '预测分数分布', span: 'half', node: <PredictionHistogram data={report.prediction_stats} /> },
                { key: 'pred-scatter', title: '预测 vs 标签散点图', span: 'half', node: <PredLabelScatterChart data={report.pred_label_data} /> },
                { key: 'rolling', title: '滚动统计 (20日)', span: 'half', node: <RollingStatsChart data={report.rolling_stats} /> },
                { key: 'monthly-hist', title: '月度收益直方图', span: 'half', node: <MonthlyReturnHistogram data={report.monthly_returns} /> },
                { key: 'monthly-heat', title: '月度收益热力图', span: 'half', node: <MonthlyReturnHeatmap data={report.monthly_returns} /> },
                { key: 'annual', title: '年度收益直方图', span: 'half', node: <AnnualReturnHistogram data={report.annual_returns} /> },
              ]

              // 用 LazyMount 包装：IntersectionObserver 接近视口 300px 才挂载，
              // 减少首屏 echarts/plotly 实例化开销；占位高度 300 防 CLS
              const lazyNode = (n: React.ReactNode) => (
                <LazyMount placeholderHeight={300} rootMargin="300px">
                  {n}
                </LazyMount>
              )

              if (isMobile) {
                // 移动端：Collapse 折叠展示，仅累计收益曲线 + 回撤分析默认展开
                // Collapse 内部本身有展开懒挂载效果，叠加 LazyMount 使展开后接近视口才挂载
                return (
                  <Collapse
                    defaultActiveKey={['cumulative', 'drawdown']}
                    bordered={false}
                    items={charts.map((c) => ({
                      key: c.key,
                      label: c.title,
                      children: lazyNode(c.node),
                      style: { background: 'var(--ap-panel)', marginBottom: 8, borderRadius: 8 },
                    }))}
                  />
                )
              }

              // 桌面：保持 Row/Col 网格，每个 chart 用 LazyMount 包裹
              return (
                <Row gutter={[16, 16]}>
                  {charts.map((c) =>
                    c.span === 'full' ? (
                      <Col span={24} key={c.key}>
                        <Card title={c.title} size="small">{lazyNode(c.node)}</Card>
                      </Col>
                    ) : (
                      <Col xs={24} lg={12} key={c.key}>
                        <Card title={c.title} size="small">{lazyNode(c.node)}</Card>
                      </Col>
                    ),
                  )}
                </Row>
              )
            })(),
          },
          {
            key: 'model',
            label: <span><SettingOutlined /> 模型参数</span>,
            children: (
              <ModelParamsPanel params={report.model_params} config={report.tags?.config_snapshot as unknown as Record<string, unknown> | undefined} />
            ),
          },
          {
            key: 'metrics',
            label: (
              <Tooltip title="指标基于QLib单利计算: 累计收益=sum(r)，年化收益=mean(r)*252">
                <span><TableOutlined /> 完整指标</span>
              </Tooltip>
            ),
            children: (
              <FullMetricsTable metrics={report.all_metrics_raw} />
            ),
          },
          {
            key: 'qlib',
            label: (
              <Tooltip title="QLib标准分析图表，基于单利计算">
                <span><BarChartOutlined /> QLib分析</span>
              </Tooltip>
            ),
            children: (
              <QLibAnalysisPanel expId={expId!} runId={runId!} />
            ),
          },
          {
            key: 'insample',
            label: (
              <Tooltip title="In-Sample分析，基于复利计算">
                <span><ExperimentOutlined /> In-Sample分析</span>
              </Tooltip>
            ),
            children: <InSampleAnalysisPanel expId={expId!} runId={runId!} externalTrigger={inSampleTrigger} />,
          },
          {
            key: 'interpretability',
            label: (
              <Tooltip title="模型可解释性分析：特征重要性与SHAP值">
                <span><BulbOutlined /> 模型解释</span>
              </Tooltip>
            ),
            children: <ModelInterpretabilityPanel expId={expId!} runId={runId!} />,
          },
        ]}
      />
    </PageContainer>
  )
}

export default ReportPage
