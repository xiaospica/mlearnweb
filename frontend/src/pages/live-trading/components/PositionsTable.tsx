import React from 'react'
import { Table, Tag, Empty } from 'antd'
import type { LivePosition } from '@/types/liveTrading'

interface Props {
  rows: LivePosition[]
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-'
  return Number(v).toFixed(digits)
}

/**
 * A-share convention: red for positive pnl, green for negative.
 */
function pnlColor(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '#8c8c8c'
  if (v > 0) return '#f5222d'
  if (v < 0) return '#52c41a'
  return '#6b7280'
}

const PositionsTable: React.FC<Props> = ({ rows }) => {
  if (!rows || rows.length === 0) {
    return <Empty description="当前无持仓" />
  }
  return (
    <Table<LivePosition>
      size="small"
      rowKey={(r) => `${r.vt_symbol}-${r.direction}`}
      dataSource={rows}
      pagination={false}
      columns={[
        {
          title: '合约',
          dataIndex: 'vt_symbol',
          key: 'vt_symbol',
          width: 160,
        },
        {
          title: '方向',
          dataIndex: 'direction',
          key: 'direction',
          width: 80,
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
          render: (v: number) => fmt(v, 0),
        },
        {
          title: '成本价',
          dataIndex: 'price',
          key: 'price',
          width: 110,
          align: 'right' as const,
          render: (v: number | null) => fmt(v),
        },
        {
          title: '浮动盈亏',
          dataIndex: 'pnl',
          key: 'pnl',
          width: 130,
          align: 'right' as const,
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
          render: (v: number | null | undefined) => fmt(v, 0),
        },
        {
          title: '昨仓',
          dataIndex: 'yd_volume',
          key: 'yd_volume',
          width: 100,
          align: 'right' as const,
          render: (v: number | null | undefined) => fmt(v, 0),
        },
      ]}
    />
  )
}

export default PositionsTable
