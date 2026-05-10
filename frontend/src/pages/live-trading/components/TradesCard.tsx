import React, { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Empty, Segmented, Spin, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { liveTradingService } from '@/services/liveTradingService'
import type { StrategyTrade } from '@/types/liveTrading'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'
import {
  LIVE_TRADES_FALLBACK_REFRESH_MS,
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

interface DailyAggregated {
  date: string
  buys: number
  sells: number
  buy_amount: number  // 买入总金额
  sell_amount: number // 卖出总金额
  trades: StrategyTrade[]
}

function fmtAmount(v: number): string {
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2)}万`
  return v.toFixed(2)
}

function isLong(direction: string): boolean {
  return direction.includes('多') || direction.toLowerCase().includes('long')
}

const TradesCard: React.FC<Props> = ({ nodeId, engine, strategyName, eventsConnected }) => {
  const [view, setView] = useState<'daily' | 'detail'>('daily')

  const { data, isLoading } = useQuery({
    queryKey: liveTradingQueryKeys.trades(nodeId, engine, strategyName),
    queryFn: () => liveTradingService.listStrategyTrades(nodeId, engine, strategyName),
    refetchInterval: liveFallbackInterval(eventsConnected, LIVE_TRADES_FALLBACK_REFRESH_MS),
    staleTime: 0,
    enabled: !!(nodeId && engine && strategyName),
  })

  const trades: StrategyTrade[] = data?.success ? data?.data || [] : []

  const aggregated: DailyAggregated[] = useMemo(() => {
    const byDay: Record<string, DailyAggregated> = {}
    for (const t of trades) {
      const day = (t.datetime || '').slice(0, 10) || 'unknown'
      if (!byDay[day]) {
        byDay[day] = { date: day, buys: 0, sells: 0, buy_amount: 0, sell_amount: 0, trades: [] }
      }
      const amount = (t.price || 0) * (t.volume || 0)
      if (isLong(t.direction)) {
        byDay[day].buys += 1
        byDay[day].buy_amount += amount
      } else {
        byDay[day].sells += 1
        byDay[day].sell_amount += amount
      }
      byDay[day].trades.push(t)
    }
    return Object.values(byDay).sort((a, b) => (a.date < b.date ? 1 : -1))
  }, [trades])

  if (isLoading) {
    return (
      <Card title="交易记录" style={{ marginTop: 16 }}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      </Card>
    )
  }

  if (!trades.length) {
    return (
      <Card title="交易记录" style={{ marginTop: 16 }}>
        <Empty description="当前会话无成交（vnpy_webtrader 仅持有当前进程内成交，重启会丢失）" />
      </Card>
    )
  }

  const dailyColumns: ResponsiveColumn<DailyAggregated>[] = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 110, mobileRole: 'title' },
    {
      title: '买入笔数',
      dataIndex: 'buys',
      key: 'buys',
      width: 90,
      align: 'right' as const,
      render: (v: number) => <Tag color="red">{v}</Tag>,
    },
    {
      title: '买入金额',
      dataIndex: 'buy_amount',
      key: 'buy_amount',
      width: 120,
      align: 'right' as const,
      render: (v: number) => <span style={{ color: 'var(--ap-market-up)' }}>{fmtAmount(v)}</span>,
    },
    {
      title: '卖出笔数',
      dataIndex: 'sells',
      key: 'sells',
      width: 90,
      align: 'right' as const,
      render: (v: number) => <Tag color="green">{v}</Tag>,
    },
    {
      title: '卖出金额',
      dataIndex: 'sell_amount',
      key: 'sell_amount',
      width: 120,
      align: 'right' as const,
      render: (v: number) => <span style={{ color: 'var(--ap-market-down)' }}>{fmtAmount(v)}</span>,
    },
    {
      title: '净流出',
      key: 'net',
      width: 120,
      align: 'right' as const,
      render: (_: unknown, r: DailyAggregated) => {
        const net = r.buy_amount - r.sell_amount
        const color = net > 0 ? 'var(--ap-market-up)' : net < 0 ? 'var(--ap-market-down)' : 'var(--ap-text-muted)'
        return <span style={{ color, fontWeight: 600 }}>{fmtAmount(net)}</span>
      },
    },
    {
      title: '涉及合约',
      key: 'symbols',
      render: (_: unknown, r: DailyAggregated) => {
        // 用 name (中文简称) 优先, 没有则用 vt_symbol；按字母去重
        const labels = Array.from(
          new Set(r.trades.map((t) => t.name || t.vt_symbol)),
        )
        const shown = labels.slice(0, 5).join('、')
        const more = labels.length > 5 ? ` +${labels.length - 5}` : ''
        return (
          <span style={{ fontSize: 12, color: 'var(--ap-text)' }} title={labels.join('、')}>
            {shown}{more}
          </span>
        )
      },
    },
  ]

  const detailColumns: ResponsiveColumn<StrategyTrade>[] = [
    {
      title: '时间',
      dataIndex: 'datetime',
      key: 'datetime',
      width: 160,
      mobileRole: 'title',
      render: (v: string) => v ? dayjs(v).format('MM-DD HH:mm:ss') : '-',
    },
    {
      title: '合约',
      key: 'vt_symbol',
      width: 200,
      render: (_: unknown, r: StrategyTrade) => (
        <span>
          {r.name && <span style={{ marginRight: 6, color: 'var(--ap-text)' }}>{r.name}</span>}
          <span style={{ color: 'var(--ap-text-muted)', fontSize: 12 }}>{r.vt_symbol}</span>
        </span>
      ),
    },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      width: 70,
      render: (v: string) => <Tag color={isLong(v) ? 'red' : 'green'}>{v || '-'}</Tag>,
    },
    {
      title: '价格',
      dataIndex: 'price',
      key: 'price',
      width: 100,
      align: 'right' as const,
      render: (v: number) => v.toFixed(2),
    },
    {
      title: '数量',
      dataIndex: 'volume',
      key: 'volume',
      width: 100,
      align: 'right' as const,
      render: (v: number) => v.toFixed(0),
    },
    {
      title: '金额',
      key: 'amount',
      width: 110,
      align: 'right' as const,
      render: (_: unknown, r: StrategyTrade) => fmtAmount(r.price * r.volume),
    },
  ]

  return (
    <Card
      title={
        <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
          交易记录
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
            ({trades.length} 笔，{aggregated.length} 个交易日)
          </Text>
        </span>
      }
      style={{ marginTop: 16 }}
      extra={
        <Segmented
          size="small"
          value={view}
          onChange={(v) => setView(v as 'daily' | 'detail')}
          options={[
            { label: '按日汇总', value: 'daily' },
            { label: '明细列表', value: 'detail' },
          ]}
        />
      }
      styles={{ body: { padding: 0 } }}
    >
      {view === 'daily' ? (
        <ResponsiveTable<DailyAggregated>
          size="small"
          rowKey="date"
          dataSource={aggregated}
          columns={dailyColumns}
          pagination={{ pageSize: 20, size: 'small', showSizeChanger: true, pageSizeOptions: ['10', '20', '50', '100'] }}
          scrollX={650}
        />
      ) : (
        <ResponsiveTable<StrategyTrade>
          size="small"
          rowKey={(r) => `${r.tradeid}-${r.vt_symbol}`}
          dataSource={trades}
          columns={detailColumns}
          pagination={{ pageSize: 20, size: 'small', showSizeChanger: true, pageSizeOptions: ['10', '20', '50', '100'] }}
          scrollX={680}
        />
      )}
    </Card>
  )
}

export default TradesCard
