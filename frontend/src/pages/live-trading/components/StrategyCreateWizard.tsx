import React, { useEffect, useState } from 'react'
import {
  Modal,
  Steps,
  Select,
  Input,
  InputNumber,
  Switch,
  Form,
  Button,
  Space,
  App,
  Spin,
  Empty,
} from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { liveTradingService } from '@/services/liveTradingService'
import { useOpsPassword } from '@/hooks/useOpsPassword'
import type {
  NodeStatus,
  StrategyEngineInfo,
} from '@/types/liveTrading'

interface Props {
  open: boolean
  onClose: () => void
  nodes: NodeStatus[]
  /** V3.9: 跨页跳转预填（如从工作台 DeployModal 跳转过来） */
  initialValues?: {
    nodeId?: string
    engine?: string
    className?: string
    strategy_name?: string
    vt_symbol?: string
    /** 额外字段直接合并到 form 默认参数（如 mlflow_run_id / bundle_dir） */
    settingOverrides?: Record<string, unknown>
  }
}

/**
 * Dynamically render an input component for a parameter based on the runtime
 * type of its default value. vnpy returns a plain dict like {db_port: 3306,
 * poll_interval: 0.05, gateway: "QMT_SIM"}; we use typeof to pick Input /
 * InputNumber / Switch.
 */
