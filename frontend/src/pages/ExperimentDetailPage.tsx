import React, { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Tag, Button, Space, Typography, Tooltip, Spin,
  Modal, Input, Alert, message,
} from 'antd'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'
import ResponsiveDescriptions from '@/components/responsive/ResponsiveDescriptions'
import { useResponsiveModalProps } from '@/hooks/useResponsiveModalProps'
import {
  ArrowLeftOutlined,
  DeleteOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { experimentService } from '@/services/experimentService'
import { runService } from '@/services/runService'
import type { RunListItem, RunLinkSource, RunLinkType } from '@/types'
import PageContainer from '@/components/layout/PageContainer'

const { Title, Text } = Typography

const STATUS_MAP: Record<string, { color: string; label: string }> = {
  FINISHED: { color: '#52c41a', label: '已完成' },
  FAILED: { color: '#ff4d4f', label: '失败' },
  RUNNING: { color: '#faad14', label: '运行中' },
  SCHEDULED: { color: '#1677ff', label: '已调度' },
  KILLED: { color: '#d9d9d9', label: '已终止' },
}

// 4 个反向引用源 → 前端 Tag 颜色与中文标签
const LINK_TYPE_META: Record<RunLinkType, { color: string; label: string }> = {
  training_record: { color: '#52c41a', label: '训练记录' },
  tuning_trial: { color: '#722ed1', label: '调参' },
  deployment: { color: '#fa541c', label: '部署中' },
  ml_monitoring: { color: '#1677ff', label: '在线监控' },
}

const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1 }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`
}

const renderLinkedSources = (sources?: RunLinkSource[]) => {
  if (!sources || sources.length === 0) {
    return <Tag color="default">未关联</Tag>
  }
  // 按类型聚合（同一 run 同类型可能多个，例如多个调参 trial 共用同 run 的极端情况）
  const grouped = new Map<RunLinkType, RunLinkSource[]>()
  for (const s of sources) {
    const list = grouped.get(s.type) || []
    list.push(s)
    grouped.set(s.type, list)
  }
  return (
    <Space size={4} wrap>
      {Array.from(grouped.entries()).map(([type, list]) => {
        const meta = LINK_TYPE_META[type] || { color: '#8c8c8c', label: type }
        const tooltip = list.map((s, i) => {
          if (s.type === 'tuning_trial') {
            return `${s.name ?? ''} (trial #${s.trial_number ?? '-'})`
          }
          if (s.type === 'deployment') {
            return `${s.name ?? ''}${s.node_id ? ` @ ${s.node_id}` : ''}${s.strategy_name ? ` / ${s.strategy_name}` : ''}${s.active === false ? ' (已下线)' : ''}`
          }
          if (s.type === 'training_record') {
            return s.name ?? `record #${s.id ?? ''}`
          }
          if (s.type === 'ml_monitoring') {
            return `ML 监控 (${s.subtype ?? ''})`
          }
          return `${type} #${i}`
        }).filter(Boolean).join('\n')
        const text = list.length > 1 ? `${meta.label}×${list.length}` : meta.label
        return (
          <Tooltip key={type} title={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}>
            <Tag color={meta.color} style={{ fontSize: 11, marginRight: 0 }}>{text}</Tag>
          </Tooltip>
        )
      })}
    </Space>
  )
}

