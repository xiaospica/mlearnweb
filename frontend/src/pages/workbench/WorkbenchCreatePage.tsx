import React, { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Radio,
  Row,
  Space,
  Steps,
  Switch,
  Tag,
  Typography,
  Divider,
} from 'antd'
import {
  ArrowLeftOutlined,
  CodeOutlined,
  RocketOutlined,
  SaveOutlined,
} from '@ant-design/icons'

import { tuningService } from '@/services/tuningService'
import type {
  TuningJobCreateRequest,
  TuningConfigSnapshot,
  CustomSegment,
  GbdtModelConfig,
  BtStrategy,
} from '@/types/tuning'

const { Title, Text, Paragraph } = Typography

// ---------------------------------------------------------------------------
// 默认配置（与 config.py 主要参数对齐，用户可改）
// ---------------------------------------------------------------------------

const DEFAULT_GBDT: GbdtModelConfig = {
  class: 'LGBModel',
  module_path: 'qlib.contrib.model.gbdt',
  kwargs: {
    learning_rate: 0.05,
    num_leaves: 127,
    max_depth: 8,
    min_child_samples: 120,
    lambda_l1: 0.0,
    lambda_l2: 1.0,
    colsample_bytree: 0.8,
    subsample: 0.8,
    subsample_freq: 5,
    n_estimators: 10000,
    early_stopping_rounds: 50,
    seed: 42,
  },
}

const DEFAULT_BT_STRATEGY: BtStrategy = {
  topk: 7,
  n_drop: 1,
  only_tradable: true,
  signal: '<PRED>',
}

const DEFAULT_SEGMENTS_5P: CustomSegment[] = [
  {
    train: ['2007-01-01', '2013-12-31'],
    valid: ['2014-01-01', '2015-12-31'],
    test: ['2016-01-01', '2017-12-31'],
  },
  {
    train: ['2009-01-01', '2015-12-31'],
    valid: ['2016-01-01', '2017-12-31'],
    test: ['2018-01-01', '2019-12-31'],
  },
  {
    train: ['2011-01-01', '2017-12-31'],
    valid: ['2018-01-01', '2019-12-31'],
    test: ['2020-01-01', '2021-12-31'],
  },
  {
    train: ['2013-01-01', '2019-12-31'],
    valid: ['2020-01-01', '2021-12-31'],
    test: ['2022-01-01', '2023-12-31'],
  },
  {
    train: ['2015-01-01', '2021-12-31'],
    valid: ['2022-01-01', '2023-12-31'],
    test: ['2024-01-01', '2025-12-31'],
  },
]

const DEFAULT_RECORD_CONFIG: Array<Record<string, unknown>> = [
  { class: 'SignalRecord', module_path: 'qlib.workflow.record_temp' },
  { class: 'PortAnaRecord', module_path: 'qlib.workflow.record_temp' },
]

// ---------------------------------------------------------------------------
// JSON 编辑器（用 textarea，避免引入 Monaco 重依赖）
// ---------------------------------------------------------------------------

