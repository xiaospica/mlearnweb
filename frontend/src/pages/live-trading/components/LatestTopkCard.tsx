/**
 * 最新 TopK 信号 — 从 latest prediction summary 读 selections top-N.
 * 挂在 Tab1 "收益曲线与持仓" 的 "当前持仓" 之后.
 */
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Empty, Spin, Table, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { mlMonitoringService } from '@/services/mlMonitoringService'
import type { TopkEntry } from '@/services/mlMonitoringService'

const { Text } = Typography

interface Props {
  nodeId: string
  strategyName: string
}

const columns: ColumnsType<TopkEntry> = [
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

const LatestTopkCard: React.FC<Props> = ({ nodeId, strategyName }) => {
  const { data, isLoading } = useQuery({
    queryKey: ['ml-topk-latest', nodeId, strategyName],
    queryFn: () => mlMonitoringService.predictionLatestSummary(nodeId, strategyName),
    refetchInterval: 60000,
    staleTime: 30000,
    retry: 1,
  })

  const summary = data?.success ? data.data : null
  const topk = summary?.topk || []

  return (
    <Card
      title={
        <div>
          最新 TopK 信号
          {summary?.trade_date && (
            <Text type="secondary" style={{ marginLeft: 12, fontSize: 12, fontWeight: 'normal' }}>
              trade_date: {summary.trade_date}
              {summary.model_run_id &&
                ` · model: ${summary.model_run_id.slice(0, 8)}`}
            </Text>
          )}
        </div>
      }
      style={{ marginTop: 16 }}
      styles={{ body: { padding: 0 } }}
    >
      {isLoading ? (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin size="small" />
        </div>
      ) : topk.length === 0 ? (
        <div style={{ padding: 24 }}>
          <Empty description="暂无 TopK 数据 (策略未跑过推理或 selections.parquet 未写入)" />
        </div>
      ) : (
        <Table<TopkEntry>
          size="small"
          rowKey={(r) => `${r.rank}-${r.instrument}`}
          dataSource={topk as TopkEntry[]}
          columns={columns}
          pagination={false}
        />
      )}
    </Card>
  )
}

export default LatestTopkCard
