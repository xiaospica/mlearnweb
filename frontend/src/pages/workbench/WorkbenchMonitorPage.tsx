import React, { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Row,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ArrowLeftOutlined,
  ClockCircleOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RocketOutlined,
  SaveOutlined,
  StopOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import type { ColumnsType } from 'antd/es/table'

import { tuningService } from '@/services/tuningService'
import JsonCodeEditor from '@/components/workbench/JsonCodeEditor'
import type {
  TuningJob,
  TuningJobStatus,
  TuningProgress,
  TuningTrial,
  WalkForwardResults,
  WalkForwardRow,
  ReproduceAggregate,
} from '@/types/tuning'

const { Title, Text, Paragraph } = Typography

const STATUS_CONFIG: Record<
  TuningJobStatus,
  { color: string; label: string; badge: 'default' | 'processing' | 'success' | 'error' | 'warning' }
> = {
  created: { color: 'default', label: '待启动', badge: 'default' },
  running: { color: 'processing', label: '运行中', badge: 'processing' },
  searching: { color: 'processing', label: '搜索中', badge: 'processing' },
  finalizing: { color: 'orange', label: 'Finalize 中', badge: 'processing' },
  done: { color: 'success', label: '已完成', badge: 'success' },
  cancelled: { color: 'default', label: '已取消', badge: 'default' },
  failed: { color: 'error', label: '失败', badge: 'error' },
  zombie: { color: 'warning', label: '僵尸（进程已死）', badge: 'warning' },
}

const isTerminal = (status: TuningJobStatus) =>
  ['done', 'cancelled', 'failed', 'zombie'].includes(status)

// ---------------------------------------------------------------------------
// Trial 表
// ---------------------------------------------------------------------------

// 工厂方法：trial 表列定义（需要 navigate + experiment_id 闭包）
const buildTrialColumns = (
  navigate: (path: string) => void,
  experimentId: string,
): ColumnsType<TuningTrial> => [
  {
    title: '#',
    dataIndex: 'trial_number',
    key: 'trial_number',
    width: 60,
    sorter: (a, b) => a.trial_number - b.trial_number,
  },
  {
    title: '状态',
    dataIndex: 'state',
    key: 'state',
    width: 100,
    render: (state: string) => {
      const colors: Record<string, string> = {
        completed: 'success',
        running: 'processing',
        failed: 'error',
        metrics_missing: 'warning',
        no_run_index: 'warning',
      }
      return <Tag color={colors[state] ?? 'default'}>{state}</Tag>
    },
  },
  {
    title: 'valid_sharpe',
    dataIndex: 'valid_sharpe',
    key: 'valid_sharpe',
    width: 110,
    sorter: (a, b) => (a.valid_sharpe ?? -999) - (b.valid_sharpe ?? -999),
    render: (v: number | null) =>
      v != null ? (
        <Text
          strong
          style={{
            fontFamily: "'SF Mono', monospace",
            color: v >= 0.5 ? '#52c41a' : v >= 0 ? '#faad14' : '#ff4d4f',
          }}
        >
          {v.toFixed(4)}
        </Text>
      ) : (
        <Text type="secondary">—</Text>
      ),
  },
  {
    title: 'test_sharpe',
    dataIndex: 'test_sharpe',
    key: 'test_sharpe',
    width: 110,
    sorter: (a, b) => (a.test_sharpe ?? -999) - (b.test_sharpe ?? -999),
    render: (v: number | null) =>
      v != null ? (
        <Text style={{ fontFamily: "'SF Mono', monospace" }}>{v.toFixed(4)}</Text>
      ) : (
        <Text type="secondary">—</Text>
      ),
  },
  {
    title: 'overfit_ratio',
    dataIndex: 'overfit_ratio',
    key: 'overfit_ratio',
    width: 110,
    render: (v: number | null) =>
      v != null ? (
        <Text
          style={{
            fontFamily: "'SF Mono', monospace",
            color: v > 5 ? '#ff4d4f' : v > 2 ? '#faad14' : '#52c41a',
          }}
        >
          {v.toFixed(2)}
        </Text>
      ) : (
        <Text type="secondary">—</Text>
      ),
  },
  {
    title: '硬约束',
    dataIndex: 'hard_constraint_passed',
    key: 'hard_constraint_passed',
    width: 90,
    render: (v: boolean, record: TuningTrial) =>
      v ? (
        <Tag color="success">通过</Tag>
      ) : (
        <Tooltip
          title={
            record.hard_constraint_failed_items?.length > 0
              ? record.hard_constraint_failed_items.join(', ')
              : '无'
          }
        >
          <Tag color="default">未通过</Tag>
        </Tooltip>
      ),
  },
  {
    title: '参数',
    dataIndex: 'params',
    key: 'params',
    render: (params: Record<string, number | string>) => (
      <Tooltip title={<pre style={{ fontSize: 11, margin: 0 }}>{JSON.stringify(params, null, 2)}</pre>}>
        <Text style={{ fontSize: 11, fontFamily: "'SF Mono', monospace" }}>
          lr={Number(params?.learning_rate ?? 0).toFixed(4)}, leaves={params?.num_leaves}, depth={params?.max_depth}
        </Text>
      </Tooltip>
    ),
  },
  {
    title: '耗时',
    dataIndex: 'duration_sec',
    key: 'duration_sec',
    width: 80,
    render: (v: number | null) =>
      v != null ? `${Math.round(v)}s` : <Text type="secondary">—</Text>,
  },
  {
    title: '报告',
    dataIndex: 'run_id',
    key: 'run_id',
    width: 110,
    render: (run_id: string | null) =>
      run_id ? (
        <Tooltip title={`mlflow run_id: ${run_id}`}>
          <Button
            type="link"
            size="small"
            onClick={() => navigate(`/report/${experimentId}/${run_id}`)}
          >
            查看报告
          </Button>
        </Tooltip>
      ) : (
        <Text type="secondary">—</Text>
      ),
  },
]

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------

const WorkbenchMonitorPage: React.FC = () => {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const queryClient = useQueryClient()

  const id = Number(jobId)
  const experimentId = '374089520733232109'  // mlflow rolling_exp（与命令行同实验）

  const [activeTab, setActiveTab] = useState<'trials' | 'walk_forward' | 'logs' | 'config'>(
    'trials',
  )
  // 默认 stdout：看 train 子进程的实时进度（含 qlib 训练 / 回测 print 输出）；
  // 想看结构化的 trial 元事件（trial 0 done）切到 tuning
  const [logSource, setLogSource] = useState<'tuning' | 'stdout' | 'all'>('stdout')
  const [logAutoRefresh, setLogAutoRefresh] = useState(true)
  const [progress, setProgress] = useState<TuningProgress | null>(null)
  const [sseError, setSseError] = useState<string | null>(null)
  const [finalizeModalOpen, setFinalizeModalOpen] = useState(false)
  const [deployModalOpen, setDeployModalOpen] = useState(false)
  // V3.4 跨期验证：trial 多选 + Modal
  const [selectedTrials, setSelectedTrials] = useState<number[]>([])
  const [walkForwardModalOpen, setWalkForwardModalOpen] = useState(false)
  // 用户在 WF Panel 点 Finalize 时，把 trial_number 通过 state 喂给 FinalizeModal
  const [finalizeOverrideTrialNum, setFinalizeOverrideTrialNum] = useState<number | null>(null)

  const { data: jobData, isLoading: jobLoading } = useQuery({
    queryKey: ['tuning-job', id],
    queryFn: () => tuningService.get(id),
    refetchInterval: 30_000,
    enabled: !Number.isNaN(id),
  })

  const job: TuningJob | undefined = jobData?.data

  const { data: trialsData, refetch: refetchTrials } = useQuery({
    queryKey: ['tuning-trials', id],
    queryFn: () =>
      tuningService.listTrials(id, {
        sort_by: 'valid_sharpe',
        desc: true,
      }),
    refetchInterval: 15_000,
    enabled: !Number.isNaN(id),
  })

  // SSE：实时进度推送
  const eventSourceRef = useRef<EventSource | null>(null)
  useEffect(() => {
    if (Number.isNaN(id) || !job || isTerminal(job.status)) return
    const es = new EventSource(tuningService.eventsUrl(id))
    eventSourceRef.current = es

    es.addEventListener('progress', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as TuningProgress
        setProgress(data)
        // 终态时关闭 SSE
        if (isTerminal(data.status)) {
          es.close()
          // 触发 trials / job 拉取一次
          refetchTrials()
          queryClient.invalidateQueries({ queryKey: ['tuning-job', id] })
        }
      } catch (e) {
        console.warn('SSE progress parse error:', e)
      }
    })

    es.addEventListener('end', () => {
      es.close()
      refetchTrials()
      queryClient.invalidateQueries({ queryKey: ['tuning-job', id] })
    })

    es.onerror = () => {
      setSseError('SSE 连接已断开（5s 自动重连或刷新页面）')
    }

    return () => {
      es.close()
      eventSourceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, job?.status])

  // ---------------- 操作 ----------------

  const startMutation = useMutation({
    mutationFn: (jobId: number) => tuningService.start(jobId),
    onSuccess: () => {
      message.success('已启动')
      queryClient.invalidateQueries({ queryKey: ['tuning-job', id] })
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      message.error(err.response?.data?.detail ?? err.message)
    },
  })

  const cancelMutation = useMutation({
    mutationFn: (jobId: number) => tuningService.cancel(jobId),
    onSuccess: () => {
      message.success('已取消')
      queryClient.invalidateQueries({ queryKey: ['tuning-job', id] })
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      message.error(err.response?.data?.detail ?? err.message)
    },
  })

  const finalizeMutation = useMutation({
    mutationFn: (body: { trial_number: number }) =>
      tuningService.finalize(id, body),
    onSuccess: (resp) => {
      const recordId = (resp.data as { training_record_id?: number } | undefined)?.training_record_id
      if (recordId) {
        message.success({
          content: (
            <span>
              已关联到训练记录 #{recordId}{' '}
              <a onClick={() => navigate(`/training/${recordId}`)}>跳转查看</a>
            </span>
          ),
          duration: 6,
        })
      }
      setFinalizeModalOpen(false)
      queryClient.invalidateQueries({ queryKey: ['tuning-job', id] })
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      message.error(err.response?.data?.detail ?? err.message)
    },
  })

  const deployMutation = useMutation({
    mutationFn: (body: {
      node_id: string
      engine: string
      class_name: string
      strategy_name: string
      vt_symbol?: string
    }) => tuningService.deploy(id, body),
    onSuccess: () => {
      message.success('已转调 vnpy create_strategy')
      setDeployModalOpen(false)
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      message.error(err.response?.data?.detail ?? err.message)
    },
  })

  // V3.4 跨期验证 + multi-seed reproduce
  const { data: wfData, refetch: refetchWalkForward } = useQuery({
    queryKey: ['tuning-walk-forward', id],
    queryFn: () => tuningService.getWalkForwardResults(id),
    refetchInterval: 10_000,
    enabled: !Number.isNaN(id),
  })
  const walkForwardResults: WalkForwardResults | undefined = wfData?.data

  const walkForwardMutation = useMutation({
    mutationFn: (body: {
      trial_numbers: number[]
      seed: number
      reproduce_seeds: number[] | null
    }) =>
      tuningService.startWalkForward(id, {
        trial_numbers: body.trial_numbers,
        seed: body.seed,
        reproduce_seeds: body.reproduce_seeds ?? undefined,
      }),
    onSuccess: (resp) => {
      const repCount = resp.data?.reproduce_seeds?.length ?? 0
      message.success(
        `跨期验证已启动${repCount > 0 ? ` + multi-seed reproduce (${repCount} seed)` : ''}；切到"跨期验证"Tab 查看进度`,
      )
      setWalkForwardModalOpen(false)
      setActiveTab('walk_forward')
      refetchWalkForward()
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      message.error(err.response?.data?.detail ?? err.message)
    },
  })

  // ---------------- 渲染 ----------------

  if (Number.isNaN(id)) {
    return <Alert type="error" message="无效的 job id" showIcon />
  }

  if (jobLoading || !job) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 0' }}>
        <Spin size="large" />
      </div>
    )
  }

  const cfg = STATUS_CONFIG[job.status] ?? { color: 'default', label: job.status, badge: 'default' as const }
  const trials = trialsData?.data?.items ?? []
  const target = job.n_trials_target
  const done = progress?.n_trials_done ?? job.n_trials_done
  const failed = progress?.n_trials_failed ?? job.n_trials_failed
  const best = progress?.best_objective_value ?? job.best_objective_value
  const bestNum = progress?.best_trial_number ?? job.best_trial_number
  const status = (progress?.status ?? job.status) as TuningJobStatus
  const liveCfg = STATUS_CONFIG[status] ?? cfg
  const pct = target > 0 ? Math.floor((done / target) * 100) : 0

  return (
    <div>
      {/* 顶部 Header */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/workbench')}>
            返回
          </Button>
          <Title level={4} style={{ margin: 0 }}>
            {job.name}
          </Title>
          <Badge status={liveCfg.badge} text={liveCfg.label} />
          {sseError && <Tag color="warning">{sseError}</Tag>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {(['running', 'searching'] as TuningJobStatus[]).includes(status) && (
              <Popconfirm
                title="确定取消该 job 吗？"
                description="将 SIGTERM 子进程，已完成的 trial 数据保留"
                onConfirm={() => cancelMutation.mutate(id)}
              >
                <Button danger icon={<StopOutlined />}>
                  停止
                </Button>
              </Popconfirm>
            )}
            {(['done', 'cancelled'] as TuningJobStatus[]).includes(status) && (
              <Button
                icon={<SaveOutlined />}
                disabled={!bestNum && bestNum !== 0}
                onClick={() => setFinalizeModalOpen(true)}
              >
                Finalize 最佳模型
              </Button>
            )}
            {job.finalized_training_record_id && (
              <Button
                type="primary"
                icon={<RocketOutlined />}
                onClick={() => setDeployModalOpen(true)}
              >
                部署到实盘
              </Button>
            )}
            {(['created', 'cancelled', 'failed', 'zombie', 'done'] as TuningJobStatus[]).includes(status) && (
              <Button
                type={status === 'created' ? 'primary' : 'default'}
                onClick={() => startMutation.mutate(id)}
                loading={startMutation.isPending}
              >
                {status === 'created' ? '启动' : '重新启动'}
              </Button>
            )}
          </div>
        </div>

        {job.error && (
          <Alert
            type={status === 'zombie' ? 'warning' : 'error'}
            message={job.error}
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        <Row gutter={32}>
          <Col span={6}>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                进度
              </Text>
              <div style={{ marginTop: 4 }}>
                <Progress
                  percent={pct}
                  status={
                    status === 'failed' || status === 'zombie'
                      ? 'exception'
                      : status === 'done'
                        ? 'success'
                        : 'active'
                  }
                />
                <Text style={{ fontSize: 12 }}>
                  {done}/{target} trial 完成
                  {failed > 0 && (
                    <span style={{ color: '#ff4d4f', marginLeft: 8 }}>失败 {failed}</span>
                  )}
                </Text>
              </div>
            </div>
          </Col>
          <Col span={6}>
            <Statistic
              title="Best valid_sharpe"
              value={best != null ? best : '—'}
              precision={best != null ? 4 : 0}
              valueStyle={{
                color: best != null && best >= 0.5 ? '#52c41a' : '#faad14',
                fontFamily: "'SF Mono', monospace",
              }}
              suffix={
                bestNum != null ? (
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    #{bestNum}
                  </Text>
                ) : null
              }
            />
          </Col>
          <Col span={6}>
            <Statistic
              title="搜索模式"
              value={
                job.search_mode === 'walk_forward_5p' ? '跨期 5 期' : '单期'
              }
              valueStyle={{ fontSize: 18 }}
            />
          </Col>
          <Col span={6}>
            <Statistic
              title="运行时长"
              value={
                progress?.duration_seconds != null
                  ? formatDuration(progress.duration_seconds)
                  : job.duration_seconds != null
                    ? formatDuration(job.duration_seconds)
                    : '—'
              }
              prefix={<ClockCircleOutlined />}
              valueStyle={{ fontSize: 18 }}
            />
          </Col>
        </Row>

        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>创建时间</Text>
            <div>{dayjs(job.created_at).format('YYYY-MM-DD HH:mm:ss')}</div>
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>启动时间</Text>
            <div>
              {job.started_at ? dayjs(job.started_at).format('YYYY-MM-DD HH:mm:ss') : '—'}
            </div>
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>完成时间</Text>
            <div>
              {job.completed_at ? dayjs(job.completed_at).format('YYYY-MM-DD HH:mm:ss') : '—'}
            </div>
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>finalized</Text>
            <div>
              {job.finalized_training_record_id ? (
                <a onClick={() => navigate(`/training/${job.finalized_training_record_id}`)}>
                  Training Record #{job.finalized_training_record_id}
                </a>
              ) : (
                <Text type="secondary">未 finalize</Text>
              )}
            </div>
          </Col>
        </Row>
      </Card>

      {/* Trials / 实时日志 / 配置快照 Tabs */}
      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as 'trials' | 'logs' | 'config')}
          items={[
            {
              key: 'trials',
              label: (
                <span>
                  <UnorderedListOutlined /> Trials 表（按 valid_sharpe 降序，共 {trials.length} 行）
                </span>
              ),
              children: (
                <div>
                  <div
                    style={{
                      marginBottom: 8,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <Button
                      type="primary"
                      icon={<ExperimentOutlined />}
                      disabled={selectedTrials.length === 0 || !isTerminal(status)}
                      onClick={() => setWalkForwardModalOpen(true)}
                      title={
                        !isTerminal(status)
                          ? '需先完成搜索（done/cancelled/failed）才能跨期验证'
                          : '对选中 trial 跑跨期 walk-forward + 可选 multi-seed reproduce'
                      }
                    >
                      跨期验证选中 ({selectedTrials.length})
                    </Button>
                    {selectedTrials.length > 0 && (
                      <Button
                        size="small"
                        onClick={() => setSelectedTrials([])}
                      >
                        清空选择
                      </Button>
                    )}
                    <div style={{ marginLeft: 'auto' }}>
                      <Button
                        icon={<ReloadOutlined />}
                        size="small"
                        onClick={() => refetchTrials()}
                      >
                        刷新
                      </Button>
                    </div>
                  </div>
                  {trials.length === 0 ? (
                    <Empty description="还没有 trial。等 subprocess 启动后会陆续出现（trial 启动时会先写一行 running 状态，完成后更新最终指标）。" />
                  ) : (
                    <Table
                      dataSource={trials}
                      columns={buildTrialColumns(navigate, experimentId)}
                      rowKey="trial_number"
                      size="small"
                      pagination={{ pageSize: 30 }}
                      scroll={{ x: 1000 }}
                      rowClassName={(record) =>
                        record.trial_number === bestNum ? 'best-trial-row' : ''
                      }
                      rowSelection={{
                        selectedRowKeys: selectedTrials,
                        onChange: (keys) => setSelectedTrials(keys as number[]),
                        getCheckboxProps: (record) => ({
                          disabled: record.state !== 'completed',
                        }),
                      }}
                    />
                  )}
                </div>
              ),
            },
            {
              key: 'walk_forward',
              label: (
                <span>
                  <ExperimentOutlined /> 跨期验证
                  {walkForwardResults?.running ? (
                    <Tag color="processing" style={{ marginLeft: 6 }}>
                      运行中
                    </Tag>
                  ) : walkForwardResults?.walk_forward.length ? (
                    <Tag color="success" style={{ marginLeft: 6 }}>
                      {walkForwardResults.walk_forward.length} trial
                    </Tag>
                  ) : null}
                </span>
              ),
              children: (
                <WalkForwardPanel
                  jobId={id}
                  results={walkForwardResults}
                  onRefresh={refetchWalkForward}
                  onFinalize={(trial_number) => {
                    setFinalizeOverrideTrialNum(trial_number)
                    setFinalizeModalOpen(true)
                  }}
                />
              ),
            },
            {
              key: 'logs',
              label: (
                <span>
                  <FileTextOutlined /> 实时日志
                </span>
              ),
              children: (
                <LogPanel
                  jobId={id}
                  source={logSource}
                  onSourceChange={setLogSource}
                  autoRefresh={logAutoRefresh && !isTerminal(status)}
                  onAutoRefreshChange={setLogAutoRefresh}
                  isTerminal={isTerminal(status)}
                />
              ),
            },
            {
              key: 'config',
              label: (
                <span>
                  <FileTextOutlined /> 配置快照
                </span>
              ),
              children: <ConfigSnapshotPanel job={job} />,
            },
          ]}
        />
      </Card>

      <style>{`
        .best-trial-row { background: #f6ffed !important; }
        .best-trial-row:hover td { background: #d9f7be !important; }
      `}</style>

      <FinalizeModal
        open={finalizeModalOpen}
        onClose={() => {
          setFinalizeModalOpen(false)
          setFinalizeOverrideTrialNum(null)
        }}
        defaultTrialNumber={finalizeOverrideTrialNum ?? bestNum ?? 0}
        bestSharpe={best ?? null}
        loading={finalizeMutation.isPending}
        onSubmit={(values) => finalizeMutation.mutate(values)}
      />

      <DeployModal
        open={deployModalOpen}
        onClose={() => setDeployModalOpen(false)}
        finalizedRecordId={job.finalized_training_record_id ?? null}
        loading={deployMutation.isPending}
        onSubmit={(values) => deployMutation.mutate(values)}
      />

      <WalkForwardModal
        open={walkForwardModalOpen}
        onClose={() => setWalkForwardModalOpen(false)}
        selectedTrials={selectedTrials}
        loading={walkForwardMutation.isPending}
        onSubmit={(values) => walkForwardMutation.mutate(values)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Finalize Modal：让用户确认 trial number + seed + 命名，然后启动正式训练
// ---------------------------------------------------------------------------

const FinalizeModal: React.FC<{
  open: boolean
  onClose: () => void
  defaultTrialNumber: number
  bestSharpe: number | null
  loading: boolean
  onSubmit: (values: { trial_number: number }) => void
}> = ({ open, onClose, defaultTrialNumber, bestSharpe, loading, onSubmit }) => {
  const [form] = Form.useForm()

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ trial_number: defaultTrialNumber })
    }
  }, [open, defaultTrialNumber, form])

  return (
    <Modal
      title="Finalize — 关联到该 trial 的训练记录"
      open={open}
      onCancel={onClose}
      onOk={() => {
        form.validateFields().then((values) => onSubmit(values))
      }}
      okText="确认关联"
      cancelText="取消"
      confirmLoading={loading}
      width={560}
    >
      <Alert
        type="success"
        showIcon
        message="零成本：直接索引到该 trial 已有的训练记录"
        description={
          <>
            搜索时每个 trial 子进程已创建独立 training_record（含 SHAP / 收益曲线 /
            IC 分析等完整 artifact）。Finalize 仅通过 trial 的 mlflow run_id 反查
            <Typography.Text code>training_run_mappings</Typography.Text> 表找到对应
            record，<Typography.Text strong>不重新训练</Typography.Text>，立即返回。
          </>
        }
        style={{ marginBottom: 16 }}
      />
      <Form form={form} layout="vertical">
        <Form.Item
          label="trial_number"
          name="trial_number"
          rules={[{ required: true }]}
          tooltip={
            bestSharpe != null
              ? `默认 best trial（valid_sharpe=${bestSharpe.toFixed(4)}）`
              : '从 trial 表挑一个 trial number'
          }
        >
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Deploy Modal：将 finalize 后的模型部署到 vnpy 实盘
// ---------------------------------------------------------------------------

const DeployModal: React.FC<{
  open: boolean
  onClose: () => void
  finalizedRecordId: number | null
  loading: boolean
  onSubmit: (values: {
    node_id: string
    engine: string
    class_name: string
    strategy_name: string
    vt_symbol?: string
  }) => void
}> = ({ open, onClose, finalizedRecordId, loading, onSubmit }) => {
  const [form] = Form.useForm()

  return (
    <Modal
      title="部署到 vnpy 实盘"
      open={open}
      onCancel={onClose}
      onOk={() => {
        form.validateFields().then((values) => onSubmit(values))
      }}
      okText="部署"
      cancelText="取消"
      confirmLoading={loading}
      width={620}
    >
      <Alert
        type="warning"
        showIcon
        message="实盘部署不可逆，请谨慎"
        description={
          finalizedRecordId
            ? `将基于 finalize 产物 (training_record #${finalizedRecordId}) 的 mlflow run + bundle_dir 在 vnpy 节点创建策略实例。`
            : 'job 尚未 finalize；请先点 Finalize 按钮跑正式训练'
        }
        style={{ marginBottom: 16 }}
      />
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="node_id" name="node_id" rules={[{ required: true }]}
                       tooltip="vnpy 节点 ID（如 'local'，配置在 vnpy_nodes.yaml）">
              <Input placeholder="local" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="engine" name="engine" rules={[{ required: true }]}
                       tooltip="vnpy engine 名（如 'cta'）">
              <Input placeholder="cta" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="class_name" name="class_name" rules={[{ required: true }]}
                   tooltip="vnpy 策略类名（与 vnpy_ml_strategy 中定义一致）">
          <Input placeholder="MLPredictStrategy" />
        </Form.Item>
        <Form.Item label="strategy_name" name="strategy_name" rules={[{ required: true }]}
                   tooltip="vnpy 策略实例名（唯一标识）">
          <Input placeholder="ml_csi300_v1" />
        </Form.Item>
        <Form.Item label="vt_symbol（可选）" name="vt_symbol">
          <Input placeholder="例如 000001.SZSE" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// 配置快照面板（展示用户在创建页填的 5 类参数 + 运行参数）
// ---------------------------------------------------------------------------

const ConfigSnapshotPanel: React.FC<{ job: TuningJob }> = ({ job }) => {
  const config = job.config_snapshot
  if (!config) {
    return <Empty description="无配置快照（旧 job 可能未记录）" />
  }

  const sections: Array<{
    key: string
    title: string
    effective: boolean
    note: string
    value: unknown
  }> = [
    {
      key: 'gbdt_model',
      title: 'GBDT 模型基线超参（gbdt_model）',
      effective: true,
      note: '✅ 生效：--gbdt-overrides 注入 model.kwargs（基线值，Optuna 采样会按 search_space 覆盖部分维度）',
      value: config.gbdt_model,
    },
    {
      key: 'search_space',
      title: 'Optuna 搜索空间（search_space）',
      effective: true,
      note: '✅ 生效：--search-space-json 让 Optuna 在该范围内采样，覆盖 gbdt_model 中对应维度',
      value: config.search_space,
    },
    {
      key: 'task_config',
      title: '任务配置（task_config / 数据集 / 特征 / 标签）',
      effective: true,
      note: '✅ 生效：--task-config-json 完全替换 baseline（WYSIWYG — 这里显示什么 = 训练实际跑什么；缺失的 model / record 由 gbdt_model / record_config 字段单独提供）',
      value: config.task_config,
    },
    {
      key: 'custom_segments',
      title: 'Walk-Forward 时间分段（custom_segments）',
      effective: true,
      note: '✅ 生效：--custom-segments-json 完全替换 train script 内 CUSTOM_SEGMENTS',
      value: config.custom_segments,
    },
    {
      key: 'record_config',
      title: '评估记录器（record_config，含回测策略 strategy.kwargs）',
      effective: true,
      note: '✅ 生效：--record-config-json 完全替换 task_config["record"] 列表',
      value: config.record_config,
    },
  ]

  return (
    <div>
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 12 }}
        message="V2: 5 类配置全部已注入训练流程"
        description="提交时这 5 类参数已分别写成 JSON 文件传给 train script。GBDT 超参由 Optuna 在搜索空间内采样覆盖；其余 4 类是 job 级常量。"
      />
      <Tabs
        type="card"
        items={sections.map((sec) => ({
          key: sec.key,
          label: (
            <Space size={6}>
              <Tag
                color={sec.effective ? 'success' : 'warning'}
                style={{ marginInlineEnd: 0 }}
              >
                {sec.effective ? '生效' : '占位'}
              </Tag>
              <span>{sec.title.split('（')[0]}</span>
            </Space>
          ),
          children: (
            <div>
              <Text
                type="secondary"
                style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
              >
                {sec.note}
              </Text>
              {sec.value !== undefined && sec.value !== null ? (
                <JsonCodeEditor
                  value={sec.value}
                  onChange={() => undefined}
                  readonly
                />
              ) : (
                <Empty description="（未配置）" />
              )}
            </div>
          ),
        }))}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 实时日志面板（嵌入 Tab，2s 自动刷新）
// ---------------------------------------------------------------------------

const LogPanel: React.FC<{
  jobId: number
  source: 'tuning' | 'stdout' | 'all'
  onSourceChange: (s: 'tuning' | 'stdout' | 'all') => void
  autoRefresh: boolean
  onAutoRefreshChange: (v: boolean) => void
  isTerminal: boolean
}> = ({ jobId, source, onSourceChange, autoRefresh, onAutoRefreshChange, isTerminal }) => {
  const preRef = useRef<HTMLPreElement | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  // 高度自适应：测 pre 顶部到 viewport bottom 的距离
  const [logHeight, setLogHeight] = useState<number>(480)

  const { data, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['tuning-logs', jobId, source],
    queryFn: () => tuningService.getLogs(jobId, 65536, source),
    // 运行中 2s 自动刷新；终态时停止
    refetchInterval: autoRefresh ? 2_000 : false,
  })

  const text = data?.data?.text ?? ''

  // 高度自适应：viewport 高度变化或 pre 位置变化时重算
  useEffect(() => {
    const update = () => {
      if (preRef.current) {
        const top = preRef.current.getBoundingClientRect().top
        // 预留底部 24px 留白
        setLogHeight(Math.max(280, window.innerHeight - top - 24))
      }
    }
    // 用 rAF 等下一帧（DOM 完成布局后）
    const raf = requestAnimationFrame(update)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', update)
    }
  }, [])

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [text, autoScroll])

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <Radio.Group
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          size="small"
        >
          <Radio.Button value="tuning">tuning.log（结构化）</Radio.Button>
          <Radio.Button value="stdout">subprocess.stdout</Radio.Button>
          <Radio.Button value="all">合并</Radio.Button>
        </Radio.Group>

        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Switch
            size="small"
            checked={autoRefresh}
            disabled={isTerminal}
            onChange={onAutoRefreshChange}
          />
          <Typography.Text style={{ fontSize: 12 }}>
            自动刷新 (2s){isTerminal && '（终态停止）'}
          </Typography.Text>
        </span>

        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
          <Typography.Text style={{ fontSize: 12 }}>自动滚动到底</Typography.Text>
        </span>

        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {dataUpdatedAt
              ? `更新于 ${dayjs(dataUpdatedAt).format('HH:mm:ss')}`
              : '—'}
            {' · '}
            {(text.length / 1024).toFixed(1)} KB
          </Typography.Text>
          <Button
            icon={<ReloadOutlined />}
            size="small"
            loading={isFetching}
            onClick={() => refetch()}
          >
            刷新
          </Button>
        </span>
      </div>

      <pre
        ref={preRef}
        style={{
          fontSize: 11,
          fontFamily: "'SF Mono', 'Consolas', monospace",
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          background: '#1f2937',
          color: '#e5e7eb',
          padding: 16,
          borderRadius: 6,
          height: logHeight,
          overflow: 'auto',
          margin: 0,
        }}
      >
        {text || '（日志为空，等 subprocess 启动）'}
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// V3.4 跨期验证 Modal：让用户选 trial / seed / 是否额外跑 multi-seed reproduce
// ---------------------------------------------------------------------------

const DEFAULT_REPRODUCE_SEEDS = '42,123,2025'

const WalkForwardModal: React.FC<{
  open: boolean
  onClose: () => void
  selectedTrials: number[]
  loading: boolean
  onSubmit: (values: {
    trial_numbers: number[]
    seed: number
    reproduce_seeds: number[] | null
  }) => void
}> = ({ open, onClose, selectedTrials, loading, onSubmit }) => {
  const [seed, setSeed] = useState(42)
  const [withReproduce, setWithReproduce] = useState(false)
  const [reproduceSeedsStr, setReproduceSeedsStr] = useState(DEFAULT_REPRODUCE_SEEDS)

  // 估算时间：单 trial 跨 5 期约 15 min；reproduce 单 (trial,seed) 约 3 min
  const wfMin = selectedTrials.length * 15
  const repSeeds = withReproduce
    ? reproduceSeedsStr
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n))
    : []
  const repMin = withReproduce ? selectedTrials.length * repSeeds.length * 3 : 0

  return (
    <Modal
      title="跨期验证选中 trials"
      open={open}
      onCancel={onClose}
      onOk={() => {
        if (selectedTrials.length === 0) return
        onSubmit({
          trial_numbers: selectedTrials,
          seed,
          reproduce_seeds: withReproduce && repSeeds.length > 0 ? repSeeds : null,
        })
      }}
      okText="启动验证"
      cancelText="取消"
      confirmLoading={loading}
      width={620}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={`将对 ${selectedTrials.length} 个 trial 跑跨期 walk-forward${
          withReproduce ? ' + multi-seed reproduce' : ''
        }`}
        description={
          <div style={{ fontSize: 12 }}>
            <div>
              <Text code>walk-forward</Text>：每 trial 跑 5 期（CUSTOM_SEGMENTS）一次完整训练，
              输出 stability_score 跨期排名表
            </div>
            <div>
              <Text code>multi-seed reproduce</Text>：用同一参数换不同 random seed 重跑，
              检测调参得到的"最优"是不是 seed 运气
            </div>
          </div>
        }
      />
      <Form layout="vertical">
        <Form.Item
          label={
            <span>
              选中的 trial_numbers（{selectedTrials.length}）
            </span>
          }
        >
          <div style={{ background: '#fafafa', padding: 8, borderRadius: 4 }}>
            {selectedTrials.length > 0 ? (
              <Space wrap size={4}>
                {selectedTrials.map((n) => (
                  <Tag key={n} color="blue">
                    #{n}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Text type="secondary">未选择 trial（请先在 Trials Tab 勾选）</Text>
            )}
          </div>
        </Form.Item>
        <Form.Item label="walk-forward seed">
          <InputNumber
            value={seed}
            onChange={(v) => setSeed(v ?? 42)}
            min={0}
            style={{ width: 160 }}
          />
        </Form.Item>
        <Form.Item label="同时跑 multi-seed reproduce">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Switch
              checked={withReproduce}
              onChange={setWithReproduce}
              checkedChildren="是"
              unCheckedChildren="否"
            />
            {withReproduce && (
              <Input
                value={reproduceSeedsStr}
                onChange={(e) => setReproduceSeedsStr(e.target.value)}
                placeholder="逗号分隔，如 42,123,2025"
                style={{ width: '100%' }}
              />
            )}
          </Space>
        </Form.Item>
        <Alert
          type="warning"
          message={`预计耗时：walk-forward ≈ ${wfMin} min${
            withReproduce ? ` + reproduce ≈ ${repMin} min = 共 ${wfMin + repMin} min` : ''
          }`}
          showIcon
          style={{ fontSize: 12 }}
        />
      </Form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// V3.4 跨期验证结果面板：stability 表 + 5 期序列 + multi-seed 聚合表
// ---------------------------------------------------------------------------

const WalkForwardPanel: React.FC<{
  jobId: number
  results: WalkForwardResults | undefined
  onRefresh: () => void
  onFinalize: (trialNumber: number) => void
}> = ({ jobId, results, onRefresh, onFinalize }) => {
  const wfRows = results?.walk_forward ?? []
  const repAgg = results?.reproduce_aggregate ?? []
  const running = results?.running ?? false

  // 按 stability_score 降序
  const wfSorted = [...wfRows].sort(
    (a, b) => (b.stability_score ?? -999) - (a.stability_score ?? -999),
  )

  const wfColumns: ColumnsType<WalkForwardRow> = [
    {
      title: '排名',
      key: 'rank',
      width: 60,
      render: (_, __, idx) =>
        idx === 0 ? <Tag color="gold">#1 最稳</Tag> : <Text>#{idx + 1}</Text>,
    },
    { title: 'trial_id', dataIndex: 'trial_id', key: 'trial_id', width: 80 },
    {
      title: 'stability_score',
      dataIndex: 'stability_score',
      key: 'stability_score',
      width: 130,
      sorter: (a, b) => (a.stability_score ?? -999) - (b.stability_score ?? -999),
      render: (v: number | null | undefined) =>
        v != null ? (
          <Text
            strong
            style={{
              fontFamily: "'SF Mono', monospace",
              color: v >= 0.5 ? '#52c41a' : v >= 0.3 ? '#faad14' : '#ff4d4f',
            }}
          >
            {v.toFixed(4)}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'valid_sharpe per period',
      dataIndex: 'valid_sharpe_per_period',
      key: 'valid_sharpe_per_period',
      render: (arr: number[] | null | undefined) =>
        arr ? (
          <Text style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
            {arr.map((v) => v.toFixed(2)).join(' / ')}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'valid mean / min',
      key: 'valid_stat',
      width: 130,
      render: (_, r) => (
        <Text style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
          {r.valid_sharpe_mean != null ? r.valid_sharpe_mean.toFixed(3) : '—'} /{' '}
          <span style={{ color: (r.valid_sharpe_min ?? 0) >= 0.2 ? '#52c41a' : '#ff4d4f' }}>
            {r.valid_sharpe_min != null ? r.valid_sharpe_min.toFixed(3) : '—'}
          </span>
        </Text>
      ),
    },
    {
      title: 'test mean',
      dataIndex: 'test_sharpe_mean',
      key: 'test_sharpe_mean',
      width: 90,
      render: (v: number | null | undefined) =>
        v != null ? (
          <Text style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
            {v.toFixed(3)}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'all_pos',
      dataIndex: 'all_positive',
      key: 'all_positive',
      width: 80,
      render: (v) =>
        v ? <Tag color="success">5/5</Tag> : <Tag color="default">否</Tag>,
    },
    {
      title: 'overfit_max',
      dataIndex: 'overfit_ratio_max',
      key: 'overfit_ratio_max',
      width: 100,
      render: (v: number | null | undefined) =>
        v != null ? (
          <Text
            style={{
              fontFamily: "'SF Mono', monospace",
              color: v > 5 ? '#ff4d4f' : '#faad14',
            }}
          >
            {v.toFixed(2)}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_, r) => (
        <Button
          type="link"
          size="small"
          icon={<SaveOutlined />}
          disabled={r.subprocess_returncode !== 0}
          onClick={() => onFinalize(r.trial_id)}
        >
          Finalize
        </Button>
      ),
    },
  ]

  // multi-seed reproduce aggregate columns
  const repColumns: ColumnsType<ReproduceAggregate> = [
    { title: 'trial_id', dataIndex: 'trial_id', key: 'trial_id', width: 80 },
    {
      title: 'n_seeds',
      dataIndex: 'n_seeds',
      key: 'n_seeds',
      width: 80,
    },
    {
      title: 'test_sharpe mean',
      key: 'ts_mean',
      width: 130,
      render: (_, r) =>
        r.test_sharpe.mean != null ? (
          <Text style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
            {r.test_sharpe.mean.toFixed(4)}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'test_sharpe std',
      key: 'ts_std',
      width: 130,
      render: (_, r) =>
        r.test_sharpe.std != null ? (
          <Text
            style={{
              fontFamily: "'SF Mono', monospace",
              fontSize: 11,
              color: r.test_sharpe.std > 0.4 ? '#ff4d4f' : '#52c41a',
            }}
          >
            {r.test_sharpe.std.toFixed(4)}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'test_sharpe min / max',
      key: 'ts_range',
      width: 160,
      render: (_, r) => (
        <Text style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
          {r.test_sharpe.min != null ? r.test_sharpe.min.toFixed(3) : '—'} /{' '}
          {r.test_sharpe.max != null ? r.test_sharpe.max.toFixed(3) : '—'}
        </Text>
      ),
    },
    {
      title: 'overfit_ratio mean',
      key: 'or_mean',
      width: 130,
      render: (_, r) =>
        r.overfit_ratio.mean != null ? (
          <Text style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
            {r.overfit_ratio.mean.toFixed(2)}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'hard_pass / n',
      key: 'hard_pass',
      width: 110,
      render: (_, r) => `${r.hard_pass_count} / ${r.n_seeds}`,
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        {running ? (
          <Tag color="processing" icon={<PlayCircleOutlined />}>
            子进程运行中（job {jobId}）— 看 walk_forward.stdout.log
          </Tag>
        ) : wfRows.length > 0 ? (
          <Tag color="success">已完成（{wfRows.length} trial）</Tag>
        ) : (
          <Tag color="default">未跑过跨期验证</Tag>
        )}
        <Button icon={<ReloadOutlined />} size="small" onClick={onRefresh}>
          刷新
        </Button>
        <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
          自动 10s 刷新一次
        </Text>
      </div>

      {wfRows.length === 0 && !running && (
        <Empty description="还没有跨期验证结果。在 Trials Tab 勾选 ≥1 个 trial → [跨期验证选中] 按钮启动" />
      )}

      {wfRows.length > 0 && (
        <Card
          size="small"
          title="Walk-forward 跨 5 期稳健性排名"
          style={{ marginBottom: 12 }}
        >
          <Table
            dataSource={wfSorted}
            columns={wfColumns}
            rowKey="trial_id"
            size="small"
            pagination={false}
            scroll={{ x: 1100 }}
          />
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
            stability_score = valid_sharpe_min × (1 - 变异系数/2) × (5 期均正？1.0 : 0.5)
          </Text>
        </Card>
      )}

      {repAgg.length > 0 && (
        <Card size="small" title="Multi-seed reproduce 稳定性聚合（每 trial × N seed）">
          <Table
            dataSource={repAgg}
            columns={repColumns}
            rowKey="trial_id"
            size="small"
            pagination={false}
            scroll={{ x: 900 }}
          />
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
            std 大说明该 trial 的"最优"高度依赖随机 seed（运气成分大）；std 小才是真正稳定的参数
          </Text>
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

export default WorkbenchMonitorPage