function paramFormItem(key: string, defaultValue: unknown): React.ReactNode {
  if (typeof defaultValue === 'boolean') {
    return (
      <Form.Item key={key} name={key} label={key} valuePropName="checked">
        <Switch />
      </Form.Item>
    )
  }
  if (typeof defaultValue === 'number') {
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

const StrategyCreateWizard: React.FC<Props> = ({ open, onClose, nodes, initialValues }) => {
  const { message } = App.useApp()
  const { guardWrite } = useOpsPassword()
  const queryClient = useQueryClient()

  const [step, setStep] = useState(0)
  const [nodeId, setNodeId] = useState<string>('')
  const [engines, setEngines] = useState<StrategyEngineInfo[]>([])
  const [engine, setEngine] = useState<string>('')
  const [classes, setClasses] = useState<string[]>([])
  const [className, setClassName] = useState<string>('')
  const [defaultParams, setDefaultParams] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [form] = Form.useForm()

  // reset state when modal opens/closes
  useEffect(() => {
    if (open) {
      setStep(0)
      setNodeId('')
      setEngines([])
      setEngine('')
      setClasses([])
      setClassName('')
      setDefaultParams({})
      form.resetFields()
    }
  }, [open, form])

  // V3.9: initialValues 预填 + 自动推进步骤（链式异步加载 engines/classes/params）
  useEffect(() => {
    if (!open || !initialValues) return
    let cancelled = false

    const autoAdvance = async () => {
      try {
        if (initialValues.nodeId) {
          if (cancelled) return
          setNodeId(initialValues.nodeId)
          await loadEngines(initialValues.nodeId)
          if (cancelled) return

          if (initialValues.engine) {
            setEngine(initialValues.engine)
            await loadClasses(initialValues.nodeId, initialValues.engine)
            if (cancelled) return

            if (initialValues.className) {
              setClassName(initialValues.className)
              await loadParams(initialValues.nodeId, initialValues.engine, initialValues.className)
              if (cancelled) return
              // 预填 strategy_name / vt_symbol + setting 覆盖
              form.setFieldsValue({
                strategy_name: initialValues.strategy_name ?? '',
                vt_symbol: initialValues.vt_symbol ?? '',
                ...(initialValues.settingOverrides ?? {}),
              })
              setStep(3)
              return
            }
            setStep(2)
            return
          }
          setStep(1)
          return
        }
      } catch {
        // 加载失败用户从 step 0 手动操作即可
      }
    }
    autoAdvance()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialValues])

  const loadEngines = async (nid: string) => {
    setLoading(true)
    try {
      const resp = await liveTradingService.listEngines(nid)
      setEngines(resp.data || [])
    } catch (e) {
      message.error(`加载引擎列表失败: ${e}`)
      setEngines([])
    } finally {
      setLoading(false)
    }
  }

  const loadClasses = async (nid: string, eng: string) => {
    setLoading(true)
    try {
      const resp = await liveTradingService.listEngineClasses(nid, eng)
      setClasses(resp.data || [])
    } catch (e) {
      message.error(`加载策略类列表失败: ${e}`)
      setClasses([])
    } finally {
      setLoading(false)
    }
  }

  const loadParams = async (nid: string, eng: string, cls: string) => {
    setLoading(true)
    try {
      const resp = await liveTradingService.getClassParams(nid, eng, cls)
      const data = resp.data || {}
      setDefaultParams(data)
      form.setFieldsValue({ ...data, strategy_name: '', vt_symbol: '' })
    } catch (e) {
      message.error(`加载默认参数失败: ${e}`)
      setDefaultParams({})
    } finally {
      setLoading(false)
    }
  }

  const next = async () => {
    if (step === 0) {
      if (!nodeId) {
        message.warning('请选择节点')
        return
      }
      await loadEngines(nodeId)
      setStep(1)
    } else if (step === 1) {
      if (!engine) {
        message.warning('请选择引擎')
        return
      }
      await loadClasses(nodeId, engine)
      setStep(2)
    } else if (step === 2) {
      if (!className) {
        message.warning('请选择策略类')
        return
      }
      await loadParams(nodeId, engine, className)
      setStep(3)
    }
  }

  const prev = () => {
    if (step > 0) setStep(step - 1)
  }

  const submit = async () => {
    try {
      const values = await form.validateFields()
      const { strategy_name, vt_symbol, ...setting } = values
      if (!strategy_name) {
        message.warning('请填写策略名称')
        return
      }
      setSubmitting(true)
      const result = await guardWrite(() =>
        liveTradingService.createStrategy(nodeId, {
          engine,
          class_name: className,
          strategy_name,
          vt_symbol: vt_symbol || null,
          setting,
        }),
      )
      if (result) {
        message.success(`已创建策略: ${strategy_name}`)
        queryClient.invalidateQueries({ queryKey: ['live-strategies'] })
        onClose()
      }
    } catch (e: unknown) {
      // validateFields errors are handled by the form; surface others
      const msg = (e as { message?: string })?.message
      if (msg) message.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="新建策略"
      width={720}
      footer={
        <Space>
          {step > 0 && <Button onClick={prev}>上一步</Button>}
          {step < 3 && (
            <Button type="primary" onClick={next} loading={loading}>
              下一步
            </Button>
          )}
          {step === 3 && (
            <Button type="primary" onClick={submit} loading={submitting}>
              创建
            </Button>
          )}
          <Button onClick={onClose}>取消</Button>
        </Space>
      }
    >
      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 24 }}
        items={[
          { title: '选择节点' },
          { title: '选择引擎' },
          { title: '选择类' },
          { title: '填写参数' },
        ]}
      />

      {loading && (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      )}

      {!loading && step === 0 && (
        <Form layout="vertical">
          <Form.Item label="vnpy 节点" required>
            <Select
              value={nodeId || undefined}
              onChange={setNodeId}
              options={nodes.map((n) => ({
                value: n.node_id,
                label: `${n.node_id} (${n.online ? '在线' : '离线'})`,
                disabled: !n.online,
              }))}
              placeholder="选择一个在线节点"
            />
          </Form.Item>
        </Form>
      )}

      {!loading && step === 1 && (
        <Form layout="vertical">
          <Form.Item label="策略引擎" required>
            {engines.length === 0 ? (
              <Empty description="该节点未暴露任何策略引擎" />
            ) : (
              <Select
                value={engine || undefined}
                onChange={setEngine}
                options={engines.map((e) => ({
                  value: e.app_name,
                  label: `${e.display_name || e.app_name} (${e.app_name})`,
                  disabled: !(e.capabilities || []).includes('add'),
                }))}
              />
            )}
          </Form.Item>
        </Form>
      )}

      {!loading && step === 2 && (
        <Form layout="vertical">
          <Form.Item label="策略类" required>
            {classes.length === 0 ? (
              <Empty description="未发现可创建的策略类" />
            ) : (
              <Select
                value={className || undefined}
                onChange={setClassName}
                options={classes.map((c) => ({ value: c, label: c }))}
                showSearch
                filterOption={(input, option) =>
                  String(option?.label || '')
                    .toLowerCase()
                    .includes(input.toLowerCase())
                }
              />
            )}
          </Form.Item>
        </Form>
      )}

      {!loading && step === 3 && (
        <Form layout="vertical" form={form}>
          <Form.Item
            name="strategy_name"
            label="策略名称"
            rules={[{ required: true, message: '请输入策略名称' }]}
          >
            <Input placeholder="实例名，必须唯一" />
          </Form.Item>
          <Form.Item name="vt_symbol" label="vt_symbol（可选，CTA类策略填写）">
            <Input placeholder="例如 rb2501.SHFE，非单品种策略可留空" />
          </Form.Item>
          {Object.keys(defaultParams).length === 0 ? (
            <Empty description="该策略类未声明参数" />
          ) : (
            Object.entries(defaultParams).map(([k, v]) => paramFormItem(k, v))
          )}
        </Form>
      )}
    </Modal>
  )
}

export default StrategyCreateWizard
