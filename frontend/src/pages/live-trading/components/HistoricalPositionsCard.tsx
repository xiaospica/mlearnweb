/**
 * 历史持仓浏览卡片 — 选日期重建 EOD 持仓快照（amount/金额/仓位占比）.
 *
 * 数据流:
 *   后端 GET /api/live-trading/strategies/{node}/{engine}/{name}/positions/{yyyymmdd}
 *   → 从 vnpy_qmt_sim sim_trades 重建 + daily_merged pct_chg 累乘 mark price.
 *
 * 与"当前持仓"卡片区别:
 *   - 当前持仓: 实时 fanout vnpy 节点 (StrategyDetail.positions)
 *   - 本卡片: 任意历史日期, 通过日期选择器查询
 */
import React, { useMemo, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Card, DatePicker, Empty, Spin, Alert } from 'antd'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { liveTradingService } from '@/services/liveTradingService'
import type { HistoricalPosition } from '@/types/liveTrading'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'

interface Props {
  nodeId: string
  engine: string
  strategyName: string
  /** 多 gateway 沙盒下显式传入；否则后端按命名约定 fallback */
  gatewayName?: string
  /** 有数据的交易日列表 (YYYY-MM-DD)；DatePicker 用此 disable 无数据日期 */
  historyDates?: string[]
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-'
  return Number(v).toFixed(digits)
}

const columns: ResponsiveColumn<HistoricalPosition>[] = [
  {
    title: '合约',
    key: 'vt_symbol',
    width: 200,
    mobileRole: 'title',
    render: (_: unknown, r: HistoricalPosition) => (
      <span>
        {r.name && <span style={{ marginRight: 6 }}>{r.name}</span>}
        <span style={{ color: 'var(--ap-text-muted)', fontSize: 12 }}>{r.vt_symbol}</span>
      </span>
    ),
  },
  {
    title: '数量',
    dataIndex: 'volume',
    key: 'volume',
    width: 100,
    align: 'right' as const,
    mobileRole: 'metric',
    render: (v: number) => fmt(v, 0),
  },
  {
    title: '成本价 (mark)',
    dataIndex: 'cost_price',
    key: 'cost_price',
    width: 120,
    align: 'right' as const,
    mobileRole: 'metric',
    render: (v: number) => fmt(v, 4),
  },
  {
    title: '市值',
    dataIndex: 'market_value',
    key: 'market_value',
    width: 130,
    align: 'right' as const,
    mobileRole: 'metric',
    render: (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
  },
  {
    title: '持仓占比',
    dataIndex: 'weight',
    key: 'weight',
    width: 100,
    align: 'right' as const,
    mobileRole: 'metric',
    render: (v: number) => `${(v * 100).toFixed(2)}%`,
  },
]

const HistoricalPositionsCard: React.FC<Props> = ({
  nodeId, engine, strategyName, gatewayName, historyDates = [],
}) => {
  // 默认最近一个有数据的日期；historyDates 为空则 fallback 昨日
  const latestDate = historyDates.length > 0 ? historyDates[historyDates.length - 1] : null
  const [selected, setSelected] = useState<Dayjs>(() =>
    latestDate ? dayjs(latestDate) : dayjs().subtract(1, 'day')
  )
  const yyyymmdd = selected.format('YYYYMMDD')

  // DatePicker disabledDate: 无 historyDates 时不限制 (兼容老调用)
  const availableDatesSet = useMemo(() => new Set(historyDates), [historyDates])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['historical-positions', nodeId, engine, strategyName, yyyymmdd, gatewayName ?? ''],
    queryFn: () =>
      liveTradingService.getStrategyPositionsOnDate(nodeId, engine, strategyName, yyyymmdd, gatewayName),
    staleTime: 60_000,
    retry: 1,
    placeholderData: keepPreviousData,
  })

  const rows = data?.success ? (data.data || []) : []
  const warning = data && !data.success ? (data.warning || data.message) : null
  const totalMV = rows.reduce((s, r) => s + (r.market_value || 0), 0)

  return (
    <Card
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>历史持仓浏览</span>
          <DatePicker
            value={selected}
            onChange={(d) => d && setSelected(d)}
            format="YYYY-MM-DD"
            allowClear={false}
            size="small"
            disabledDate={
              availableDatesSet.size > 0
                ? (d) => !availableDatesSet.has(d.format('YYYY-MM-DD'))
                : undefined
            }
          />
          {totalMV > 0 && (
            <span style={{ fontSize: 12, color: 'var(--ap-text-muted)' }}>
              EOD 总市值 ≈ {totalMV.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          )}
        </div>
      }
      style={{ marginTop: 16 }}
      styles={{ body: { padding: 0 } }}
    >
      {warning && (
        <Alert type="warning" showIcon closable message={warning} style={{ margin: 0, borderRadius: 0 }} />
      )}
      {isLoading ? (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : isError ? (
        <div style={{ padding: 24 }}>
          <Empty description="读取失败，看后端日志" />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24 }}>
          <Empty description={`${yyyymmdd} EOD 无持仓 / 该日无交易记录`} />
        </div>
      ) : (
        <ResponsiveTable<HistoricalPosition>
          size="small"
          rowKey={(r) => r.vt_symbol}
          dataSource={rows}
          pagination={false}
          scrollX={650}
          columns={columns}
        />
      )}
    </Card>
  )
}

export default HistoricalPositionsCard
