/**
 * 训练记录的部署追踪 chip 列表。
 *
 * 显示当前训练记录被部署到哪些 vnpy 实盘/模拟策略，点击 chip 跳转到对应的
 * 策略详情页。详见 vnpy_common/naming.py 命名约定章节。
 */
import React from 'react'
import { Tag, Tooltip } from 'antd'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import type { TrainingDeployment } from '@/types'

interface Props {
  deployments: TrainingDeployment[] | undefined
  /** 折叠阈值：超过 N 个 active 部署后用 "..." 折叠尾部。默认 3。 */
  maxVisible?: number
  /** 是否显示 inactive 部署（灰色）。列表页通常 false，详情页 true。 */
  showInactive?: boolean
}

const DeploymentBadges: React.FC<Props> = ({
  deployments,
  maxVisible = 3,
  showInactive = false,
}) => {
  const navigate = useNavigate()

  if (!deployments || deployments.length === 0) {
    return null
  }

  const active = deployments.filter((d) => d.active)
  const inactive = deployments.filter((d) => !d.active)
  const visibleActive = active.slice(0, maxVisible)
  const overflow = active.length - visibleActive.length

  const handleClick = (d: TrainingDeployment) => (e: React.MouseEvent) => {
    e.stopPropagation()
    navigate(
      `/live-trading/${encodeURIComponent(d.node_id)}/${encodeURIComponent(
        d.engine,
      )}/${encodeURIComponent(d.strategy_name)}`,
    )
  }

  const renderChip = (d: TrainingDeployment, dim: boolean) => {
    const color = d.mode === 'live' ? 'red' : 'green'
    const icon = d.mode === 'live' ? '⚠' : '🧪'
    const label = `${icon} ${d.mode === 'live' ? '实盘' : '模拟'} · ${d.strategy_name}@${d.node_id}`
    const tooltip = (
      <div style={{ fontSize: 12 }}>
        <div>gateway: {d.gateway_name || '—'}</div>
        <div>run_id: {d.run_id.slice(0, 16)}…</div>
        <div>首次发现: {dayjs(d.first_seen_at).format('MM-DD HH:mm')}</div>
        <div>最近活跃: {dayjs(d.last_seen_at).format('MM-DD HH:mm')}</div>
        {!d.active && <div style={{ color: '#ff4d4f' }}>状态: 已停止</div>}
      </div>
    )
    return (
      <Tooltip key={`${d.node_id}-${d.engine}-${d.strategy_name}`} title={tooltip}>
        <Tag
          color={dim ? 'default' : color}
          style={{
            cursor: 'pointer',
            opacity: dim ? 0.55 : 1,
            margin: '2px 4px 2px 0',
          }}
          onClick={handleClick(d)}
        >
          {label}
        </Tag>
      </Tooltip>
    )
  }

  return (
    <div style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center' }}>
      {visibleActive.map((d) => renderChip(d, false))}
      {overflow > 0 && (
        <Tooltip title={`还有 ${overflow} 个 active 部署`}>
          <Tag style={{ margin: '2px 4px 2px 0' }}>+{overflow}</Tag>
        </Tooltip>
      )}
      {showInactive && inactive.map((d) => renderChip(d, true))}
    </div>
  )
}

export default DeploymentBadges
