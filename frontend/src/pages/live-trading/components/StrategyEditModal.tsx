import React, { useEffect } from 'react'
import { Modal, Form, Input, InputNumber, Switch, App } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { liveTradingService } from '@/services/liveTradingService'
import { useOpsPassword } from '@/hooks/useOpsPassword'

interface Props {
  open: boolean
  onClose: () => void
  nodeId: string
  engine: string
  name: string
  parameters: Record<string, unknown>
}

function formItem(key: string, value: unknown): React.ReactNode {
  if (typeof value === 'boolean') {
    return (
      <Form.Item key={key} name={key} label={key} valuePropName="checked">
        <Switch />
      </Form.Item>
    )
  }
  if (typeof value === 'number') {
    return (
      <Form.Item key={key} name={key} label={key}>
        <InputNumber style={{ width: '100%' }} />
      </Form.Item>
    )
  }
  return (
    <Form.Item key={key} name={key} label={key}>
      <Input />
    </Form.Item>
  )
}

const StrategyEditModal: React.FC<Props> = ({
  open,
  onClose,
  nodeId,
  engine,
  name,
  parameters,
}) => {
  const { message } = App.useApp()
  const { guardWrite } = useOpsPassword()
  const queryClient = useQueryClient()
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = React.useState(false)

  useEffect(() => {
    if (open) {
      form.setFieldsValue(parameters || {})
    }
  }, [open, parameters, form])

  const submit = async () => {
    const values = await form.validateFields()
    setSubmitting(true)
    const result = await guardWrite(() =>
      liveTradingService.editStrategy(nodeId, engine, name, { setting: values }),
    )
    setSubmitting(false)
    if (result) {
      message.success('参数已更新')
      queryClient.invalidateQueries({ queryKey: ['live-strategy', nodeId, engine, name] })
      queryClient.invalidateQueries({ queryKey: ['live-strategies'] })
      onClose()
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={submit}
      title={`编辑策略参数: ${name}`}
      confirmLoading={submitting}
      okText="保存"
      cancelText="取消"
      width={640}
    >
      <Form layout="vertical" form={form}>
        {Object.keys(parameters || {}).length === 0 ? (
          <div style={{ color: '#8c8c8c' }}>该策略未暴露任何参数</div>
        ) : (
          Object.entries(parameters || {}).map(([k, v]) => formItem(k, v))
        )}
      </Form>
    </Modal>
  )
}

export default StrategyEditModal
