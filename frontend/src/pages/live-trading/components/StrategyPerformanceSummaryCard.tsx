import React from 'react'
import { Card, Spin, Tag, Tooltip, Typography } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { liveTradingService } from '@/services/liveTradingService'
import type { SourceLabel, StrategyPerformanceSummary } from '@/types/liveTrading'
import {
  LIVE_SUMMARY_REFRESH_MS,
  liveTradingQueryKeys,
} from '../liveTradingRefresh'

const { Text } = Typography

interface Props {
  nodeId: string
  engine: string
  strategyName: string
}

const SOURCE_TEXT: Record<SourceLabel, string> = {
  strategy_pnl: '策略PnL',
  position_sum_pnl: '持仓浮盈',
  account_equity: '账户权益',
  replay_settle: '回放权益',
  unavailable: '无数据',
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function percentColor(value: number | null | undefined): string {
  if (!isFiniteNumber(value) || value === 0) return 'var(--ap-text)'
  return value > 0 ? 'var(--ap-market-up)' : 'var(--ap-market-down)'
}

function fmtPercent(value: number | null | undefined, signed = true): string {
  if (!isFiniteNumber(value)) return '--'
  const sign = signed && value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(2)}%`
}

function fmtMoney(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return '--'
  return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}

function fmtNumber(value: number | null | undefined, digits = 3): string {
  if (!isFiniteNumber(value)) return '--'
  return value.toFixed(digits)
}

function uniqueWarnings(summary?: StrategyPerformanceSummary | null, responseWarning?: string | null): string[] {
  return Array.from(new Set([...(summary?.warnings || []), responseWarning].filter(Boolean) as string[]))
}

const StrategyPerformanceSummaryCard: React.FC<Props> = ({ nodeId, engine, strategyName }) => {
  const { data, isLoading, isFetching } = useQuery({
    queryKey: liveTradingQueryKeys.strategyPerformanceSummary(nodeId, engine, strategyName),
    queryFn: () => liveTradingService.getStrategyPerformanceSummary(nodeId, engine, strategyName),
    enabled: !!(nodeId && engine && strategyName),
    staleTime: LIVE_SUMMARY_REFRESH_MS,
    refetchInterval: LIVE_SUMMARY_REFRESH_MS,
    retry: 1,
  })

  const summary = data?.success ? data.data : null
  const source = (summary?.source_label || 'unavailable') as SourceLabel
  const warnings = uniqueWarnings(summary, data?.warning || (!data?.success ? data?.message : null))

  const metrics = [
    {
      key: 'cumulative',
      label: '累计收益',
      value: fmtPercent(summary?.cumulative_return),
      color: percentColor(summary?.cumulative_return),
      help: '基于后端权益曲线首尾值计算',
    },
    {
      key: 'annualized',
      label: '年化收益',
      value: fmtPercent(summary?.annualized_return),
      color: percentColor(summary?.annualized_return),
      help: '按 252 个交易日年化',
    },
    {
      key: 'asset',
      label: '总资产',
      value: fmtMoney(summary?.total_asset),
      color: 'var(--ap-text)',
      help: '优先取当前账户权益，离线时回退到最新权益快照',
    },
    {
      key: 'cash',
      label: '可用资金',
      value: fmtMoney(summary?.available_cash),
      color: 'var(--ap-text)',
      help: '来自 vnpy account available/cash/balance 字段',
    },
    {
      key: 'position',
      label: '仓位占比',
      value: fmtPercent(summary?.position_ratio, false),
      color: 'var(--ap-info)',
      help: '当前持仓市值 / 总资产',
    },
    {
      key: 'beta',
      label: 'Beta',
      value: fmtNumber(summary?.beta),
      color: 'var(--ap-text)',
      help: '未配置基准收益序列时不计算',
    },
    {
      key: 'drawdown',
      label: '最大回撤',
      value: fmtPercent(summary?.max_drawdown, false),
      color: isFiniteNumber(summary?.max_drawdown) && summary.max_drawdown > 0.2
        ? 'var(--ap-danger)'
        : 'var(--ap-warning)',
      help: '基于权益曲线峰值到谷值的最大跌幅',
    },
  ]

  return (
    <Card
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span>指标总览</span>
          {(isLoading || isFetching) && <Spin size="small" />}
        </span>
      }
      extra={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Tag color={source === 'unavailable' ? 'default' : 'blue'}>
            {SOURCE_TEXT[source] || source}
          </Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {summary?.sample_count ?? 0} 点
          </Text>
        </span>
      }
      styles={{ body: { padding: 0 } }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
          borderTop: '1px solid var(--ap-border-muted)',
        }}
      >
        {metrics.map((metric) => (
          <div
            key={metric.key}
            style={{
              minHeight: 76,
              padding: '14px 16px',
              borderRight: '1px solid var(--ap-border-muted)',
              borderBottom: '1px solid var(--ap-border-muted)',
              background: 'var(--ap-panel)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: 'var(--ap-text-muted)',
                fontSize: 12,
                lineHeight: 1,
                marginBottom: 8,
              }}
            >
              <span>{metric.label}</span>
              <Tooltip title={metric.help}>
                <InfoCircleOutlined style={{ fontSize: 11, color: 'var(--ap-text-dim)' }} />
              </Tooltip>
            </div>
            <div
              style={{
                color: metric.color,
                fontFamily: 'var(--ap-font-mono)',
                fontSize: 20,
                fontWeight: 700,
                lineHeight: 1.2,
                whiteSpace: 'nowrap',
              }}
            >
              {metric.value}
            </div>
          </div>
        ))}
      </div>
      {warnings.length > 0 && (
        <div
          style={{
            padding: '8px 16px',
            borderTop: '1px solid var(--ap-border-muted)',
            background: 'var(--ap-panel-muted)',
          }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            {warnings.slice(0, 2).join(' / ')}
          </Text>
        </div>
      )}
    </Card>
  )
}

export default StrategyPerformanceSummaryCard
