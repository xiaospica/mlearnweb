import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Row, Col, Card, Typography, Tabs, Tag, Button, Space, Spin, Table, Descriptions, Empty, Tooltip } from 'antd'
import { ArrowLeftOutlined, BarChartOutlined, SettingOutlined, TableOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import Plot from 'react-plotly.js'
import dayjs from 'dayjs'
import { reportService } from '@/services/reportService'
import type { ReportData, KeyMetrics } from '@/types'

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
      {figures.ic_figures?.map((fig, i) => (
        <Col xs={24} lg={12} key={`ic-${i}`}>
          <Card title={`IC分析 ${i + 1}`} size="small">
            <Plot 
              data={fig.data} 
              layout={{ ...fig.layout, height: 350, autosize: true }} 
              style={{ width: '100%', minHeight: 350 }} 
            />
          </Card>
        </Col>
      ))}
      {figures.model_figures?.map((fig, i) => (
        <Col xs={24} lg={12} key={`model-${i}`}>
          <Card title={`模型性能 ${i + 1}`} size="small">
            <Plot 
              data={fig.data} 
              layout={{ ...fig.layout, height: 350, autosize: true }} 
              style={{ width: '100%', minHeight: 350 }} 
            />
          </Card>
        </Col>
      ))}
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

  const grouped = entries.reduce<Record<string, Array<[string, unknown]>>>((acc, [k, v]) => {
    const group = k.includes('IC') ? 'IC指标' :
      k.includes('return') || k.includes('drawdown') || k.includes('sharpe') ? '收益/风险' :
      k.includes('l2.') ? '模型损失' :
      k.includes('turnover') ? '交易成本' : '其他'
    if (!acc[group]) acc[group] = []
    acc[group].push([k, v])
    return acc
  }, {})

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
        ...Object.entries(grouped).map(([group, items]) => ({
          key: group,
          label: `${group} (${items.length})`,
          children: (
            <Table
              size="small"
              dataSource={items.map(([k, v]) => ({ key: k, value: typeof v === 'number' ? v.toFixed(6) : String(v) }))}
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

const ReportPage: React.FC = () => {
  const { expId, runId } = useParams<{ expId: string; runId: string }>()
  const navigate = useNavigate()

  const { data: reportData, isLoading, error } = useQuery({
    queryKey: ['report', expId, runId],
    queryFn: () => reportService.getFullReport(expId!, runId!),
    enabled: !!expId && !!runId,
  })

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
        ]}
      />
    </div>
  )
}

export default ReportPage
