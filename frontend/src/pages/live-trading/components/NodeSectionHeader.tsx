import React from 'react'
import { Button, Tooltip } from 'antd'
import { CaretDownOutlined, CaretRightOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
import type { NodeStatus } from '@/types/liveTrading'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

export interface NodeSectionHeaderProps {
  node: NodeStatus
  liveCount: number
  simCount: number
  failedCount: number
  offlineCount: number
  totalCount: number
  collapsed: boolean
  onToggle: () => void
  onCreateStrategy?: (nodeId: string) => void
}

/** 56px sticky header：节点元信息 + 策略数 chips + 折叠 + 在此节点新建。 */
const NodeSectionHeader: React.FC<NodeSectionHeaderProps> = ({
  node,
  liveCount,
  simCount,
  failedCount,
  offlineCount,
  totalCount,
  collapsed,
  onToggle,
  onCreateStrategy,
}) => {
  const onlineColor = node.online
    ? 'var(--ap-success)'
    : node.enabled
      ? 'var(--ap-danger)'
      : 'var(--ap-text-dim)'
  const onlineLabel = node.online ? '在线' : node.enabled ? '离线' : '已禁用'

  // 节点 mode 决定 header 浅色 tint
  const tint =
    node.mode === 'live'
      ? 'color-mix(in srgb, var(--ap-danger) 3%, var(--ap-panel))'
      : node.mode === 'sim'
        ? 'color-mix(in srgb, var(--ap-success) 3%, var(--ap-panel))'
        : 'var(--ap-panel)'

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 56,
        padding: '0 12px 0 0',
        background: tint,
        borderRadius: 6,
        marginBottom: collapsed ? 0 : 12,
        // leading 8px online 色块
        boxShadow: `inset 8px 0 0 0 ${onlineColor}`,
        cursor: 'pointer',
      }}
      onClick={onToggle}
    >
      <span style={{ paddingLeft: 16, color: 'var(--ap-text-muted)', flexShrink: 0 }}>
        {collapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
      </span>

      {/* node_id + base_url */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--ap-text)' }}>
            {node.node_id}
          </span>
          {node.mode && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: '#fff',
                background:
                  node.mode === 'live' ? 'var(--ap-danger)' : 'var(--ap-success)',
                padding: '1px 4px',
                borderRadius: 2,
                fontFamily: 'var(--ap-font-mono)',
                letterSpacing: 0.4,
              }}
              title={`节点默认 mode (yaml)`}
            >
              {node.mode === 'live' ? 'LIVE' : 'SIM'}
            </span>
          )}
          <span
            style={{
              fontSize: 11,
              color: onlineColor,
              fontFamily: 'var(--ap-font-mono)',
            }}
          >
            ● {onlineLabel}
          </span>
          {node.app_version && (
            <span style={{ fontSize: 10, color: 'var(--ap-text-dim)', fontFamily: 'var(--ap-font-mono)' }}>
              v{node.app_version}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--ap-text-muted)',
            fontFamily: 'var(--ap-font-mono)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {node.base_url || '(未注册)'}
          {node.last_probe_ts && (
            <span style={{ marginLeft: 8 }}>
              · 心跳 {dayjs(node.last_probe_ts).fromNow()}
            </span>
          )}
          {typeof node.latency_ms === 'number' && (
            <span style={{ marginLeft: 8 }}>· {node.latency_ms}ms</span>
          )}
          {node.last_error && !node.online && (
            <Tooltip title={node.last_error}>
              <span style={{ marginLeft: 8, color: 'var(--ap-danger)', cursor: 'help' }}>
                · 错误 ⓘ
              </span>
            </Tooltip>
          )}
        </div>
      </div>

      {/* 策略数 chips */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
          fontFamily: 'var(--ap-font-mono)',
          fontSize: 11,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {liveCount > 0 && <Chip color="var(--ap-danger)" label="实盘" count={liveCount} />}
        {simCount > 0 && <Chip color="var(--ap-success)" label="模拟" count={simCount} />}
        {failedCount > 0 && (
          <Chip color="var(--ap-danger)" label="调度异常" count={failedCount} solid />
        )}
        {offlineCount > 0 && <Chip color="var(--ap-text-dim)" label="离线" count={offlineCount} />}
        {totalCount === 0 && (
          <span style={{ color: 'var(--ap-text-dim)' }}>暂无策略</span>
        )}
      </div>

      {/* 在此节点新建策略 */}
      {onCreateStrategy && node.online && (
        <Button
          size="small"
          type="text"
          icon={<PlusOutlined />}
          onClick={(e) => {
            e.stopPropagation()
            onCreateStrategy(node.node_id)
          }}
          style={{ flexShrink: 0 }}
        >
          新建
        </Button>
      )}
    </div>
  )
}

const Chip: React.FC<{ color: string; label: string; count: number; solid?: boolean }> = ({
  color,
  label,
  count,
  solid,
}) => (
  <span
    style={{
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 11,
      color: solid ? '#fff' : color,
      background: solid ? color : `color-mix(in srgb, ${color} 14%, transparent)`,
      border: solid ? 'none' : `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
    }}
  >
    {label} {count}
  </span>
)

export default NodeSectionHeader