const ExperimentDetailPage: React.FC = () => {
  const { expId } = useParams<{ expId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)

  // 清理弹窗状态
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const { data: expData } = useQuery({
    queryKey: ['experiment', expId],
    queryFn: () => experimentService.get(expId!),
    enabled: !!expId,
  })

  const { data: runsData, isLoading: runsLoading } = useQuery({
    queryKey: ['runs', expId, page, pageSize],
    queryFn: () => runService.list(expId!, { page, page_size: pageSize }),
    enabled: !!expId,
  })

  // 弹窗打开时才拉未关联列表（避免页面默认就触发全实验扫描）
  const { data: unlinkedData, isLoading: unlinkedLoading, refetch: refetchUnlinked } = useQuery({
    queryKey: ['experiment-unlinked-runs', expId],
    queryFn: () => experimentService.getUnlinkedRuns(expId!),
    enabled: !!expId && cleanupOpen,
    staleTime: 0,
  })

  const cleanupMutation = useMutation({
    mutationFn: () => experimentService.cleanupRuns(expId!, { select: 'all_unlinked' }),
    onSuccess: (resp) => {
      const data = resp.data
      message.success(
        `已软删 ${data.deleted.length} 个 run，释放 ${formatBytes(data.freed_bytes)}` +
        (data.skipped.length ? `；跳过 ${data.skipped.length}（受保护）` : '') +
        (data.failed.length ? `；失败 ${data.failed.length}` : ''),
      )
      setCleanupOpen(false)
      setConfirmText('')
      // 刷新本实验的 run 列表 & summary
      queryClient.invalidateQueries({ queryKey: ['runs', expId] })
      queryClient.invalidateQueries({ queryKey: ['experiment', expId] })
      queryClient.invalidateQueries({ queryKey: ['experiment-unlinked-runs', expId] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      message.error(`清理失败：${msg}`)
    },
  })

  const experiment = expData?.data
  const runs = runsData?.data?.items || []
  const totalRuns = runsData?.data?.total || 0

  const unlinkedItems = unlinkedData?.data?.items ?? []
  const unlinkedCount = unlinkedData?.data?.total_count ?? 0
  const unlinkedSize = unlinkedData?.data?.total_size_bytes ?? 0
  const canConfirm = confirmText.trim() === 'DELETE'

  const columns = useMemo<ResponsiveColumn<RunListItem>[]>(() => [
    {
      title: 'Run ID',
      dataIndex: 'run_id',
      key: 'run_id',
      mobileRole: 'subtitle',
      render: (id: string) => (
        <Text code style={{ color: 'var(--ap-brand-primary)', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 12 }}>
          {id.slice(0, 12)}...
        </Text>
      ),
      width: 140,
    },
    {
      title: '名称',
      dataIndex: 'run_name',
      key: 'run_name',
      ellipsis: true,
      mobileRole: 'title',
      render: (name: string) => name || <Text type="secondary">-</Text>,
    },
    {
      title: '关联状态',
      dataIndex: 'linked_sources',
      key: 'linked_sources',
      width: 200,
      mobileRole: 'badge',
      render: (_: unknown, record: RunListItem) => renderLinkedSources(record.linked_sources),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      mobileRole: 'badge',
      render: (status: string) => {
        const cfg = STATUS_MAP[status] || { color: '#d9d9d9', label: status }
        return <Tag color={cfg.color} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11 }}>{cfg.label}</Tag>
      },
    },
    {
      title: '开始时间',
      dataIndex: 'start_time',
      key: 'start_time',
      width: 170,
      mobileRole: 'metric',
      render: (t: number | null) => t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '结束时间',
      dataIndex: 'end_time',
      key: 'end_time',
      width: 170,
      mobileRole: 'metric',
      render: (t: number | null) => t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      mobileRole: 'hidden',
      render: (_: unknown, record: RunListItem) => (
        <Button
          type="link"
          size="small"
          style={{ color: 'var(--ap-brand-primary)', paddingLeft: 0 }}
          onClick={(e) => { e.stopPropagation(); navigate(`/report/${expId}/${record.run_id}`) }}
        >
          查看报告
        </Button>
      ),
    },
  ], [expId, navigate])

  const responsiveModalProps = useResponsiveModalProps()

  if (!experiment) {
    return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />
  }

  return (
    <PageContainer
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/experiments')} size="small">
            返回
          </Button>
          {experiment.name}
        </span>
      }
      subtitle={
        <span style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 12 }}>
          ID: {experiment.experiment_id}
        </span>
      }
      tags={
        <Tag color="#1677ff" style={{ fontFamily: "'SF Mono', 'Consolas', monospace" }}>
          {experiment.run_count} 次运行
        </Tag>
      }
      actions={
        <Button
          danger
          icon={<DeleteOutlined />}
          onClick={() => { setCleanupOpen(true); setConfirmText('') }}
        >
          清理未关联记录
        </Button>
      }
    >
      {/* 唯一的 run 列表（之前 Tabs 的「时间线」与全部运行字段重复，已移除） */}
      <ResponsiveTable<RunListItem>
        columns={columns}
        dataSource={runs}
        rowKey="run_id"
        loading={runsLoading}
        scrollX={870}
        pagination={{
          current: page,
          pageSize,
          total: totalRuns,
          onChange: setPage,
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} 条`,
        }}
        onRowClick={(record) => navigate(`/report/${expId}/${record.run_id}`)}
        size="middle"
      />

      <Modal
        {...responsiveModalProps}
        title={
          <span>
            <ExclamationCircleOutlined style={{ color: '#fa8c16', marginRight: 8 }} />
            清理未关联 Run（软删到回收站）
          </span>
        }
        open={cleanupOpen}
        onCancel={() => { setCleanupOpen(false); setConfirmText('') }}
        width={responsiveModalProps.width ?? 780}
        footer={[
          <Button key="refresh" onClick={() => refetchUnlinked()} loading={unlinkedLoading}>
            刷新列表
          </Button>,
          <Button key="cancel" onClick={() => { setCleanupOpen(false); setConfirmText('') }}>
            取消
          </Button>,
          <Button
            key="confirm"
            type="primary"
            danger
            disabled={!canConfirm || unlinkedCount === 0}
            loading={cleanupMutation.isPending}
            onClick={() => cleanupMutation.mutate()}
          >
            确认软删 {unlinkedCount} 条
          </Button>,
        ]}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="保护范围"
          description={
            <span>
              已被 <b>训练记录 / 调参 trial / 实盘部署 / 在线监控</b> 任一引用的 run 不在删除范围内。
              下方列出的均为<b>无任何引用</b>的 run。
            </span>
          }
        />
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="软删行为"
          description={
            <span>
              run 目录会从 <Text code>mlruns/{expId}/&lt;run_id&gt;/</Text> 移到{' '}
              <Text code>mlruns/.trash/{expId}/&lt;run_id&gt;/</Text>。
              磁盘空间不会立即释放——确认无误后可手动 <Text code>rm -rf mlruns/.trash</Text>。
            </span>
          }
        />

        {unlinkedLoading ? (
          <Spin />
        ) : (
          <>
            <ResponsiveDescriptions
              size="small"
              style={{ marginBottom: 12 }}
              columns={{ xxl: 2, xl: 2, lg: 2, md: 2, sm: 2, xs: 1 }}
              items={[
                {
                  key: 'count',
                  label: '待删 run 数',
                  value: <Text strong>{unlinkedCount}</Text>,
                },
                {
                  key: 'size',
                  label: '预计释放',
                  value: <Text strong>{formatBytes(unlinkedSize)}</Text>,
                },
              ]}
            />

            <ResponsiveTable<any>
              size="small"
              dataSource={unlinkedItems}
              rowKey="run_id"
              pagination={{ pageSize: 10, showSizeChanger: false }}
              scrollX={530}
              columns={[
                {
                  title: 'Run ID',
                  dataIndex: 'run_id',
                  width: 130,
                  mobileRole: 'title',
                  render: (id: string) => (
                    <Text code style={{ fontSize: 11 }}>{id.slice(0, 12)}...</Text>
                  ),
                },
                {
                  title: '名称',
                  dataIndex: 'run_name',
                  ellipsis: true,
                  mobileRole: 'subtitle',
                  render: (n: string) => n || <Text type="secondary">-</Text>,
                },
                {
                  title: '开始时间',
                  dataIndex: 'start_time',
                  width: 160,
                  mobileRole: 'metric',
                  render: (t: number | null) => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-',
                },
                {
                  title: '大小',
                  dataIndex: 'size_bytes',
                  width: 90,
                  align: 'right' as const,
                  mobileRole: 'metric',
                  render: (b: number) => formatBytes(b),
                },
              ]}
            />

            <div style={{ marginTop: 12 }}>
              <Text>请输入 <Text code>DELETE</Text> 确认：</Text>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="输入 DELETE 启用确认按钮"
                style={{ marginTop: 6 }}
                disabled={unlinkedCount === 0}
              />
            </div>
          </>
        )}
      </Modal>
    </PageContainer>
  )
}

export default ExperimentDetailPage
