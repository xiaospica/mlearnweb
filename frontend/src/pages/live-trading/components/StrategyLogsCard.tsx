import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Empty, Segmented, Spin, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { liveTradingService } from '@/services/liveTradingService'
import type { RiskSeverity, StrategyLogEvent } from '@/types/liveTrading'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'
import {
  LIVE_LOGS_FALLBACK_REFRESH_MS,
  liveFallbackInterval,
  liveTradingQueryKeys,
} from '../liveTradingRefresh'

const { Text } = Typography

interface Props {
  nodeId: string
  engine: string
  strategyName: string
  eventsConnected: boolean
}

const SEVERITY_COLOR: Record<RiskSeverity, string> = {
  info: 'default',
  warning: 'orange',
  error: 'red',
  critical: 'magenta',
}

const SEVERITY_TEXT: Record<RiskSeverity, string> = {
  info: 'INFO',
  warning: 'WARN',
  error: 'ERROR',
  critical: 'CRITICAL',
}

const columns: ResponsiveColumn<StrategyLogEvent>[] = [
  {
    title: '时间',
    dataIndex: 'event_ts',
    key: 'event_ts',
    width: 150,
    mobileRole: 'subtitle',
    render: (v: number) => (v ? dayjs(v).format('MM-DD HH:mm:ss') : '-'),
  },
  {
    title: '等级',
    dataIndex: 'severity',
    key: 'severity',
    width: 96,
    mobileRole: 'badge',
    render: (v: RiskSeverity) => <Tag color={SEVERITY_COLOR[v] || 'default'}>{SEVERITY_TEXT[v] || v}</Tag>,
  },
  {
    title: '状态',
    dataIndex: 'status',
    key: 'status',
    width: 120,
    render: (v: string | null) => v || '-',
  },
  {
    title: '日志',
    key: 'message',
    mobileRole: 'title',
    render: (_: unknown, r: StrategyLogEvent) => (
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {r.message || r.title || '-'}
      </span>
    ),
  },
  {
    title: '来源',
    key: 'source',
    width: 140,
    render: (_: unknown, r: StrategyLogEvent) => (
      <span>
        {r.source || '-'}
        {r.reason && (
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            {r.reason}
          </Text>
        )}
      </span>
    ),
  },
]

const StrategyLogsCard: React.FC<Props> = ({ nodeId, engine, strategyName, eventsConnected }) => {
  const [severity, setSeverity] = useState<RiskSeverity | 'all'>('all')
  const { data, isLoading, isFetching } = useQuery({
    queryKey: [...liveTradingQueryKeys.strategyLogs(nodeId, engine, strategyName), severity] as const,
    queryFn: () =>
      liveTradingService.listStrategyLogs(nodeId, engine, strategyName, {
        severity: severity === 'all' ? undefined : severity,
        limit: 500,
      }),
    refetchInterval: liveFallbackInterval(eventsConnected, LIVE_LOGS_FALLBACK_REFRESH_MS),
    staleTime: 0,
    enabled: !!(nodeId && engine && strategyName),
  })

  const rows = data?.success ? data.data || [] : []

  return (
    <Card
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          运行日志
          {(isLoading || isFetching) && <Spin size="small" />}
          {rows.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
              {rows.length} 条
            </Text>
          )}
        </span>
      }
      extra={
        <Segmented
          size="small"
          value={severity}
          onChange={(v) => setSeverity(v as RiskSeverity | 'all')}
          options={[
            { label: '全部', value: 'all' },
            { label: 'INFO', value: 'info' },
            { label: 'WARN', value: 'warning' },
            { label: 'ERROR', value: 'error' },
          ]}
        />
      }
      styles={{ body: { padding: 0 } }}
    >
      {!data?.success && data?.warning ? (
        <Empty description={data.warning} style={{ padding: 24 }} />
      ) : rows.length === 0 ? (
        <Empty description="暂无运行日志；需要 vnpy WS log topic 上报并带有 strategy_name 或 [strategy_name] 前缀" style={{ padding: 24 }} />
      ) : (
        <ResponsiveTable<StrategyLogEvent>
          size="small"
          rowKey="event_id"
          dataSource={rows}
          columns={columns}
          pagination={{ pageSize: 30, size: 'small', showSizeChanger: true, pageSizeOptions: ['30', '50', '100'] }}
          scrollX={760}
        />
      )}
    </Card>
  )
}

export default StrategyLogsCard
