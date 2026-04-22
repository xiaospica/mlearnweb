import React, { useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Col, Empty, Row, Space, Spin, Table, Tag, Typography } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { trainingService } from '@/services/trainingService'
import type { TrainingCompareRecord } from '@/types'

const { Title, Text } = Typography

const PALETTE = ['#1677ff', '#722ed1', '#fa8c16']

const METRIC_ROWS: Array<{ key: string; label: string; format: (v: number) => string; better: 'higher' | 'lower' }> = [
  { key: 'total_return', label: '总收益', format: (v) => `${(v * 100).toFixed(2)}%`, better: 'higher' },
  { key: 'annualized_return', label: '年化收益', format: (v) => `${(v * 100).toFixed(2)}%`, better: 'higher' },
  { key: 'sharpe_ratio', label: 'Sharpe', format: (v) => v.toFixed(3), better: 'higher' },
  { key: 'sortino_ratio', label: 'Sortino', format: (v) => v.toFixed(3), better: 'higher' },
  { key: 'calmar_ratio', label: 'Calmar', format: (v) => v.toFixed(3), better: 'higher' },
  { key: 'max_drawdown', label: '最大回撤', format: (v) => `${(v * 100).toFixed(2)}%`, better: 'higher' }, // drawdown is negative; higher is better
  { key: 'win_rate', label: '胜率', format: (v) => `${(v * 100).toFixed(2)}%`, better: 'higher' },
  { key: 'excess_annualized_return', label: '超额年化', format: (v) => `${(v * 100).toFixed(2)}%`, better: 'higher' },
  { key: 'information_ratio', label: '信息比率', format: (v) => v.toFixed(3), better: 'higher' },
]

function computeDrawdown(cum: number[]): number[] {
  const dd: number[] = []
  let peak = -Infinity
  for (const v of cum) {
    if (v > peak) peak = v
    const base = 1 + peak
    dd.push(base > 0 ? (1 + v) / base - 1 : 0)
  }
  return dd
}

function icStats(values: Array<number | null | undefined>): { meanIC: number; icir: number; count: number } {
  const valid = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (valid.length === 0) return { meanIC: NaN, icir: NaN, count: 0 }
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length
  const variance = valid.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, valid.length - 1)
  const std = Math.sqrt(variance)
  return { meanIC: mean, icir: std > 0 ? mean / std : NaN, count: valid.length }
}

const RecordHeaderChip: React.FC<{ record: TrainingCompareRecord; color: string; index: number }> = ({ record, color, index }) => (
  <Space size={6}>
    <Tag color={color} style={{ fontSize: 12 }}>对照 {String.fromCharCode(65 + index)}</Tag>
    <Text strong style={{ color: '#1f2937' }}>{record.name || `#${record.id}`}</Text>
    <Text type="secondary" style={{ fontSize: 11 }}>ID: {record.id}</Text>
    {record.category && <Tag>{record.category}</Tag>}
  </Space>
)

const MetricsCompareTable: React.FC<{ records: TrainingCompareRecord[] }> = ({ records }) => {
  const dataSource = METRIC_ROWS.map((row) => {
    const rec: Record<string, unknown> = { key: row.key, metric: row.label }
    const rawValues = records.map((r) => {
      const v = r.merged_metrics?.[row.key]
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    })
    const validValues = rawValues.filter((v): v is number => v != null)
    const bestValue = validValues.length
      ? row.better === 'higher' ? Math.max(...validValues) : Math.min(...validValues)
      : null
    records.forEach((r, i) => {
      const v = rawValues[i]
      rec[`val_${r.id}`] = v == null ? '-' : row.format(v)
      rec[`best_${r.id}`] = v != null && bestValue != null && v === bestValue && validValues.length > 1
    })
    return rec
  })

  const columns: Array<Record<string, unknown>> = [
    { title: '指标', dataIndex: 'metric', key: 'metric', fixed: 'left', width: 140, render: (t: string) => <Text strong>{t}</Text> },
    ...records.map((r, idx) => ({
      title: <Tag color={PALETTE[idx]}>{r.name || `#${r.id}`}</Tag>,
      dataIndex: `val_${r.id}`,
      key: `val_${r.id}`,
      align: 'right' as const,
      render: (val: string, row: Record<string, unknown>) => {
        const isBest = row[`best_${r.id}`] as boolean
        return (
          <Text
            strong={isBest}
            style={{
              fontFamily: "'SF Mono', 'Consolas', monospace",
              color: isBest ? '#52c41a' : '#374151',
            }}
          >
            {val}
          </Text>
        )
      },
    })),
  ]

  return <Table size="small" pagination={false} columns={columns as any} dataSource={dataSource} rowKey="key" />
}

