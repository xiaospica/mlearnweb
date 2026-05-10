import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Empty, Spin, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { useOpsPassword } from '@/hooks/useOpsPassword'
import { liveTradingService } from '@/services/liveTradingService'
import type { RiskSeverity, StrategyRiskEvent } from '@/types/liveTrading'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'
import {
  LIVE_RISK_FALLBACK_REFRESH_MS,
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

function makeColumns(onAck: (eventId: string) => void, acking: boolean): ResponsiveColumn<StrategyRiskEvent>[] {
  return [
  {
    title: '等级',
    dataIndex: 'severity',
    key: 'severity',
    width: 96,
    mobileRole: 'badge',
    render: (v: RiskSeverity) => <Tag color={SEVERITY_COLOR[v]}>{SEVERITY_TEXT[v]}</Tag>,
  },
  {
    title: '时间',
    dataIndex: 'event_ts',
    key: 'event_ts',
    width: 140,
    mobileRole: 'subtitle',
    render: (v: number) => (v ? dayjs(v).format('MM-DD HH:mm:ss') : '-'),
  },
  {
    title: '事件',
    key: 'title',
    width: 180,
    mobileRole: 'title',
    render: (_: unknown, r: StrategyRiskEvent) => (
      <span>
        <span style={{ fontWeight: 600 }}>{r.title}</span>
        <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
          {r.category}
        </Text>
      </span>
    ),
  },
  {
    title: '订单/合约',
    key: 'order',
    width: 220,
    render: (_: unknown, r: StrategyRiskEvent) => (
      <span style={{ fontFamily: 'var(--ap-font-mono)', fontSize: 12 }}>
        {r.vt_orderid || '-'}
        {r.vt_symbol && (
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            {r.vt_symbol}
          </Text>
        )}
        {r.is_resubmit && <Tag color="gold" style={{ marginLeft: 8 }}>R</Tag>}
      </span>
    ),
  },
  {
    title: '说明',
    key: 'message',
    render: (_: unknown, r: StrategyRiskEvent) => (
      <span>
        {r.message || r.status || '-'}
        {r.reference && (
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            ref: {r.reference}
          </Text>
        )}
      </span>
    ),
  },
  {
    title: '确认',
    key: 'ack',
    width: 88,
    render: (_: unknown, r: StrategyRiskEvent) => (
      r.ack_at ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          已确认
        </Text>
      ) : (
        <Button size="small" type="link" loading={acking} onClick={() => onAck(r.event_id)}>
          确认
        </Button>
      )
    ),
  },
  ]
}

const RiskEventsCard: React.FC<Props> = ({ nodeId, engine, strategyName, eventsConnected }) => {
  const queryClient = useQueryClient()
  const { guardWrite } = useOpsPassword()
  const { data, isLoading, isFetching } = useQuery({
    queryKey: liveTradingQueryKeys.riskEvents(nodeId, engine, strategyName),
    queryFn: () => liveTradingService.listStrategyRiskEvents(nodeId, engine, strategyName),
    refetchInterval: liveFallbackInterval(eventsConnected, LIVE_RISK_FALLBACK_REFRESH_MS),
    staleTime: 0,
    enabled: !!(nodeId && engine && strategyName),
  })

  const rows = data?.success ? data.data || [] : []
  const ackMutation = useMutation({
    mutationFn: async (eventId: string) => {
      return guardWrite(() => liveTradingService.ackRiskEvent(eventId))
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: liveTradingQueryKeys.riskEvents(nodeId, engine, strategyName),
      })
      await queryClient.invalidateQueries({
        queryKey: liveTradingQueryKeys.strategies(),
      })
    },
  })
  const columns = makeColumns(
    (eventId) => ackMutation.mutate(eventId),
    ackMutation.isPending,
  )

  return (
    <Card
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          风险事件
          {(isLoading || isFetching) && <Spin size="small" />}
          {rows.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
              {rows.length} 条
            </Text>
          )}
        </span>
      }
      style={{ marginTop: 16 }}
      styles={{ body: { padding: 0 } }}
    >
      {!data?.success && data?.warning ? (
        <Empty description={data.warning} style={{ padding: 24 }} />
      ) : rows.length === 0 ? (
        <Empty description="暂无风险事件" style={{ padding: 24 }} />
      ) : (
        <ResponsiveTable<StrategyRiskEvent>
          size="small"
          rowKey="event_id"
          dataSource={rows}
          columns={columns}
          pagination={{ pageSize: 10, size: 'small', showSizeChanger: true }}
          scrollX={900}
        />
      )}
    </Card>
  )
}

export default RiskEventsCard
