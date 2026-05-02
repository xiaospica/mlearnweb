import React from 'react'
import { Tag, Empty } from 'antd'
import type { LivePosition } from '@/types/liveTrading'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'

interface Props {
  rows: LivePosition[]
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-'
  return Number(v).toFixed(digits)
}

/** A 股惯例：涨红跌绿。返回 CSS 变量以适配 dark/light 主题。*/
function pnlColor(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'var(--ap-text-muted)'
  if (v > 0) return 'var(--ap-market-up)'
  if (v < 0) return 'var(--ap-market-down)'
  return 'var(--ap-text-muted)'
}

const PositionsTable: React.FC<Props> = ({ rows }) => {
  // 过滤 volume=0 记录：vnpy OMS 会保留已平仓位记录（volume=0），
  // 这些无价值且会让 positions_count 误导用户，前端只展示真实持仓。
  const visible = (rows || []).filter((r) => Number(r.volume) > 0)

  if (visible.length === 0) {
    return <Empty description="当前无持仓" />
  }

  // 持仓市值占比 weight 由后端 _render_positions 计算（_resolve_strategy_value
  // 同源公式: volume × cost_price + pnl, 含 settle 阶段 pct_chg 累乘调整）。
  // 前端只展示，不参与业务计算。
  const columns: ResponsiveColumn<LivePosition>[] = [
    {
      title: '合约',
      key: 'vt_symbol',
      width: 200,
      mobileRole: 'title',
      render: (_: unknown, r: LivePosition) => (
        <span>
          {r.name && (
            <span style={{ marginRight: 6, color: 'var(--ap-text)' }}>{r.name}</span>
          )}
          <span style={{ color: 'var(--ap-text-muted)', fontSize: 12 }}>{r.vt_symbol}</span>
        </span>
      ),
    },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      width: 80,
      mobileRole: 'badge',
      render: (v: string) => {
        const isLong = v.includes('多') || v.toLowerCase().includes('long')
        return <Tag color={isLong ? 'red' : 'green'}>{v || '-'}</Tag>
      },
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
      title: '成本价',
      dataIndex: 'price',
      key: 'price',
      width: 110,
      align: 'right' as const,
      mobileRole: 'metric',
      render: (v: number | null) => fmt(v),
    },
    {
      title: '浮动盈亏',
      dataIndex: 'pnl',
      key: 'pnl',
      width: 130,
      align: 'right' as const,
      mobileRole: 'metric',
      render: (v: number | null) => (
        <span style={{ color: pnlColor(v), fontWeight: 600 }}>{fmt(v)}</span>
      ),
    },
    {
      title: '持仓占比',
      dataIndex: 'weight',
      key: 'weight',
      width: 100,
      align: 'right' as const,
      mobileRole: 'metric',
      render: (v: number | null | undefined) =>
        (v == null || v <= 0) ? '-' : `${(v * 100).toFixed(2)}%`,
    },
    {
      title: '冻结',
      dataIndex: 'frozen',
      key: 'frozen',
      width: 100,
      align: 'right' as const,
      mobileRole: 'metric',
      render: (v: number | null | undefined) => fmt(v, 0),
    },
    {
      title: '昨仓',
      dataIndex: 'yd_volume',
      key: 'yd_volume',
      width: 100,
      align: 'right' as const,
      mobileRole: 'hidden',
      render: (v: number | null | undefined) => fmt(v, 0),
    },
  ]

  return (
    <ResponsiveTable<LivePosition>
      size="small"
      rowKey={(r) => `${r.vt_symbol}-${r.direction}`}
      dataSource={visible}
      pagination={false}
      scrollX={780}
      columns={columns}
    />
  )
}

export default PositionsTable