const OverlayTimeSeriesChart: React.FC<{
  records: TrainingCompareRecord[]
  extract: (r: TrainingCompareRecord) => { dates?: string[]; values?: Array<number | null | undefined>; valueTransform?: (v: number) => number }
  title: string
  yFormat?: (v: number) => string
  height?: number
}> = ({ records, extract, title, yFormat, height = 280 }) => {
  const perRecord = records.map((r, idx) => {
    const data = extract(r)
    if (!data.dates || !data.values) return null
    const transform = data.valueTransform || ((v: number) => v)
    const map = new Map<string, number | null>()
    data.dates.forEach((d, i) => {
      const v = data.values![i]
      map.set(d, typeof v === 'number' && Number.isFinite(v) ? transform(v) : null)
    })
    return { record: r, idx, dates: data.dates, map }
  })

  const usable = perRecord.filter((p): p is NonNullable<typeof p> => p !== null && p.dates.length > 0)
  if (usable.length === 0) {
    return <Empty description={`${title} 无数据`} style={{ padding: 40 }} />
  }

  const allDates = Array.from(new Set(usable.flatMap((p) => p.dates))).sort()

  const series = usable.map(({ record, idx, map }) => {
    const aligned = allDates.map((d) => (map.has(d) ? map.get(d)! : null))
    const color = PALETTE[idx] || '#1677ff'
    return {
      name: record.name || `#${record.id}`,
      type: 'line',
      data: aligned,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { width: idx === 0 ? 2 : 1.5, color },
      itemStyle: { color },
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
          valueFormatter: yFormat ? (v: unknown) => (typeof v === 'number' ? yFormat(v) : '-') : undefined,
        },
        legend: { data: series.map((s) => s.name), top: 0, textStyle: { color: '#6b7280' } },
        grid: { left: 70, right: 30, top: 30, bottom: 60 },
        xAxis: {
          type: 'category',
          data: allDates,
          axisLabel: { color: '#9ca3af', fontSize: 10 },
          axisLine: { lineStyle: { color: '#e5e7eb' } },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          axisLabel: { color: '#9ca3af', formatter: yFormat },
          splitLine: { lineStyle: { color: '#f0f0f0' } },
        },
        dataZoom: [
          { type: 'slider', start: 0, end: 100, height: 20, bottom: 5, borderColor: '#e5e7eb', fillerColor: 'rgba(22,119,255,0.1)', handleStyle: { color: '#1677ff' } },
          { type: 'inside', start: 0, end: 100 },
        ],
        series,
      }}
      style={{ height }}
      notMerge
    />
  )
}

// 将 Python 字面量字符串（如 "{'class': 'LGBModel', 'kwargs': {...}}"）尝试转为 JS 对象。
// 失败时返回原字符串。
function parsePythonLiteral(raw: string): unknown {
  const t = raw.trim()
  if (!t) return raw
  const first = t[0]
  if (first !== '{' && first !== '[' && first !== "'" && first !== '"') return raw
  // Python True/False/None → JS true/false/null；单引号字符串 → 双引号
  // 下面的替换处理大多数 qlib config 场景；非标准时回退为原字符串
  let s = t
  // True/False/None 作为独立 token
  s = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
  // 把 '...' 字符串（不包含已转义的 '）替换成 "..."。为保险处理最常见情况：
  // 先把已有的 " 转义，再把 ' 换成 "
  s = s.replace(/\\"/g, '__DQ__').replace(/"/g, '\\"').replace(/'/g, '"').replace(/__DQ__/g, '\\"')
  try {
    return JSON.parse(s)
  } catch {
    return raw
  }
}

function normalizeConfigForDiff(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    const parsed = parsePythonLiteral(value)
    if (parsed !== value && (typeof parsed === 'object' || Array.isArray(parsed))) {
      return normalizeConfigForDiff(parsed)
    }
    return value
  }
  if (Array.isArray(value)) return value.map(normalizeConfigForDiff)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeConfigForDiff(v)
    }
    return out
  }
  return value
}

const ConfigDiffPanel: React.FC<{ records: TrainingCompareRecord[] }> = ({ records }) => {
  const diffs = useMemo(() => {
    if (records.length < 2) return []
    const base = records[0]
    const baseText = JSON.stringify(normalizeConfigForDiff(base.config_snapshot || {}), null, 2)
    return records.slice(1).map((other) => ({
      left: base,
      right: other,
      leftText: baseText,
      rightText: JSON.stringify(normalizeConfigForDiff(other.config_snapshot || {}), null, 2),
    }))
  }, [records])

  if (diffs.length === 0) return <Empty description="无配置数据" />

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {diffs.map((d, i) => (
        <Card
          key={i}
          size="small"
          title={
            <Space>
              <Tag color={PALETTE[0]}>A: {d.left.name || `#${d.left.id}`}</Tag>
              <Text type="secondary">vs</Text>
              <Tag color={PALETTE[i + 1]}>{`${String.fromCharCode(66 + i)}`}: {d.right.name || `#${d.right.id}`}</Tag>
            </Space>
          }
        >
          <div style={{ fontSize: 12 }}>
            <ReactDiffViewer
              oldValue={d.leftText}
              newValue={d.rightText}
              splitView
              compareMethod={DiffMethod.WORDS}
              useDarkTheme={false}
              hideLineNumbers={false}
              extraLinesSurroundingDiff={2}
              styles={{ contentText: { fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11 } }}
            />
          </div>
        </Card>
      ))}
    </Space>
  )
}

