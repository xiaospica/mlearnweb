import React from 'react'
import { Input, Segmented, Select, Space } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import type { NodeStatus } from '@/types/liveTrading'
import type {
  ModeFilter,
  SortKey,
  StatusFilter,
  StrategyFilters,
} from '../hooks/useStrategyFilters'

export interface FilterBarProps {
  filters: StrategyFilters
  setFilters: (patch: Partial<StrategyFilters>) => void
  nodes: NodeStatus[]
  liveCount: number
  simCount: number
  offlineCount: number
}

const FilterBar: React.FC<FilterBarProps> = ({
  filters,
  setFilters,
  nodes,
  liveCount,
  simCount,
  offlineCount,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: 'var(--ap-panel)',
        border: '1px solid var(--ap-border)',
        borderRadius: 6,
      }}
    >
      <Segmented<ModeFilter>
        size="small"
        value={filters.mode}
        onChange={(v) => setFilters({ mode: v })}
        options={[
          { label: `全部`, value: 'all' },
          { label: `实盘 ${liveCount}`, value: 'live' },
          { label: `模拟 ${simCount}`, value: 'sim' },
          ...(offlineCount > 0
            ? [{ label: `离线 ${offlineCount}`, value: 'offline' as ModeFilter }]
            : []),
        ]}
      />

      {nodes.length > 1 && (
        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount={2}
          placeholder="节点"
          value={filters.nodeIds}
          onChange={(v) => setFilters({ nodeIds: v })}
          options={nodes.map((n) => ({ label: n.node_id, value: n.node_id }))}
          style={{ minWidth: 140 }}
        />
      )}

      <Select<StatusFilter>
        size="small"
        value={filters.status}
        onChange={(v) => setFilters({ status: v })}
        options={[
          { label: '所有状态', value: 'all' },
          { label: '运行中', value: 'running' },
          { label: '已初始化', value: 'inited' },
          { label: '调度异常', value: 'failed' },
          { label: '从未运行', value: 'never_run' },
        ]}
        style={{ minWidth: 110 }}
      />

      <Select<SortKey>
        size="small"
        value={filters.sort}
        onChange={(v) => setFilters({ sort: v })}
        options={[
          { label: '按下次触发', value: 'next_run' },
          { label: '按权益', value: 'equity' },
          { label: '按状态', value: 'last_status' },
          { label: '按名称', value: 'name' },
        ]}
        style={{ minWidth: 130 }}
      />

      <Space.Compact>
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索 strategy_name / vt_symbol"
          value={filters.search}
          onChange={(e) => setFilters({ search: e.target.value })}
          style={{ minWidth: 220 }}
        />
      </Space.Compact>
    </div>
  )
}

export default FilterBar