const JsonEditor: React.FC<{
  value: unknown
  onChange: (value: unknown) => void
  rows?: number
  placeholder?: string
}> = ({ value, onChange, rows = 8, placeholder }) => {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [error, setError] = useState<string | null>(null)

  // 当外部 value 变化时同步 textarea
  React.useEffect(() => {
    setText(JSON.stringify(value, null, 2))
    setError(null)
  }, [value])

  const handleBlur = () => {
    try {
      const parsed = JSON.parse(text)
      setError(null)
      onChange(parsed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON')
    }
  }

  return (
    <div>
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        rows={rows}
        placeholder={placeholder}
        style={{
          fontFamily: "'SF Mono', 'Consolas', monospace",
          fontSize: 12,
          background: '#fafbfc',
        }}
      />
      {error && (
        <Text type="danger" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
          ⚠ {error}
        </Text>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------

const WorkbenchCreatePage: React.FC = () => {
  const navigate = useNavigate()
  const { message } = App.useApp()

  const [step, setStep] = useState(0)
  const [advancedJsonMode, setAdvancedJsonMode] = useState(false)

  // 顶层基础参数
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [searchMode, setSearchMode] = useState<'single_segment' | 'walk_forward_5p'>(
    'walk_forward_5p',
  )
  const [nTrials, setNTrials] = useState(70)
  const [nJobs, setNJobs] = useState(1)
  const [numThreads, setNumThreads] = useState(20)
  const [seed, setSeed] = useState(42)

  // 5 类配置（config_snapshot 内容）
  const [taskConfig, setTaskConfig] = useState<Record<string, unknown>>({
    dataset_class: 'Alpha158Custom',
    instruments: 'all',
    label: ['Ref($close, -11) / Ref($close, -1) - 1'],
  })
  const [customSegments, setCustomSegments] =
    useState<CustomSegment[]>(DEFAULT_SEGMENTS_5P)
  const [gbdtModel, setGbdtModel] = useState<GbdtModelConfig>(DEFAULT_GBDT)
  const [btStrategy, setBtStrategy] = useState<BtStrategy>(DEFAULT_BT_STRATEGY)
  const [recordConfig, setRecordConfig] = useState<Array<Record<string, unknown>>>(
    DEFAULT_RECORD_CONFIG,
  )

  const configSnapshot: TuningConfigSnapshot = useMemo(
    () => ({
      task_config: taskConfig,
      custom_segments: searchMode === 'walk_forward_5p' ? customSegments : undefined,
      gbdt_model: gbdtModel,
      bt_strategy: btStrategy,
      record_config: recordConfig,
    }),
    [taskConfig, customSegments, gbdtModel, btStrategy, recordConfig, searchMode],
  )

  // ---------------- 提交 ----------------

  const createMutation = useMutation({
    mutationFn: (body: TuningJobCreateRequest) => tuningService.create(body),
    onSuccess: (resp) => {
      const jobId = resp.data?.id
      if (!jobId) {
        message.error('创建失败：无 job id')
        return
      }
      message.success(`Job ${jobId} 已创建，正在跳转监控页...`)
      navigate(`/workbench/jobs/${jobId}`)
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      message.error(err.response?.data?.detail ?? err.message)
    },
  })

  const startMutation = useMutation({
    mutationFn: (id: number) =>
      tuningService.start(id, { n_jobs: nJobs, num_threads: numThreads, seed }),
  })

  const handleSubmit = async (alsoStart: boolean) => {
    if (!name.trim()) {
      message.error('请填写 Job 名称')
      setStep(0)
      return
    }
    const body: TuningJobCreateRequest = {
      name: name.trim(),
      description: description.trim() || undefined,
      search_mode: searchMode,
      n_trials: nTrials,
      n_jobs: nJobs,
      num_threads: numThreads,
      seed,
      config_snapshot: configSnapshot,
    }
    const resp = await createMutation.mutateAsync(body)
    if (alsoStart && resp.data?.id) {
      try {
        await startMutation.mutateAsync(resp.data.id)
        message.success('subprocess 已启动')
      } catch (e) {
        const err = e as Error & { response?: { data?: { detail?: string } } }
        message.warning(`Job 已创建但启动失败：${err.response?.data?.detail ?? err.message}`)
      }
    }
  }

  // ---------------- 渲染 ----------------

  const stepItems = [
    { title: '基本信息' },
    { title: '时间分段' },
    { title: '模型' },
    { title: '回测' },
    { title: '评估器' },
  ]

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/workbench')}
          >
            返回列表
          </Button>
          <Title level={4} style={{ margin: 0 }}>
            新建调参 Job
          </Title>
          <div style={{ marginLeft: 'auto' }}>
            <Button
              icon={<CodeOutlined />}
              type={advancedJsonMode ? 'primary' : 'default'}
              onClick={() => setAdvancedJsonMode((v) => !v)}
            >
              {advancedJsonMode ? '退出 JSON 高级模式' : 'JSON 高级模式'}
            </Button>
          </div>
        </div>
      </Card>

      {advancedJsonMode ? (
        // ============ JSON 高级模式 ============
        <Card title="config_snapshot 整体编辑（专家模式）">
          <Paragraph type="secondary" style={{ fontSize: 13 }}>
            直接编辑 5 类参数的 JSON。失焦校验，无错误才会同步回 Stepper 表单。
          </Paragraph>
          <Divider />

          <Form layout="vertical">
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="Job 名称" required>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：CSI300 GBDT 跨期调参 v1"
                  />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="搜索模式">
                  <Radio.Group
                    value={searchMode}
                    onChange={(e) => setSearchMode(e.target.value)}
                  >
                    <Radio.Button value="single_segment">单期</Radio.Button>
                    <Radio.Button value="walk_forward_5p">跨期 5</Radio.Button>
                  </Radio.Group>
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="n_trials">
                  <InputNumber
                    value={nTrials}
                    onChange={(v) => setNTrials(v ?? 70)}
                    min={1}
                    max={500}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Col>
            </Row>
          </Form>

          <Divider orientation="left">5 类配置 JSON</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Title level={5}>task_config (CSI300_RECORD_LGB_TASK_CONFIG)</Title>
              <JsonEditor value={taskConfig} onChange={(v) => setTaskConfig(v as Record<string, unknown>)} rows={6} />
            </Col>
            <Col span={12}>
              <Title level={5}>custom_segments</Title>
              <JsonEditor
                value={customSegments}
                onChange={(v) => setCustomSegments(v as CustomSegment[])}
                rows={6}
              />
            </Col>
          </Row>
          <Row gutter={16} style={{ marginTop: 16 }}>
            <Col span={12}>
              <Title level={5}>gbdt_model (GBDT_MODEL)</Title>
              <JsonEditor value={gbdtModel} onChange={(v) => setGbdtModel(v as GbdtModelConfig)} rows={10} />
            </Col>
            <Col span={12}>
              <Title level={5}>bt_strategy (BT_STRATEGY)</Title>
              <JsonEditor value={btStrategy} onChange={(v) => setBtStrategy(v as BtStrategy)} rows={4} />
              <Title level={5} style={{ marginTop: 16 }}>
                record_config (RECORD_CONFIG)
              </Title>
              <JsonEditor
                value={recordConfig}
                onChange={(v) => setRecordConfig(v as Array<Record<string, unknown>>)}
                rows={4}
              />
            </Col>
          </Row>
        </Card>
      ) : (
        // ============ Stepper 5 步模式 ============
        <Card>
          <Steps
            current={step}
            items={stepItems}
            onChange={setStep}
            style={{ marginBottom: 24 }}
          />

          {/* Step 0: 基本信息 */}
          {step === 0 && (
            <Form layout="vertical">
              <Form.Item label="Job 名称" required>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：CSI300 GBDT 跨期调参 v1"
                />
              </Form.Item>
              <Form.Item label="描述">
                <Input.TextArea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="备注：本次调参的目标 / 假设 / 期望"
                />
              </Form.Item>
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item label="搜索模式">
                    <Radio.Group
                      value={searchMode}
                      onChange={(e) => setSearchMode(e.target.value)}
                    >
                      <Radio.Button value="single_segment">
                        单期（快，~3min/trial）
                      </Radio.Button>
                      <Radio.Button value="walk_forward_5p">
                        跨期 5（稳，~15min/trial）
                      </Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                </Col>
                <Col span={4}>
                  <Form.Item label="n_trials">
                    <InputNumber
                      value={nTrials}
                      onChange={(v) => setNTrials(v ?? 70)}
                      min={1}
                      max={500}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={4}>
                  <Form.Item label="n_jobs（并行）">
                    <InputNumber
                      value={nJobs}
                      onChange={(v) => setNJobs(v ?? 1)}
                      min={1}
                      max={4}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={4}>
                  <Form.Item label="num_threads">
                    <InputNumber
                      value={numThreads}
                      onChange={(v) => setNumThreads(v ?? 20)}
                      min={1}
                      max={64}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={4}>
                  <Form.Item label="seed">
                    <InputNumber
                      value={seed}
                      onChange={(v) => setSeed(v ?? 42)}
                      min={0}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Paragraph type="secondary" style={{ fontSize: 12 }}>
                ⚠ mlflow file backend 在并行下有 race condition，<Tag color="orange">建议 n_jobs=1</Tag>。
                跨期模式下每 trial ~15 分钟（5 期 × 3 分钟）。
              </Paragraph>
            </Form>
          )}

          {/* Step 1: 时间分段 */}
          {step === 1 && (
            <div>
              <Paragraph>
                {searchMode === 'walk_forward_5p' ? (
                  <>
                    跨期模式下需配置 <Text code>custom_segments</Text>（5 期 train/valid/test 时间段）。下方默认是 2007-2025 覆盖 5 个 regime 的标准滚动配置。
                  </>
                ) : (
                  <>
                    单期模式不需要 <Text code>custom_segments</Text>，只用 <Text code>task_config.segments</Text>（在第 4 步评估器或 task_config JSON 里）。
                  </>
                )}
              </Paragraph>
              {searchMode === 'walk_forward_5p' && (
                <JsonEditor
                  value={customSegments}
                  onChange={(v) => setCustomSegments(v as CustomSegment[])}
                  rows={20}
                />
              )}
            </div>
          )}

          {/* Step 2: 模型 */}
          {step === 2 && (
            <div>
              <Paragraph>
                LightGBM 超参基线值。Optuna 调参时会按内置搜索空间覆盖
                <Text code>learning_rate / num_leaves / max_depth / min_child_samples / lambda_l1 / lambda_l2 / colsample_bytree / subsample / subsample_freq / early_stopping_rounds</Text>
                10 个维度。其它参数（如 <Text code>n_estimators / num_threads / seed</Text>）保持基线。
              </Paragraph>
              <JsonEditor
                value={gbdtModel}
                onChange={(v) => setGbdtModel(v as GbdtModelConfig)}
                rows={20}
              />
            </div>
          )}

          {/* Step 3: 回测 */}
          {step === 3 && (
            <Form layout="vertical">
              <Row gutter={16}>
                <Col span={6}>
                  <Form.Item label="topk（持仓股数）" tooltip="每日持仓 TopK 个预测最高的">
                    <InputNumber
                      value={btStrategy.topk}
                      onChange={(v) => setBtStrategy({ ...btStrategy, topk: v ?? 7 })}
                      min={1}
                      max={100}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="n_drop（每日换手）" tooltip="每日换出 N 只">
                    <InputNumber
                      value={btStrategy.n_drop}
                      onChange={(v) => setBtStrategy({ ...btStrategy, n_drop: v ?? 1 })}
                      min={0}
                      max={50}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="only_tradable（仅可交易）">
                    <Switch
                      checked={btStrategy.only_tradable}
                      onChange={(v) =>
                        setBtStrategy({ ...btStrategy, only_tradable: v })
                      }
                    />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="signal（信号字段）">
                    <Input
                      value={btStrategy.signal}
                      onChange={(e) =>
                        setBtStrategy({ ...btStrategy, signal: e.target.value })
                      }
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Paragraph type="secondary" style={{ fontSize: 12 }}>
                典型 A 股 alpha 策略：topk=5-10，n_drop/topk ≈ 14% 月换手 ~140%。
              </Paragraph>
            </Form>
          )}

          {/* Step 4: 评估器 */}
          {step === 4 && (
            <div>
              <Paragraph>
                <Text code>RECORD_CONFIG</Text> 是 qlib 评估记录器列表（SignalRecord / SigAnaRecord / PortAnaRecord）。
                调参时会自动启用 <Text code>--with-multi-segment</Text> 让 train/valid/test 三段都生成回测 + IC 分析。
              </Paragraph>
              <Paragraph>
                <Text strong>task_config</Text>（task / dataset 配置）也在这里编辑：
              </Paragraph>
              <Title level={5}>task_config</Title>
              <JsonEditor value={taskConfig} onChange={(v) => setTaskConfig(v as Record<string, unknown>)} rows={6} />
              <Title level={5} style={{ marginTop: 16 }}>
                record_config
              </Title>
              <JsonEditor
                value={recordConfig}
                onChange={(v) => setRecordConfig(v as Array<Record<string, unknown>>)}
                rows={6}
              />
            </div>
          )}
        </Card>
      )}

      {/* 底部操作 */}
      <Card style={{ marginTop: 16 }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            {!advancedJsonMode && step > 0 && (
              <Button onClick={() => setStep(step - 1)}>上一步</Button>
            )}
            {!advancedJsonMode && step < stepItems.length - 1 && (
              <Button type="primary" onClick={() => setStep(step + 1)}>
                下一步
              </Button>
            )}
          </Space>
          <Space>
            <Button
              icon={<SaveOutlined />}
              loading={createMutation.isPending}
              onClick={() => handleSubmit(false)}
            >
              保存草稿
            </Button>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              loading={createMutation.isPending || startMutation.isPending}
              onClick={() => handleSubmit(true)}
            >
              立即启动
            </Button>
          </Space>
        </Space>
      </Card>
    </div>
  )
}

export default WorkbenchCreatePage
