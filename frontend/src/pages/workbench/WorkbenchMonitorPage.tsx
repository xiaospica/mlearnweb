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
  Drawer,
  Empty,
  Popconfirm,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ArrowLeftOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import type { ColumnsType } from 'antd/es/table'

import { tuningService } from '@/services/tuningService'
import type {
  TuningJob,
  TuningJobStatus,
  TuningProgress,
  TuningTrial,
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

const trialColumns: ColumnsType<TuningTrial> = [
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

  const [logDrawerOpen, setLogDrawerOpen] = useState(false)
  const [progress, setProgress] = useState<TuningProgress | null>(null)
  const [sseError, setSseError] = useState<string | null>(null)

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
            <Button
              icon={<FileTextOutlined />}
              onClick={() => setLogDrawerOpen(true)}
            >
              日志
            </Button>
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
            {(['created', 'cancelled', 'failed', 'zombie', 'done'] as TuningJobStatus[]).includes(status) && (
              <Button
                type="primary"
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

      {/* Trials 表 */}
      <Card
        title={`Trials 表（按 valid_sharpe 降序，共 ${trials.length} 行）`}
        extra={
          <Button
            icon={<ReloadOutlined />}
            size="small"
            onClick={() => refetchTrials()}
          >
            刷新
          </Button>
        }
      >
        {trials.length === 0 ? (
          <Empty description="还没有 trial。等 subprocess 启动后会陆续出现。" />
        ) : (
          <Table
            dataSource={trials}
            columns={trialColumns}
            rowKey="trial_number"
            size="small"
            pagination={{ pageSize: 30 }}
            scroll={{ x: 1000 }}
            rowClassName={(record) =>
              record.trial_number === bestNum ? 'best-trial-row' : ''
            }
          />
        )}
      </Card>

      <style>{`
        .best-trial-row { background: #f6ffed !important; }
        .best-trial-row:hover td { background: #d9f7be !important; }
      `}</style>

      {/* 日志 Drawer */}
      <LogDrawer jobId={id} open={logDrawerOpen} onClose={() => setLogDrawerOpen(false)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 日志 Drawer
// ---------------------------------------------------------------------------

const LogDrawer: React.FC<{
  jobId: number
  open: boolean
  onClose: () => void
}> = ({ jobId, open, onClose }) => {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['tuning-logs', jobId],
    queryFn: () => tuningService.getLogs(jobId, 32768),
    refetchInterval: open ? 5_000 : false,
    enabled: open,
  })

  const text = data?.data?.text ?? ''

  return (
    <Drawer
      title="Subprocess 日志（最后 32KB）"
      placement="bottom"
      height={400}
      open={open}
      onClose={onClose}
      extra={
        <Button size="small" loading={isFetching} onClick={() => refetch()}>
          刷新
        </Button>
      }
    >
      <pre
        style={{
          fontSize: 11,
          fontFamily: "'SF Mono', 'Consolas', monospace",
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          background: '#1f2937',
          color: '#e5e7eb',
          padding: 16,
          borderRadius: 6,
          maxHeight: 'calc(100vh - 200px)',
          overflow: 'auto',
        }}
      >
        {text || '（日志为空）'}
      </pre>
    </Drawer>
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
