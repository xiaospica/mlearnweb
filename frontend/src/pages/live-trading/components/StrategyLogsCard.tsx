import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ReloadOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Button, Card, Empty, Segmented, Spin, Tag, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import { liveTradingService } from '@/services/liveTradingService'
import type { RiskSeverity, StrategyLogEvent } from '@/types/liveTrading'
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

const SEVERITY_TEXT: Record<RiskSeverity, string> = {
  info: 'INFO',
  warning: 'WARN',
  error: 'ERROR',
  critical: 'CRITICAL',
}

const SEVERITY_COLOR: Record<RiskSeverity, string> = {
  info: '#8fd19e',
  warning: '#ffd166',
  error: '#ff7a90',
  critical: '#ff4fd8',
}

const SEVERITY_TAG_COLOR: Record<RiskSeverity, string> = {
  info: 'green',
  warning: 'gold',
  error: 'red',
  critical: 'magenta',
}

const formatLogTime = (ts?: number) => (ts ? dayjs(ts).format('YYYY-MM-DD HH:mm:ss.SSS') : '---- -- -- --:--:--.---')

const logMessage = (row: StrategyLogEvent) => row.message || row.title || ''

const StrategyLogsCard: React.FC<Props> = ({ nodeId, engine, strategyName, eventsConnected }) => {
  const [severity, setSeverity] = useState<RiskSeverity | 'all'>('all')
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: [...liveTradingQueryKeys.strategyLogs(nodeId, engine, strategyName), severity] as const,
    queryFn: () =>
      liveTradingService.listStrategyLogs(nodeId, engine, strategyName, {
        severity: severity === 'all' ? undefined : severity,
        limit: 1000,
      }),
    refetchInterval: liveFallbackInterval(eventsConnected, LIVE_LOGS_FALLBACK_REFRESH_MS),
    staleTime: 0,
    enabled: !!(nodeId && engine && strategyName),
  })

  const rows = data?.success ? data.data || [] : []
  const terminalRows = useMemo(
    () => [...rows].sort((a, b) => (a.event_ts || 0) - (b.event_ts || 0)),
    [rows],
  )
  const latest = terminalRows[terminalRows.length - 1]

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [terminalRows.length, severity])

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
          <Tooltip title="刷新">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={isFetching}
              onClick={() => refetch()}
            />
          </Tooltip>
        </div>
      }
      styles={{ body: { padding: 0 } }}
    >
      {!data?.success && data?.warning ? (
        <Empty description={data.warning} style={{ padding: 24 }} />
      ) : rows.length === 0 ? (
        <Empty description="暂无运行日志" style={{ padding: 24 }} />
      ) : (
        <div
          style={{
            background: '#080b10',
            borderTop: '1px solid rgba(148, 163, 184, 0.24)',
          }}
        >
          <div
            style={{
              minHeight: 40,
              padding: '9px 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              borderBottom: '1px solid rgba(148, 163, 184, 0.18)',
              background: 'linear-gradient(180deg, #111827 0%, #0b1018 100%)',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57', display: 'inline-block' }} />
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e', display: 'inline-block' }} />
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840', display: 'inline-block' }} />
              <Text
                style={{
                  marginLeft: 8,
                  color: '#d7dde8',
                  fontSize: 12,
                  fontFamily: 'var(--ap-font-mono)',
                }}
                ellipsis
              >
                {nodeId}/{engine}/{strategyName}
              </Text>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Tag color={eventsConnected ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
                {eventsConnected ? 'LIVE' : 'FALLBACK'}
              </Tag>
              {latest && (
                <Text style={{ color: '#8b95a7', fontSize: 12, fontFamily: 'var(--ap-font-mono)' }}>
                  {formatLogTime(latest.event_ts)}
                </Text>
              )}
            </div>
          </div>
          <div
            ref={viewportRef}
            role="log"
            aria-live="polite"
            style={{
              height: 'min(58vh, 560px)',
              minHeight: 360,
              overflow: 'auto',
              padding: '14px 16px 18px',
              color: '#c9d4e5',
              fontFamily: 'var(--ap-font-mono)',
              fontSize: 12,
              lineHeight: 1.72,
              tabSize: 2,
            }}
          >
            {terminalRows.map((row) => {
              const severityColor = SEVERITY_COLOR[row.severity] || '#c9d4e5'
              return (
                <div
                  key={row.event_id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(128px, 188px) 72px minmax(0, 1fr)',
                    columnGap: 12,
                    alignItems: 'start',
                    padding: '2px 0',
                    borderLeft: `2px solid ${severityColor}`,
                    paddingLeft: 10,
                  }}
                >
                  <span style={{ color: '#7f8aa1', whiteSpace: 'nowrap' }}>{formatLogTime(row.event_ts)}</span>
                  <Tag
                    color={SEVERITY_TAG_COLOR[row.severity] || 'default'}
                    style={{
                      width: 66,
                      marginInlineEnd: 0,
                      textAlign: 'center',
                      fontFamily: 'var(--ap-font-mono)',
                      fontSize: 11,
                    }}
                  >
                    {SEVERITY_TEXT[row.severity] || row.severity}
                  </Tag>
                  <span
                    style={{
                      color: severityColor,
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {row.status ? `[${row.status}] ` : ''}
                    {logMessage(row)}
                    {row.source && (
                      <span style={{ color: '#657085' }}>
                        {' '}
                        ({row.source}{row.reason ? `:${row.reason}` : ''})
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Card>
  )
}

export default StrategyLogsCard
