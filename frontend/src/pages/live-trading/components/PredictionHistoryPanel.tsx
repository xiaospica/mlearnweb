/**
 * 历史预测回溯 — 日期选择 + 该日 TopK 表 + 该日概况.
 * 挂在 MlMonitorPanel 的最底部.
 */
import React, { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Alert,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Spin,
  Statistic,
  Table,
  Typography,
} from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import type { ColumnsType } from 'antd/es/table'
import { mlMonitoringService } from '@/services/mlMonitoringService'
import type { TopkEntry } from '@/services/mlMonitoringService'

const { Text } = Typography

interface Props {
  nodeId: string
  strategyName: string
  historyDates: string[]  // trade_dates 在时序里可用的(升序),用于 DatePicker 可选范围
}

const topkColumns: ColumnsType<TopkEntry> = [
  { title: '#', dataIndex: 'rank', key: 'rank', width: 48, align: 'center' },
  { title: '股票', dataIndex: 'instrument', key: 'instrument', width: 120 },
  {
    title: '预测分数',
    dataIndex: 'score',
    key: 'score',
    width: 120,
    align: 'right',
    render: (v: number | null | undefined) =>
      v === null || v === undefined ? '—' : v.toFixed(4),
  },
  {
    title: '权重',
    dataIndex: 'weight',
    key: 'weight',
    width: 100,
    align: 'right',
    render: (v: number | null | undefined) =>
      v === null || v === undefined ? '—' : `${(v * 100).toFixed(2)}%`,
  },
]

function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

const PredictionHistoryPanel: React.FC<Props> = ({ nodeId, strategyName, historyDates }) => {
  // Default to most recent date in history
  const latestDate = historyDates.length > 0 ? historyDates[historyDates.length - 1] : null
  const [selected, setSelected] = useState<Dayjs | null>(latestDate ? dayjs(latestDate) : null)

  const yyyymmdd = selected ? selected.format('YYYYMMDD') : null

  const { data, isLoading } = useQuery({
    queryKey: ['ml-prediction-by-date', nodeId, strategyName, yyyymmdd],
    queryFn: () =>
      mlMonitoringService.predictionByDate(nodeId, strategyName, yyyymmdd as string),
    enabled: !!yyyymmdd,
    staleTime: 60000,
    retry: 1,
  })

  const summary = data?.success ? data.data : null
  const notFoundMessage = data && !data.success ? (data.warning || data.message) : null

  const availableDatesSet = useMemo(() => new Set(historyDates), [historyDates])

  return (
    <Card
      title={<span>历史预测回溯</span>}
      style={{ marginTop: 12 }}
      extra={
        <DatePicker
          value={selected}
          onChange={(d) => setSelected(d)}
          format="YYYY-MM-DD"
          disabledDate={(d) =>
            !availableDatesSet.has(d.format('YYYY-MM-DD'))
          }
          placeholder="选择历史日期"
          allowClear={false}
        />
      }
    >
      {!yyyymmdd ? (
        <Empty description="请选择一个历史日期" />
      ) : isLoading ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : notFoundMessage ? (
        <Alert type="warning" showIcon message={notFoundMessage} />
      ) : !summary ? (
        <Empty description="当日无预测记录" />
      ) : (
        <div>
          <Row gutter={16} style={{ marginBottom: 12 }}>
            <Col xs={12} sm={6}>
              <Statistic title="样本数" value={summary.n_symbols ?? 0} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic title="pred_mean" value={fmtNum(summary.pred_mean)} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic title="pred_std" value={fmtNum(summary.pred_std)} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="模型版本"
                value={summary.model_run_id?.slice(0, 8) || '—'}
              />
            </Col>
          </Row>
          <Text type="secondary" style={{ fontSize: 12 }}>
            trade_date: {summary.trade_date || yyyymmdd} · status: {summary.status || '—'}
          </Text>
          <div style={{ marginTop: 12 }}>
            {summary.topk && summary.topk.length > 0 ? (
              <Table<TopkEntry>
                size="small"
                rowKey={(r) => `${r.rank}-${r.instrument}`}
                dataSource={summary.topk as TopkEntry[]}
                columns={topkColumns}
                pagination={false}
              />
            ) : (
              <Empty description="当日无 TopK 数据" />
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

export default PredictionHistoryPanel
