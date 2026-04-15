import React from 'react'
import { Button, Popconfirm, Space, App } from 'antd'
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  ReloadOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { useQueryClient } from '@tanstack/react-query'
import { liveTradingService } from '@/services/liveTradingService'
import { useOpsPassword } from '@/hooks/useOpsPassword'
import type { StrategyCapability } from '@/types/liveTrading'

interface Props {
  nodeId: string
  engine: string
  name: string
  capabilities: StrategyCapability[]
  inited: boolean
  trading: boolean
  onEdit?: () => void
  compact?: boolean
}

const StrategyActions: React.FC<Props> = ({
  nodeId,
  engine,
  name,
  capabilities,
  inited,
  trading,
  onEdit,
  compact = false,
}) => {
  const { message } = App.useApp()
  const { guardWrite } = useOpsPassword()
  const queryClient = useQueryClient()

  const can = (cap: StrategyCapability) => capabilities.includes(cap)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['live-strategies'] })
    queryClient.invalidateQueries({ queryKey: ['live-strategy', nodeId, engine, name] })
  }

  const handleInit = async (e?: React.MouseEvent) => {
    e?.stopPropagation()
    const result = await guardWrite(() =>
      liveTradingService.initStrategy(nodeId, engine, name),
    )
    if (result) {
      message.success(`已触发初始化: ${name}`)
      invalidate()
    }
  }

  const handleStart = async (e?: React.MouseEvent) => {
    e?.stopPropagation()
    const result = await guardWrite(() =>
      liveTradingService.startStrategy(nodeId, engine, name),
    )
    if (result) {
      message.success(`已启动: ${name}`)
      invalidate()
    }
  }

  const handleStop = async (e?: React.MouseEvent) => {
    e?.stopPropagation()
    const result = await guardWrite(() =>
      liveTradingService.stopStrategy(nodeId, engine, name),
    )
    if (result) {
      message.success(`已停止: ${name}`)
      invalidate()
    }
  }

  const handleDelete = async (e?: React.MouseEvent) => {
    e?.stopPropagation()
    const result = await guardWrite(() =>
      liveTradingService.deleteStrategy(nodeId, engine, name),
    )
    if (result) {
      message.success(`已删除: ${name}`)
      invalidate()
    }
  }

  const size = compact ? ('small' as const) : ('middle' as const)

  return (
    <Space size={4} onClick={(e) => e.stopPropagation()}>
      {can('init') && !inited && (
        <Popconfirm
          title="确认初始化此策略？"
          onConfirm={handleInit}
          okText="确认"
          cancelText="取消"
        >
          <Button size={size} icon={<ReloadOutlined />}>
            初始化
          </Button>
        </Popconfirm>
      )}
      {can('start') && !trading && (
        <Popconfirm
          title="确认启动此策略？"
          onConfirm={handleStart}
          okText="确认"
          cancelText="取消"
        >
          <Button size={size} type="primary" icon={<PlayCircleOutlined />}>
            启动
          </Button>
        </Popconfirm>
      )}
      {can('stop') && trading && (
        <Popconfirm
          title="确认停止此策略？"
          onConfirm={handleStop}
          okText="确认"
          cancelText="取消"
          okButtonProps={{ danger: true }}
        >
          <Button size={size} danger icon={<PauseCircleOutlined />}>
            停止
          </Button>
        </Popconfirm>
      )}
      {can('edit') && onEdit && (
        <Button
          size={size}
          icon={<EditOutlined />}
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
        >
          编辑
        </Button>
      )}
      {can('remove') && !trading && (
        <Popconfirm
          title={`确认删除策略 "${name}" ？此操作不可撤销`}
          onConfirm={handleDelete}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
        >
          <Button size={size} danger icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      )}
    </Space>
  )
}

export default StrategyActions
