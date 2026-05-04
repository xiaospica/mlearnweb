import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Card,
  Empty,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  DownloadOutlined,
  ExportOutlined,
  DeleteOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { joinquantExportService } from '@/services/joinquantExportService'
import type { JoinquantExport } from '@/types/joinquantExport'

const { Text } = Typography

function fmtSize(bytes: number | null): string {
  if (bytes == null) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

interface Props {
  recordId: number
  /** 训练状态（用于禁用按钮：未完成的训练不允许导出）。 */
  recordStatus?: string
}

const JoinquantExportPanel: React.FC<Props> = ({ recordId, recordStatus }) => {
  const queryClient = useQueryClient()

  const listQuery = useQuery({
    queryKey: ['joinquant-exports', recordId],
    queryFn: () => joinquantExportService.list(recordId),
    enabled: !!recordId,
  })

  const generateMutation = useMutation({
    mutationFn: () => joinquantExportService.generate(recordId),
    onSuccess: (resp) => {
      if (resp.success) {
        message.success(`已生成: ${resp.data?.file_name ?? ''}`)
      } else {
        // 后端把 error_msg 也写 DB 行，列表会刷出来含 status='failed' 行
        message.error(`导出失败: ${resp.message || resp.data?.error_msg || '未知错误'}`)
      }
      queryClient.invalidateQueries({ queryKey: ['joinquant-exports', recordId] })
    },
    onError: (err: unknown) => {
      const m = err instanceof Error ? err.message : String(err)
      message.error(`触发导出失败: ${m}`)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (exportId: number) => joinquantExportService.remove(exportId),
    onSuccess: () => {
      message.success('已删除')
      queryClient.invalidateQueries({ queryKey: ['joinquant-exports', recordId] })
    },
    onError: (err: unknown) => {
      const m = err instanceof Error ? err.message : String(err)
      message.error(`删除失败: ${m}`)
    },
  })

  const exports: JoinquantExport[] = listQuery.data?.data ?? []
  const canExport = recordStatus === 'completed' || recordStatus === 'partial'

  const columns = [
    {
      title: '生成时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '文件名',
      dataIndex: 'file_name',
      key: 'file_name',
      ellipsis: true,
      render: (name: string | null, row: JoinquantExport) => {
        if (row.status === 'failed') {
          return <Tag color="red">失败</Tag>
        }
        return <Text code style={{ fontSize: 12 }}>{name ?? '-'}</Text>
      },
    },
    {
      title: '日期数',
      dataIndex: 'n_dates',
      key: 'n_dates',
      width: 80,
      align: 'right' as const,
      render: (v: number | null) => v ?? '-',
    },
    {
      title: 'Run 数',
      key: 'runs',
      width: 100,
      render: (_: unknown, row: JoinquantExport) => {
        const used = row.n_runs_used ?? 0
        const skipped = row.n_runs_skipped ?? 0
        const tooltip = row.mlflow_run_ids?.join(', ') ?? ''
        return (
          <Tooltip title={tooltip}>
            <span>
              {used}
              {skipped > 0 && <Text type="warning"> (-{skipped})</Text>}
            </span>
          </Tooltip>
        )
      },
    },
    {
      title: '大小',
      dataIndex: 'file_size',
      key: 'file_size',
      width: 90,
      align: 'right' as const,
      render: (v: number | null) => fmtSize(v),
    },
    {
      title: 'sha256',
      dataIndex: 'sha256',
      key: 'sha256',
      width: 100,
      render: (v: string | null) =>
        v ? (
          <Tooltip title={v}>
            <Text code style={{ fontSize: 11, color: 'var(--ap-text-muted)' }}>
              {v.slice(0, 8)}
            </Text>
          </Tooltip>
        ) : (
          '-'
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, row: JoinquantExport) => (
        <Space size={4}>
          {row.status === 'ok' && row.file_path && (
            <Button
              type="link"
              size="small"
              icon={<DownloadOutlined />}
              href={joinquantExportService.getDownloadUrl(row.id)}
              download
            >
              下载
            </Button>
          )}
          <Popconfirm
            title="删除该导出记录？"
            description="同时删除磁盘上的 JSON 文件"
            okText="确认"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => deleteMutation.mutate(row.id)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card size="small">
      <Space style={{ marginBottom: 12 }} wrap>
        <Tooltip title={canExport ? '' : '训练未完成或失败时不允许导出'}>
          <Button
            type="primary"
            icon={<ExportOutlined />}
            loading={generateMutation.isPending}
            disabled={!canExport}
            onClick={() => generateMutation.mutate()}
          >
            生成聚宽 JSON
          </Button>
        </Tooltip>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => listQuery.refetch()}
          loading={listQuery.isFetching && !listQuery.isLoading}
        >
          刷新
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          导出该训练的全部 run 持仓为聚宽（JoinQuant）兼容 JSON 格式，
          可上传到聚宽平台进行回测。
        </Text>
      </Space>

      {exports.length === 0 && !listQuery.isLoading ? (
        <Empty description="尚未生成任何 JSON。点击上方按钮触发。" style={{ padding: 24 }} />
      ) : (
        <>
          <Table<JoinquantExport>
            dataSource={exports}
            columns={columns}
            rowKey="id"
            loading={listQuery.isLoading}
            pagination={false}
            size="small"
            scroll={{ x: 760 }}
            expandable={{
              expandedRowRender: (row) =>
                row.status === 'failed' && row.error_msg ? (
                  <Alert
                    type="error"
                    showIcon
                    message="导出失败原因"
                    description={
                      <pre style={{ margin: 0, fontFamily: 'var(--ap-font-mono)', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                        {row.error_msg}
                      </pre>
                    }
                  />
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    路径：<Text code>{row.file_path ?? '-'}</Text>
                  </Text>
                ),
              rowExpandable: (row) => row.status === 'failed' || !!row.file_path,
            }}
          />
        </>
      )}
    </Card>
  )
}

export default JoinquantExportPanel
