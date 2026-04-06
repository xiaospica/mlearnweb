import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Row, Col, Card, Typography, Tabs, Tag, Button, Space, Spin, Table, Descriptions, Empty, Tooltip, message, notification } from 'antd'
import { ArrowLeftOutlined, BarChartOutlined, SettingOutlined, TableOutlined, InfoCircleOutlined, ExperimentOutlined, LoadingOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import Plot from 'react-plotly.js'
import dayjs from 'dayjs'
import { reportService } from '@/services/reportService'
import { trainingService } from '@/services/trainingService'
import type { ReportData, KeyMetrics, InSampleBacktestResponse, InSampleSegmentResult } from '@/types'

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
        background: '#ffffff',
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
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
          color: numValue !== null ? (isPositive ? (title.includes('回撤') || title.includes('Drawdown') ? '#ff4d4f' : '#1677ff') : '#ff4d4f') : '#9ca3af',
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

const PredLabelScatterChart: React.FC<{ data?: { available: boolean; labels?: number[]; scores?: number[]; correlation?: number; count?: number } }> = ({ data }) => {
  if (!data?.available || !data.labels || !data.scores) {
    return <Empty description="无预测-标签数据" style={{ padding: 40 }} />
  }

  const { labels, scores, correlation, count } = data
  const sampleData = labels.map((label, i) => [scores[i], label]).slice(0, 3000)

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>样本数: <Text strong>{count}</Text></Text>
        <Text type="secondary" style={{ fontSize: 12 }}>相关系数: <Text strong style={{ color: correlation && correlation > 0 ? '#52c41a' : '#ff4d4f' }}>{correlation?.toFixed(4) || '-'}</Text></Text>
      </div>
      <ReactECharts
        option={{
          tooltip: { trigger: 'item', backgroundColor: '#fff', borderColor: '#e8e8e8', textStyle: { color: '#374151' }, formatter: (p: any) => `Score: ${p.value[0]?.toFixed(4)}<br/>Label: ${p.value[1]?.toFixed(4)}` },
          grid: { left: 60, right: 30, top: 20, bottom: 40 },
          xAxis: { name: '预测分数', nameLocation: 'middle', nameGap: 25, axisLabel: { color: '#9ca3af', fontSize: 10 }, axisLine: { lineStyle: { color: '#e5e7eb' } } },
          yAxis: { name: '真实标签', nameLocation: 'middle', nameGap: 40, axisLabel: { color: '#9ca3af', fontSize: 10 }, axisLine: { lineStyle: { color: '#e5e7eb' } }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
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
        style={{ height: 280 }}
      />
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
          axisLabel: { color: '#9ca3af', formatter: '{value}%' },
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
  const minVal = Math.min(...values) * 1.2
  const maxVal = Math.max(...values) * 1.2

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
          <Descriptions column={3} size="small" bordered>
            <Descriptions.Item label="样本总数">{sample_count || 0}</Descriptions.Item>
            <Descriptions.Item label="方向准确率">
              <Text style={{ color: direction_accuracy && direction_accuracy > 0.5 ? '#52c41a' : '#ff4d4f' }}>
                {direction_accuracy ? (direction_accuracy * 100).toFixed(2) + '%' : '-'}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="Rank IC">
              <Text style={{ color: rank_ic && rank_ic > 0 ? '#52c41a' : '#ff4d4f' }}>
                {rank_ic?.toFixed(4) || '-'}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="MSE">{mse?.toExponential(4) || '-'}</Descriptions.Item>
            <Descriptions.Item label="MAE">{mae?.toExponential(4) || '-'}</Descriptions.Item>
            <Descriptions.Item label="多空收益差">
              <Text style={{ color: quantile_analysis?.long_short_return && quantile_analysis.long_short_return > 0 ? '#52c41a' : '#ff4d4f' }}>
                {quantile_analysis?.long_short_return ? ((quantile_analysis.long_short_return) * 100).toFixed(3) + '%' : '-'}
              </Text>
            </Descriptions.Item>
          </Descriptions>
        </Card>
      </Col>

      {classificationData.length > 0 && (
        <Col xs={24} lg={12}>
          <Card title="分类指标 (阈值=0)" size="small">
            <Table
              size="small"
              dataSource={classificationData}
              pagination={false}
              columns={[
                { title: '指标', dataIndex: 'key', key: 'key', render: (t: string) => <Text code style={{ color: '#1677ff', fontSize: 13 }}>{t}</Text> },
                { title: '值', dataIndex: 'value', key: 'value', align: 'right', render: (t: string) => <Text strong style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14 }}>{t}</Text> },
                { title: '说明', dataIndex: 'desc', key: 'desc', render: (t: string) => <Text type="secondary" style={{ fontSize: 11 }}>{t}</Text> },
              ]}
              rowKey="key"
            />
          </Card>
        </Col>
      )}

      {confusionMatrixData.length > 0 && (
        <Col xs={24} lg={12}>
          <Card title="混淆矩阵" size="small">
            <Table
              size="small"
              dataSource={confusionMatrixData}
              pagination={false}
              columns={[
                { title: '指标', dataIndex: 'key', key: 'key', render: (t: string) => <Text code style={{ color: '#722ed1', fontSize: 13 }}>{t}</Text> },
                { title: '数量', dataIndex: 'value', key: 'value', align: 'right', render: (t: string) => <Text strong style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14 }}>{t}</Text> },
                { title: '说明', dataIndex: 'desc', key: 'desc', render: (t: string) => <Text type="secondary" style={{ fontSize: 11 }}>{t}</Text> },
              ]}
              rowKey="key"
            />
          </Card>
        </Col>
      )}

      {quantileData.length > 0 && (
        <Col xs={24} lg={12}>
          <Card title="分位数收益分析 (5组)" size="small">
            <Table
              size="small"
              dataSource={quantileData}
              pagination={false}
              columns={[
                { title: '分组', dataIndex: 'key', key: 'key', width: 80, render: (t: string) => <Tag color={['#ff4d4f', '#ff7875', '#faad14', '#95de64', '#52c41a'][['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].indexOf(t)]}>{t}</Tag> },
                { title: '平均收益', dataIndex: 'value', key: 'value', align: 'right', render: (t: string) => <Text strong style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 14, color: t.includes('-') ? '#ff4d4f' : '#52c41a' }}>{t}</Text> },
                { title: '说明', dataIndex: 'desc', key: 'desc', render: (t: string) => <Text type="secondary" style={{ fontSize: 11 }}>{t}</Text> },
              ]}
              rowKey="key"
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
      <Descriptions
        size="small"
        column={2}
        bordered
        style={{ marginBottom: 16 }}
        labelStyle={{ color: '#6b7280', background: '#fafafa', width: 120 }}
        contentStyle={{ color: '#374151', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 13 }}
      >
        <Descriptions.Item label="模型类名">{String(modelInfo.class || '-')}</Descriptions.Item>
        <Descriptions.Item label="模块路径">{String(modelInfo.module_path || '-')}</Descriptions.Item>
        <Descriptions.Item label="数据集类名">{String(datasetInfo.class || '-')}</Descriptions.Item>
        <Descriptions.Item label="数据集模块">{String((datasetInfo as Record<string, unknown>).module_path || '-')}</Descriptions.Item>
      </Descriptions>

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
}> = ({ title, value, format, suffix = '', segmentColor, highlight = false }) => {
  const displayValue = value == null ? '-' : (format ? format(value) : value.toFixed(4))
  const isPositive = value != null && value > 0

  return (
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
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="年化收益"
              value={rm.annualized_return}
              format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`}
              segmentColor={config.color}
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="夏普比率"
              value={rm.sharpe_ratio}
              format={(v) => v.toFixed(3)}
              segmentColor={config.color}
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="最大回撤"
              value={rm.max_drawdown}
              format={(v) => `${(Math.abs(v) * 100).toFixed(2)}%`}
              segmentColor={config.color}
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="信息比率"
              value={rm.information_ratio}
              format={(v) => v.toFixed(3)}
              segmentColor={config.color}
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="年化波动率"
              value={rm.annualized_volatility}
              format={(v) => `${(v * 100).toFixed(2)}%`}
              segmentColor={config.color}
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="胜率"
              value={rm.win_rate}
              format={(v) => `${(v * 100).toFixed(1)}%`}
              segmentColor={config.color}
            />
          </Col>
          <Col span={12}>
            <InSampleMetricCard
              title="超额年化收益"
              value={rm.excess_annualized_return}
              format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`}
              segmentColor={config.color}
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
    queryFn: () => trainingService.getExistingInSampleResults(expId, runId),
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
    <div>
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/experiments/${expId}`)}>
          返回实验
        </Button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Title level={4} style={{ color: '#1f2937', margin: 0 }} ellipsis>
            {runName}
          </Title>
          <Space size={12}>
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
        </div>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6} md={4}>
          <MetricCard
            title="累计收益率"
            value={km?.cumulative_return ?? null}
            suffix="%"
            format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}`}
            color="#52c41a"
            tooltip="累计收益率 = (1 + r1) * (1 + r2) * ... * (1 + rn) - 1"
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
            tooltip="含交易成本的年化收益率 (with_cost)"
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
            tooltip="含交易成本的最大回撤 (with_cost)"
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <MetricCard
            title="信息比率(ICIR)"
            value={km?.icir ?? km?.information_ratio ?? null}
            format={(v) => v.toFixed(3)}
            color="#1677ff"
            tooltip="ICIR = IC均值 / IC标准差"
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
            children: (
              <Row gutter={[16, 16]}>
                <Col span={24}>
                  <Card title="累计收益曲线" size="small">
                    <CumulativeReturnChart data={report.portfolio_data} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="回撤分析" size="small">
                    <DrawdownChart data={report.portfolio_data} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="换手率" size="small">
                    <TurnoverChart data={report.portfolio_data} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="IC 时序分析" size="small">
                    <ICChart data={report.ic_analysis} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="IC 分布直方图" size="small">
                    <ICDistributionChart data={report.ic_analysis} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="预测分数分布" size="small">
                    <PredictionHistogram data={report.prediction_stats} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="预测 vs 标签散点图" size="small">
                    <PredLabelScatterChart data={report.pred_label_data} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="滚动统计 (20日)" size="small">
                    <RollingStatsChart data={report.rolling_stats} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="月度收益直方图" size="small">
                    <MonthlyReturnHistogram data={report.monthly_returns} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="月度收益热力图" size="small">
                    <MonthlyReturnHeatmap data={report.monthly_returns} />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card title="年度收益直方图" size="small">
                    <AnnualReturnHistogram data={report.annual_returns} />
                  </Card>
                </Col>
              </Row>
            ),
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
            label: <span><TableOutlined /> 完整指标</span>,
            children: (
              <FullMetricsTable metrics={report.all_metrics_raw} />
            ),
          },
          {
            key: 'qlib',
            label: <span><BarChartOutlined /> QLib分析</span>,
            children: (
              <QLibAnalysisPanel expId={expId!} runId={runId!} />
            ),
          },
          {
            key: 'insample',
            label: <span><ExperimentOutlined /> In-Sample分析</span>,
            children: <InSampleAnalysisPanel expId={expId!} runId={runId!} externalTrigger={inSampleTrigger} />,
          },
        ]}
      />
    </div>
  )
}

export default ReportPage
