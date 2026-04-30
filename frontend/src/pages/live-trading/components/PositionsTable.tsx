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
  if (!rows || rows.length === 0) {
    return <Empty description="当前无持仓" />
  }

  const columns: ResponsiveColumn<LivePosition>[] = [
    {
      title: '合约',
      dataIndex: 'vt_symbol',
      key: 'vt_symbol',
      width: 160,
      mobileRole: 'title',
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
      dataSource={rows}
      pagination={false}
      scrollX={780}
      columns={columns}
    />
  )
}

export default PositionsTable