const TrainingComparePage: React.FC = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const ids = useMemo(() => {
    const raw = searchParams.get('ids') || ''
    return raw
      .split(',')
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n))
  }, [searchParams])

  const { data, isLoading, error } = useQuery({
    queryKey: ['training-compare', ids.join(',')],
    queryFn: () => trainingService.compare(ids),
    enabled: ids.length >= 2 && ids.length <= 3,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  if (ids.length < 2 || ids.length > 3) {
    return (
      <div style={{ padding: 24 }}>
        <Alert type="warning" showIcon message="对比需要 2~3 条训练记录" description="请回到训练记录列表，勾选 2~3 条后再点击对比。" />
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')} style={{ marginTop: 16 }}>
          返回列表
        </Button>
      </div>
    )
  }

  if (isLoading) {
    return <Spin tip="加载对比数据..." style={{ display: 'block', margin: '80px auto' }} />
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <Alert type="error" showIcon message="加载失败" description={(error as Error).message} />
      </div>
    )
  }

  const records = data?.data?.records || []
  const availableRecords = records.filter((r) => r.available)

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 16 }} size={12}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回列表</Button>
        <Title level={4} style={{ margin: 0 }}>训练记录对比</Title>
      </Space>

      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card size="small" title="对比对象">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {records.map((r, idx) => (
                <div key={r.id}>
                  <RecordHeaderChip record={r} color={PALETTE[idx]} index={idx} />
                  {!r.available && (
                    <Text type="danger" style={{ marginLeft: 12, fontSize: 12 }}>
                      （数据不可用: {r.error || '未知错误'}）
                    </Text>
                  )}
                </div>
              ))}
            </Space>
          </Card>
        </Col>

        {availableRecords.length < 2 ? (
          <Col span={24}>
            <Empty description="可用对比记录不足 2 条（需要已完成的滚动/单次训练记录）" style={{ padding: 60 }} />
          </Col>
        ) : (
          <>
            <Col span={24}>
              <Card size="small" title="关键指标对比">
                <MetricsCompareTable records={availableRecords} />
              </Card>
            </Col>

            <Col span={24}>
              <Card size="small" title="累计收益率（overlay）">
                <OverlayTimeSeriesChart
                  records={availableRecords}
                  extract={(r) => ({
                    dates: r.merged_report?.dates,
                    values: r.merged_report?.cumulative_return,
                    valueTransform: (v) => v,
                  })}
                  title="累计收益率"
                  yFormat={(v) => `${(v * 100).toFixed(2)}%`}
                />
              </Card>
            </Col>

            <Col span={24}>
              <Card size="small" title="回撤曲线（overlay，基于累计收益衍生）">
                <OverlayTimeSeriesChart
                  records={availableRecords}
                  extract={(r) => {
                    const cum = r.merged_report?.cumulative_return
                    if (!cum) return {}
                    return { dates: r.merged_report?.dates, values: computeDrawdown(cum) }
                  }}
                  title="回撤"
                  yFormat={(v) => `${(v * 100).toFixed(2)}%`}
                />
              </Card>
            </Col>

            <Col span={24}>
              <Card
                size="small"
                title={
                  <Space>
                    <span>IC 时序（overlay）</span>
                    <Text type="secondary" style={{ fontSize: 11, fontWeight: 'normal' }}>
                      {availableRecords.map((r, i) => {
                        const s = icStats(r.ic_analysis?.ic_values || [])
                        return (
                          <span key={r.id} style={{ marginRight: 12 }}>
                            <Tag color={PALETTE[i]}>{r.name || `#${r.id}`}</Tag>
                            mean IC: <Text code>{Number.isFinite(s.meanIC) ? s.meanIC.toFixed(4) : '-'}</Text> |
                            ICIR: <Text code>{Number.isFinite(s.icir) ? s.icir.toFixed(3) : '-'}</Text>
                          </span>
                        )
                      })}
                    </Text>
                  </Space>
                }
              >
                <OverlayTimeSeriesChart
                  records={availableRecords}
                  extract={(r) => ({
                    dates: r.ic_analysis?.dates,
                    values: r.ic_analysis?.ic_values,
                  })}
                  title="IC"
                  yFormat={(v) => v.toFixed(4)}
                />
              </Card>
            </Col>

            <Col span={24}>
              <Card size="small" title="换手率（overlay，折线形式）">
                <OverlayTimeSeriesChart
                  records={availableRecords}
                  extract={(r) => ({
                    dates: r.merged_report?.dates,
                    values: r.merged_report?.turnover,
                  })}
                  title="换手率"
                  yFormat={(v) => `${(v * 100).toFixed(1)}%`}
                  height={260}
                />
              </Card>
            </Col>

            <Col span={24}>
              <Card size="small" title="配置快照 diff（side-by-side）">
                <ConfigDiffPanel records={availableRecords} />
              </Card>
            </Col>
          </>
        )}
      </Row>
    </div>
  )
}

export default TrainingComparePage
