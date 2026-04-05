import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Table, Tag, Button, Space, Typography, Card, Tabs, Timeline, Tooltip, Spin, Empty } from 'antd'
import { ArrowLeftOutlined, UnorderedListOutlined, FieldTimeOutlined } from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { experimentService } from '@/services/experimentService'
import { runService } from '@/services/runService'
import type { RunListItem } from '@/types'

const { Title, Text } = Typography

const STATUS_MAP: Record<string, { color: string; label: string }> = {
  FINISHED: { color: '#52c41a', label: '已完成' },
  FAILED: { color: '#ff4d4f', label: '失败' },
  RUNNING: { color: '#faad14', label: '运行中' },
  SCHEDULED: { color: '#1677ff', label: '已调度' },
  KILLED: { color: '#d9d9d9', label: '已终止' },
}

const ExperimentDetailPage: React.FC = () => {
  const { expId } = useParams<{ expId: string }>()
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)

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

  const experiment = expData?.data
  const runs = runsData?.data?.items || []
  const totalRuns = runsData?.data?.total || 0

  const columns = [
    {
      title: 'Run ID',
      dataIndex: 'run_id',
      key: 'run_id',
      render: (id: string) => (
        <Text code style={{ color: '#1677ff', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 12 }}>
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
      render: (name: string) => name || <Text type="secondary">-</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
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
      render: (t: number | null) => t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '结束时间',
      dataIndex: 'end_time',
      key: 'end_time',
      width: 170,
      render: (t: number | null) => t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, record: RunListItem) => (
        <Button
          type="link"
          size="small"
          style={{ color: '#1677ff', paddingLeft: 0 }}
          onClick={(e) => { e.stopPropagation(); navigate(`/report/${expId}/${record.run_id}`) }}
        >
          查看报告
        </Button>
      ),
    },
  ]

  if (!experiment) {
    return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />
  }

  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/experiments')}>
          返回
        </Button>
        <div style={{ flex: 1 }}>
          <Title level={3} style={{ color: '#1f2937', margin: 0 }}>{experiment.name}</Title>
          <Text type="secondary" style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 12 }}>
            ID: {experiment.experiment_id}
          </Text>
        </div>
        <Tag color="#1677ff" style={{ fontFamily: "'SF Mono', 'Consolas', monospace" }}>
          {experiment.run_count} 次运行
        </Tag>
      </div>

      <Tabs
        defaultActiveKey="all-runs"
        items={[
          {
            key: 'all-runs',
            label: (
              <span><UnorderedListOutlined /> 全部运行 ({totalRuns})</span>
            ),
            children: (
              <Table
                columns={columns}
                dataSource={runs}
                rowKey="run_id"
                loading={runsLoading}
                pagination={{
                  current: page,
                  pageSize,
                  total: totalRuns,
                  onChange: setPage,
                  showSizeChanger: false,
                  showTotal: (t) => `共 ${t} 条`,
                }}
                onRow={(record) => ({
                  onClick: () => navigate(`/report/${expId}/${record.run_id}`),
                  style: { cursor: 'pointer' },
                })}
                size="middle"
              />
            ),
          },
          {
            key: 'timeline',
            label: (
              <span><FieldTimeOutlined /> 时间线</span>
            ),
            children: (
              <Card>
                <Timeline
                  mode="left"
                  items={runs.slice(0, 30).map((run: RunListItem) => ({
                    color: STATUS_MAP[run.status]?.color || '#d9d9d9',
                    children: (
                      <div
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/report/${expId}/${run.run_id}`)}
                      >
                        <Text strong style={{ color: '#1f2937' }}>
                          {run.run_name || run.run_id.slice(0, 12)}
                        </Text>
                        <br />
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {run.start_time ? dayjs(run.start_time).format('YYYY-MM-DD') : '-'}
                        </Text>
                        <Tag color={STATUS_MAP[run.status]?.color} style={{ marginLeft: 8, fontSize: 10 }}>
                          {STATUS_MAP[run.status]?.label || run.status}
                        </Tag>
                      </div>
                    ),
                  }))}
                />
                {totalRuns > 30 && (
                  <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 16 }}>
                    仅显示最近 30 条记录，查看完整列表请切换到「全部运行」标签
                  </Text>
                )}
              </Card>
            ),
          },
        ]}
      />
    </div>
  )
}

export default ExperimentDetailPage
