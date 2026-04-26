import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  App,
  Button,
  Card,
  Empty,
  Popconfirm,
  Progress,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd'
import {
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import type { ColumnsType } from 'antd/es/table'

import { tuningService } from '@/services/tuningService'
import type { TuningJob, TuningJobStatus } from '@/types/tuning'

const { Title, Text } = Typography

const STATUS_CONFIG: Record<
  TuningJobStatus,
  { color: string; label: string }
> = {
  created: { color: 'default', label: '待启动' },
  running: { color: 'processing', label: '运行中' },
  searching: { color: 'processing', label: '搜索中' },
  finalizing: { color: 'orange', label: 'Finalize 中' },
  done: { color: 'success', label: '已完成' },
  cancelled: { color: 'default', label: '已取消' },
  failed: { color: 'error', label: '失败' },
  zombie: { color: 'warning', label: '僵尸（进程已死）' },
}

const SEARCH_MODE_LABEL: Record<string, string> = {
  single_segment: '单期搜索',
  walk_forward_5p: '跨期 5 期',
}

const WorkbenchHomePage: React.FC = () => {
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const queryClient = useQueryClient()

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['tuning-jobs'],
    queryFn: () => tuningService.list({ page: 1, page_size: 100 }),
    refetchInterval: 10_000,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => tuningService.delete(id),
    onSuccess: () => {
      message.success('已删除')
      queryClient.invalidateQueries({ queryKey: ['tuning-jobs'] })
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      message.error(err.response?.data?.detail ?? err.message)
    },
  })

  const cancelMutation = useMutation({
    mutationFn: (id: number) => tuningService.cancel(id),
    onSuccess: () => {
      message.success('已取消')
      queryClient.invalidateQueries({ queryKey: ['tuning-jobs'] })
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      message.error(err.response?.data?.detail ?? err.message)
    },
  })

  const items = data?.data?.items ?? []

  const stats = React.useMemo(() => {
    const byStatus: Record<string, number> = {}
    for (const j of items) {
      byStatus[j.status] = (byStatus[j.status] ?? 0) + 1
    }
    return {
      total: items.length,
      running: (byStatus.running ?? 0) + (byStatus.searching ?? 0),
      done: byStatus.done ?? 0,
      failed: (byStatus.failed ?? 0) + (byStatus.zombie ?? 0),
    }
  }, [items])

  const columns: ColumnsType<TuningJob> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 70,
      fixed: 'left',
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: TuningJob) => (
        <a onClick={() => navigate(`/workbench/jobs/${record.id}`)}>{name}</a>
      ),
    },
    {
      title: '搜索模式',
      dataIndex: 'search_mode',
      key: 'search_mode',
      width: 110,
      render: (mode: string) => SEARCH_MODE_LABEL[mode] ?? mode,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (status: TuningJobStatus) => {
        const cfg = STATUS_CONFIG[status] ?? { color: 'default', label: status }
        return <Tag color={cfg.color}>{cfg.label}</Tag>
      },
    },
    {
      title: '进度',
      key: 'progress',
      width: 200,
      render: (_, record: TuningJob) => {
        const pct =
          record.n_trials_target > 0
            ? Math.floor((record.n_trials_done / record.n_trials_target) * 100)
            : 0
        return (
          <div>
            <Progress percent={pct} size="small" />
            <Text type="secondary" style={{ fontSize: 11 }}>
              {record.n_trials_done}/{record.n_trials_target}
              {record.n_trials_failed > 0 && (
                <span style={{ color: '#ff4d4f', marginLeft: 8 }}>
                  失败 {record.n_trials_failed}
                </span>
              )}
            </Text>
          </div>
        )
      },
    },
    {
      title: 'Best valid_sharpe',
      dataIndex: 'best_objective_value',
      key: 'best',
      width: 140,
      render: (v: number | null, record: TuningJob) =>
        v != null ? (
          <span>
            <Text
              strong
              style={{
                fontFamily: "'SF Mono', monospace",
                color: v >= 0.5 ? '#52c41a' : '#faad14',
              }}
            >
              {v.toFixed(4)}
            </Text>
            <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
              #{record.best_trial_number}
            </Text>
          </span>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (ts: string) => dayjs(ts).format('MM-DD HH:mm:ss'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_, record: TuningJob) => (
        <Space size="small">
          <Button
            size="small"
            type="link"
            onClick={() => navigate(`/workbench/jobs/${record.id}`)}
          >
            查看
          </Button>
          {(record.status === 'running' || record.status === 'searching') && (
            <Popconfirm
              title="确定取消该 job 吗？"
              description="将 SIGTERM 子进程，已完成的 trial 数据保留"
              onConfirm={() => cancelMutation.mutate(record.id)}
              okText="确定"
              cancelText="取消"
            >
              <Button size="small" type="link" danger>
                取消
              </Button>
            </Popconfirm>
          )}
          {!(['running', 'searching', 'finalizing'] as TuningJobStatus[]).includes(
            record.status,
          ) && (
            <Popconfirm
              title="确定删除该 job 吗？"
              description="不可恢复"
              onConfirm={() => deleteMutation.mutate(record.id)}
              okText="确定"
              cancelText="取消"
            >
              <Button
                size="small"
                type="link"
                danger
                icon={<DeleteOutlined />}
              />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      {/* 顶部统计 + 操作 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
          <Statistic title="总数" value={stats.total} />
          <Statistic title="运行中" value={stats.running} valueStyle={{ color: '#1677ff' }} />
          <Statistic title="已完成" value={stats.done} valueStyle={{ color: '#52c41a' }} />
          <Statistic title="失败/僵尸" value={stats.failed} valueStyle={{ color: '#ff4d4f' }} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
            <Button
              icon={<ReloadOutlined />}
              loading={isFetching}
              onClick={() => refetch()}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => navigate('/workbench/new')}
            >
              新建调参 Job
            </Button>
          </div>
        </div>
      </Card>

      {/* 引导卡（无数据时） */}
      {!isLoading && items.length === 0 && (
        <Card style={{ marginBottom: 16 }}>
          <Empty
            image={<ThunderboltOutlined style={{ fontSize: 64, color: '#1677ff' }} />}
            description={
              <div>
                <Title level={5} style={{ marginBottom: 8 }}>
                  还没有调参 Job
                </Title>
                <Text type="secondary">
                  点击右上角"新建调参 Job"配置参数 → 启动 Optuna 自动搜索 → 看 trial 表 → 选最佳模型
                </Text>
              </div>
            }
          >
            <Button
              type="primary"
              size="large"
              icon={<PlusOutlined />}
              onClick={() => navigate('/workbench/new')}
            >
              立即创建
            </Button>
          </Empty>
        </Card>
      )}

      {/* 列表 */}
      {(isLoading || items.length > 0) && (
        <Card title="调参 Job 列表">
          <Spin spinning={isLoading}>
            <Table
              dataSource={items}
              columns={columns}
              rowKey="id"
              size="middle"
              scroll={{ x: 1100 }}
              pagination={{ pageSize: 20 }}
            />
          </Spin>
        </Card>
      )}
    </div>
  )
}

export default WorkbenchHomePage
