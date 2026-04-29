/**
 * V3.9 search_space 表单化编辑器
 *
 * 与 JsonCodeEditor 互斥使用（Step 2 内 Tab 切换）：
 *   - 表单：每参数一行，type 选择 (float/int/categorical) + 对应输入控件 + log scale switch
 *   - JSON：原 JsonCodeEditor（复杂场景或导入导出用）
 *
 * 与 gbdt_model.kwargs 的一致性由后端 schema validator 把关（V3.6）；
 * 这里 UI 只确保 search_space 内部结构合法（type/low/high/log/choices）。
 */

import React from 'react'
import {
  Button,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { SearchSpace, SearchSpaceParam } from '@/types/tuning'

const { Text } = Typography

const PARAM_TYPE_OPTIONS = [
  { value: 'float', label: 'float' },
  { value: 'int', label: 'int' },
  { value: 'categorical', label: 'categorical' },
] as const

interface Props {
  value: SearchSpace
  onChange: (next: SearchSpace) => void
  /** 用于参数名校验 — 通常应是 gbdt_model.kwargs 的 keys */
  knownGbdtParams?: string[]
}

export const SearchSpaceForm: React.FC<Props> = ({ value, onChange, knownGbdtParams }) => {
  const entries = Object.entries(value)

  const updateParam = (key: string, next: SearchSpaceParam) => {
    onChange({ ...value, [key]: next })
  }

  const renameParam = (oldKey: string, newKey: string) => {
    if (!newKey || newKey === oldKey) return
    if (newKey in value) return  // 避免重名覆盖
    const next: SearchSpace = {}
    for (const [k, v] of Object.entries(value)) {
      next[k === oldKey ? newKey : k] = v
    }
    onChange(next)
  }

  const removeParam = (key: string) => {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }

  const addParam = () => {
    // 自动找一个未占用的 key
    const baseKey = 'new_param'
    let candidate = baseKey
    let i = 1
    while (candidate in value) {
      candidate = `${baseKey}_${i++}`
    }
    onChange({
      ...value,
      [candidate]: { type: 'float', low: 0, high: 1, log: false } as SearchSpaceParam,
    })
  }

  const changeType = (key: string, newType: SearchSpaceParam['type']) => {
    if (newType === 'categorical') {
      updateParam(key, { type: 'categorical', choices: [] })
    } else if (newType === 'int') {
      updateParam(key, { type: 'int', low: 0, high: 100 })
    } else {
      updateParam(key, { type: 'float', low: 0, high: 1, log: false })
    }
  }

  return (
    <div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
        每参数 1 行：选 type、填范围（float/int 用 low/high+log；categorical 填 choices 用逗号分隔）。
        参数名建议跟 <Text code>gbdt_model.kwargs</Text> 的 key 一致（否则 baseline 没基线值会报错）。
      </Text>
      <Space direction="vertical" style={{ width: '100%' }} size={6}>
        {entries.map(([key, param]) => {
          const knownInGbdt = knownGbdtParams ? knownGbdtParams.includes(key) : true
          return (
            <ParamRow
              key={key}
              paramKey={key}
              param={param}
              warning={!knownInGbdt}
              onRename={(newKey) => renameParam(key, newKey)}
              onChangeType={(newType) => changeType(key, newType)}
              onChangeParam={(next) => updateParam(key, next)}
              onRemove={() => removeParam(key)}
            />
          )
        })}
        <Button
          type="dashed"
          icon={<PlusOutlined />}
          onClick={addParam}
          style={{ width: '100%' }}
        >
          添加参数
        </Button>
      </Space>
    </div>
  )
}

const ParamRow: React.FC<{
  paramKey: string
  param: SearchSpaceParam
  warning: boolean
  onRename: (newKey: string) => void
  onChangeType: (newType: SearchSpaceParam['type']) => void
  onChangeParam: (next: SearchSpaceParam) => void
  onRemove: () => void
}> = ({ paramKey, param, warning, onRename, onChangeType, onChangeParam, onRemove }) => {
  const [editingKey, setEditingKey] = React.useState(paramKey)
  React.useEffect(() => setEditingKey(paramKey), [paramKey])

  return (
    <Space.Compact style={{ width: '100%' }}>
      <Tooltip title={warning ? '该参数名不在 gbdt_model.kwargs 中' : ''}>
        <Input
          value={editingKey}
          onChange={(e) => setEditingKey(e.target.value)}
          onBlur={() => onRename(editingKey.trim())}
          onPressEnter={(e) => {
            ;(e.target as HTMLInputElement).blur()
          }}
          status={warning ? 'warning' : ''}
          placeholder="参数名"
          style={{ width: 180, fontFamily: "'SF Mono', monospace", fontSize: 12 }}
        />
      </Tooltip>
      <Select
        value={param.type}
        onChange={onChangeType}
        options={[...PARAM_TYPE_OPTIONS]}
        style={{ width: 110 }}
      />
      {param.type === 'categorical' ? (
        <Input
          value={(param.choices ?? []).join(',')}
          onChange={(e) => {
            const choices = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((v) => {
                const n = Number(v)
                return Number.isNaN(n) ? v : n
              })
            onChangeParam({ type: 'categorical', choices })
          }}
          placeholder="逗号分隔，如 mse,huber 或 0.1,0.5,1.0"
          style={{ flex: 1 }}
        />
      ) : (
        <>
          <InputNumber
            value={param.low}
            onChange={(v) =>
              onChangeParam({ ...param, low: typeof v === 'number' ? v : 0 } as SearchSpaceParam)
            }
            placeholder="low"
            style={{ width: 110 }}
            stringMode={param.type === 'float'}
          />
          <InputNumber
            value={param.high}
            onChange={(v) =>
              onChangeParam({ ...param, high: typeof v === 'number' ? v : 1 } as SearchSpaceParam)
            }
            placeholder="high"
            style={{ width: 110 }}
            stringMode={param.type === 'float'}
          />
          {param.type === 'float' && (
            <Tooltip title="对数采样（适合 learning_rate 等量级跨多 decade 的参数）">
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '0 8px',
                  border: '1px solid #d9d9d9',
                  borderLeft: 'none',
                }}
              >
                <Switch
                  size="small"
                  checked={param.log === true}
                  onChange={(checked) =>
                    onChangeParam({ ...param, log: checked } as SearchSpaceParam)
                  }
                />
                <Tag color={param.log ? 'blue' : 'default'} style={{ margin: 0, fontSize: 10 }}>
                  log
                </Tag>
              </span>
            </Tooltip>
          )}
        </>
      )}
      <Popconfirm title="删除该参数？" onConfirm={onRemove}>
        <Button danger icon={<DeleteOutlined />} />
      </Popconfirm>
    </Space.Compact>
  )
}

export default SearchSpaceForm
