/**
 * 最新 TopK 信号 — 从 latest prediction summary 读 selections top-N.
 * 挂在 Tab1 "收益曲线与持仓" 的 "当前持仓" 之后.
 *
 * Stale-while-error: RPC 超时或业务失败时, 保留上次成功的 topk 继续展示,
 * 顶部加黄色 Alert 提示"节点暂时异常", 而不是清空.
 */
import React, { useEffect, useRef } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Alert, Card, Empty, Spin, Table, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { mlMonitoringService } from '@/services/mlMonitoringService'
import type { PredictionSummary, TopkEntry } from '@/services/mlMonitoringService'
import {
  ML_MONITOR_FALLBACK_REFRESH_MS,
  ML_MONITOR_STALE_MS,
  liveFallbackInterval,
  liveTradingQueryKeys,
} from '../liveTradingRefresh'

const { Text } = Typography

interface Props {
  nodeId: string
  strategyName: string
  eventsConnected: boolean
}

const columns: ColumnsType<TopkEntry> = [
  {
    // 合约列与"持仓表"PositionsTable 风格一致 (名称 + 灰色 vt_symbol 单元格内合并)
    title: '合约',
    key: 'instrument',
    width: 200,
    render: (_: unknown, r: TopkEntry) => (
      <span>
        {r.name && <span style={{ marginRight: 6, color: 'var(--ap-text)' }}>{r.name}</span>}
        <span style={{ color: 'var(--ap-text-muted)', fontSize: 12 }}>{r.instrument}</span>
      </span>
    ),
  },
  {
    title: '推理排名',
    dataIndex: 'rank',
    key: 'rank',
    width: 80,
    align: 'center',
    render: (v: number | null | undefined) => (v == null ? '—' : `#${v}`),
  },
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

const LatestTopkCard: React.FC<Props> = ({ nodeId, strategyName, eventsConnected }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: liveTradingQueryKeys.mlTopkLatest(nodeId, strategyName),
    queryFn: () => mlMonitoringService.predictionLatestSummary(nodeId, strategyName),
    refetchInterval: liveFallbackInterval(eventsConnected, ML_MONITOR_FALLBACK_REFRESH_MS),
    staleTime: ML_MONITOR_STALE_MS,
    retry: 1,
    // refetch 失败时保留上一次成功数据, 避免表格闪空
    placeholderData: keepPreviousData,
  })

  // 最后一次 success=true 的 summary, 用于 data.success=false 的业务失败场景
  // (HTTP 200 但业务不成功, useQuery 不会触发 isError)
  const lastGoodRef = useRef<PredictionSummary | null>(null)
  useEffect(() => {
    if (data?.success && data.data) {
      lastGoodRef.current = data.data
    }
  }, [data])

  const currentSummary = data?.success ? data.data : null
  const staleSummary = currentSummary ?? lastGoodRef.current
  const businessWarning = data && !data.success ? (data.warning || data.message) : null
  const showStaleBanner = (isError || !!businessWarning) && !!lastGoodRef.current && !currentSummary

  const topk = (staleSummary?.topk || []) as TopkEntry[]

  return (
    <Card
      title={
        <div>
          最新 TopK 信号
          {staleSummary?.trade_date && (
            <Text type="secondary" style={{ marginLeft: 12, fontSize: 12, fontWeight: 'normal' }}>
              trade_date: {staleSummary.trade_date}
              {staleSummary.model_run_id &&
                ` · model: ${staleSummary.model_run_id.slice(0, 8)}`}
            </Text>
          )}
        </div>
      }
      style={{ marginTop: 16 }}
      styles={{ body: { padding: 0 } }}
    >
      {showStaleBanner && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ margin: 0, borderRadius: 0 }}
          message={
            isError
              ? `节点暂时异常, 显示上次缓存 (trade_date: ${lastGoodRef.current?.trade_date || '—'}). ${error instanceof Error ? error.message : ''}`
              : `${businessWarning || '数据获取失败'} — 显示上次缓存`
          }
        />
      )}
      {isLoading && !staleSummary ? (
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
          dataSource={topk}
          columns={columns}
          pagination={false}
        />
      )}
    </Card>
  )
}

export default LatestTopkCard
