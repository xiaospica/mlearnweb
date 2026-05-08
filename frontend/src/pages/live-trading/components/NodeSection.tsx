import React from 'react'
import { Col, Empty, Row } from 'antd'
import { useNavigate } from 'react-router-dom'
import type { NodeStatus, StrategySummary } from '@/types/liveTrading'
import StrategyCardV2 from './StrategyCardV2'
import StrategyCardCompact from './StrategyCardCompact'
import NodeSectionHeader from './NodeSectionHeader'
import type { Density } from '../hooks/useDensity'

export interface NodeSectionProps {
  node: NodeStatus
  strategies: StrategySummary[]
  liveCount: number
  simCount: number
  failedCount: number
  offlineCount: number
  density: Density
  collapsed: boolean
  onToggleCollapse: () => void
  /** 上游策略 → 下游影子数。给每张卡片传 downstreamCount。 */
  downstreamCounts: Map<string, number>
  /** 跨卡片跳转：影子点 ↪ from parent → 滚动到上游卡片。 */
  onJumpToStrategy: (strategyName: string) => void
  /** 头部「新建」按钮回调。 */
  onCreateStrategy?: (nodeId: string) => void
  /** 是否隐藏头（单节点时退化为平铺）。 */
  hideHeader?: boolean
}

const NodeSection: React.FC<NodeSectionProps> = ({
  node,
  strategies,
  liveCount,
  simCount,
  failedCount,
  offlineCount,
  density,
  collapsed,
  onToggleCollapse,
  downstreamCounts,
  onJumpToStrategy,
  onCreateStrategy,
  hideHeader,
}) => {
  const navigate = useNavigate()

  return (
    <section data-node-id={node.node_id} style={{ marginBottom: 16 }}>
      {!hideHeader && (
        <NodeSectionHeader
          node={node}
          liveCount={liveCount}
          simCount={simCount}
          failedCount={failedCount}
          offlineCount={offlineCount}
          totalCount={strategies.length}
          collapsed={collapsed}
          onToggle={onToggleCollapse}
          onCreateStrategy={onCreateStrategy}
        />
      )}

      {!collapsed && (
        <>
          {strategies.length === 0 ? (
            <Empty
              description={node.online ? '该节点暂无策略' : '节点离线，无可显示的策略'}
              style={{ padding: '24px 0' }}
            />
          ) : density === 'list' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {strategies.map((s) => {
                const detailHref = `/live-trading/${encodeURIComponent(s.node_id)}/${encodeURIComponent(s.engine)}/${encodeURIComponent(s.strategy_name)}`
                return (
                  <div
                    key={`${s.node_id}-${s.engine}-${s.strategy_name}`}
                    onClick={() => navigate(detailHref)}
                    style={{ cursor: 'pointer' }}
                  >
                    <StrategyCardCompact item={s} detailHref={detailHref} />
                  </div>
                )
              })}
            </div>
          ) : (
            <Row gutter={[12, 12]}>
              {strategies.map((s) => {
                const detailHref = `/live-trading/${encodeURIComponent(s.node_id)}/${encodeURIComponent(s.engine)}/${encodeURIComponent(s.strategy_name)}`
                const dn = downstreamCounts.get(s.strategy_name) ?? 0
                return (
                  <Col
                    key={`${s.node_id}-${s.engine}-${s.strategy_name}`}
                    xs={24}
                    md={12}
                    xl={8}
                    xxl={6}
                  >
                    <div
                      onClick={() => navigate(detailHref)}
                      style={{ cursor: 'pointer' }}
                    >
                      <StrategyCardV2
                        item={s}
                        detailHref={detailHref}
                        downstreamCount={dn}
                        onJumpToParent={onJumpToStrategy}
                      />
                    </div>
                  </Col>
                )
              })}
            </Row>
          )}
        </>
      )}
    </section>
  )
}

export default NodeSection
