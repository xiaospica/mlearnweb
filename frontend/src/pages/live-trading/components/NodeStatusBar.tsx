import React from 'react'
import { Badge, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import type { NodeStatus } from '@/types/liveTrading'

const { Text } = Typography

interface Props {
  nodes: NodeStatus[]
}

const NodeStatusBar: React.FC<Props> = ({ nodes }) => {
  if (!nodes || nodes.length === 0) {
    return <Text type="secondary">未注册任何节点，请检查 vnpy_nodes.yaml</Text>
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        节点状态:
      </Text>
      {nodes.map((n) => {
        const tooltip = (
          <div style={{ fontSize: 12 }}>
            <div>base_url: {n.base_url}</div>
            <div>
              最近探活:{' '}
              {n.last_probe_ts ? dayjs(n.last_probe_ts).format('HH:mm:ss') : '-'}
            </div>
            {n.last_error && (
              <div style={{ color: '#ff4d4f' }}>错误: {n.last_error}</div>
            )}
          </div>
        )
        return (
          <Tooltip key={n.node_id} title={tooltip}>
            <Badge
              status={n.online ? 'processing' : 'error'}
              text={
                <span style={{ fontSize: 12, color: n.online ? '#1f2937' : '#ff4d4f' }}>
                  {n.node_id}
                </span>
              }
            />
          </Tooltip>
        )
      })}
    </div>
  )
}

export default NodeStatusBar
