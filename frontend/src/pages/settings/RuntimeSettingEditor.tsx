/**
 * 单条 Runtime 配置的编辑器（行级 UI 元件）
 *
 * 行为：
 * - 显示 label + 当前值（与默认值一致时灰字「跟随 .env」，被 DB 覆盖时显示「DB 覆盖」徽标）
 * - 编辑：受控输入控件（按 value_type 决定 InputNumber / Input / Tag editor），失焦或回车保存
 * - 保存成功后刷新外层 query；失败 message.error
 * - 「重置」按钮：DELETE /settings/runtime/{key}，回到 .env 默认
 *
 * Stateful 行设计的取舍：每行自己持有 editingValue 缓冲，避免在外层 form 中维护
 * 大对象；提交时只发改动的那条 PATCH。
 */

import { useEffect, useState } from 'react'
import {
  Input,
  InputNumber,
  Select,
  Button,
  Space,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from 'antd'
import {
  CheckOutlined,
  ReloadOutlined,
  SaveOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  patchRuntimeSetting,
  deleteRuntimeSetting,
  type RuntimeSettingItem,
} from '@/services/settingsService'

const { Text, Paragraph } = Typography

interface Props {
  item: RuntimeSettingItem
  /** 用于失败回滚到原始值 */
  invalidateKeys?: unknown[][]
}

const formatDisplayValue = (v: unknown, t: RuntimeSettingItem['value_type']): string => {
  if (v == null) return '—'
  if (t === 'list_str' && Array.isArray(v)) return (v as string[]).join(', ')
  return String(v)
}

const RuntimeSettingEditor = ({ item, invalidateKeys = [] }: Props) => {
  const queryClient = useQueryClient()
  const { message } = AntApp.useApp()

  const [draft, setDraft] = useState<unknown>(item.current_value)
  // 当外部刷新（query 重新 fetch）后，同步 draft
  useEffect(() => {
    setDraft(item.current_value)
  }, [item.current_value, item.source, item.updated_at])

  const dirty = JSON.stringify(draft) !== JSON.stringify(item.current_value)

  const patchMutation = useMutation({
    mutationFn: (v: unknown) => patchRuntimeSetting(item.key, v),
    onSuccess: () => {
      message.success(`${item.label} 已更新`)
      queryClient.invalidateQueries({ queryKey: ['settings', 'runtime'] })
      invalidateKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: k }))
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail ?? `${item.label} 保存失败`)
      setDraft(item.current_value)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteRuntimeSetting(item.key),
    onSuccess: () => {
      message.success(`${item.label} 已重置为 .env 默认`)
      queryClient.invalidateQueries({ queryKey: ['settings', 'runtime'] })
      invalidateKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: k }))
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail ?? `${item.label} 重置失败`)
    },
  })

  const isOverridden = item.source === 'db'
  const valuesEqual =
    JSON.stringify(item.current_value) === JSON.stringify(item.default_value)

  // 输入控件
  let editor: React.ReactNode = null
  if (item.value_type === 'int') {
    editor = (
      <InputNumber
        value={draft as number}
        onChange={(v) => setDraft(v ?? 0)}
        min={item.min ?? undefined}
        max={item.max ?? undefined}
        step={1}
        style={{ width: 180 }}
      />
    )
  } else if (item.value_type === 'float') {
    editor = (
      <InputNumber
        value={draft as number}
        onChange={(v) => setDraft(v ?? 0)}
        min={item.min ?? undefined}
        max={item.max ?? undefined}
        step={0.5}
        style={{ width: 180 }}
      />
    )
  } else if (item.value_type === 'list_str') {
    editor = (
      <Select
        mode="tags"
        value={(draft as string[]) ?? []}
        onChange={(v) => setDraft(v)}
        style={{ minWidth: 240 }}
        tokenSeparators={[',', ' ']}
        placeholder="例：.png, .jpg, .webp"
      />
    )
  } else {
    // str / bool 等先按 str 处理；当前 registry 没有 bool
    editor = (
      <Input
        value={(draft as string) ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        style={{ width: '100%', maxWidth: 480 }}
      />
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingBlock: 10,
        borderBottom: '1px dashed var(--ap-border-muted)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text strong>{item.label}</Text>
        {item.hot_reload && (
          <Tooltip title="无需重启即可生效（最多 5 秒后被各进程读到）">
            <Tag color="green" icon={<ThunderboltOutlined />}>热改</Tag>
          </Tooltip>
        )}
        {isOverridden ? (
          <Tag color="blue">DB 覆盖</Tag>
        ) : (
          <Tag>跟随 .env</Tag>
        )}
        {item.updated_at && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            更新于 {new Date(item.updated_at).toLocaleString()}
          </Text>
        )}
      </div>

      <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
        {item.description}
      </Paragraph>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {editor}
        <Button
          type="primary"
          size="small"
          icon={dirty ? <SaveOutlined /> : <CheckOutlined />}
          loading={patchMutation.isPending}
          disabled={!dirty}
          onClick={() => patchMutation.mutate(draft)}
        >
          {dirty ? '保存' : '已保存'}
        </Button>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={deleteMutation.isPending}
          disabled={!isOverridden}
          onClick={() => deleteMutation.mutate()}
        >
          重置为 .env
        </Button>
      </div>

      {!valuesEqual && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          .env 默认：<Text code>{formatDisplayValue(item.default_value, item.value_type)}</Text>
        </Text>
      )}
      {dirty && (
        <Text type="warning" style={{ fontSize: 12 }}>
          <WarningOutlined /> 有未保存的修改
        </Text>
      )}
    </div>
  )
}

export default RuntimeSettingEditor
