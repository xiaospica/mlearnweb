import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { App, Card, Input, Row, Col, Typography, Tag, Space, Spin, Empty, Statistic, Badge, Button, Select, Tooltip, Alert, Table, Modal, Popconfirm, Segmented, Collapse, Dropdown, Menu, Pagination } from 'antd'
import { SearchOutlined, ExperimentOutlined, ClockCircleOutlined, CheckCircleOutlined, ReloadOutlined, ThunderboltOutlined, DatabaseOutlined, UnorderedListOutlined, AppstoreOutlined, DeleteOutlined, ExclamationCircleOutlined, FilterOutlined, FundOutlined, SyncOutlined, RocketOutlined, EditOutlined, FileTextOutlined, SaveOutlined, StarOutlined, StarFilled, FolderOutlined, FolderAddOutlined, FormOutlined, PlusOutlined, CheckSquareFilled, BorderOutlined, MoreOutlined, FolderOpenOutlined, BarChartOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import ReactECharts from 'echarts-for-react'
import { trainingService } from '@/services/trainingService'
import type { TrainingRecord } from '@/types'
import MemoPopover from '@/components/MemoPopover/MemoPopover'
import DeploymentBadges from '@/components/DeploymentBadges'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input
const { Panel } = Collapse

const CATEGORY_CONFIG: Record<string, { color: string; label: string; icon: string }> = {
  single: { color: '#1677ff', label: '单次训练', icon: '📊' },
  rolling: { color: '#722ed1', label: '滚动训练', icon: '🔄' },
}

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  running: { color: '#faad14', label: '运行中' },
  completed: { color: '#52c41a', label: '已完成' },
  partial: { color: '#fa8c16', label: '部分完成' },
  failed: { color: '#ff4d4f', label: '失败' },
}

const MiniReturnChart: React.FC<{ data?: { values: number[]; final_return: number } }> = ({ data }) => {
  if (!data || !data.values || data.values.length === 0) {
    return <Text type="secondary" style={{ fontSize: 11 }}>无收益数据</Text>
  }

  const { values, final_return } = data
  const isPositive = final_return >= 1

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
      <ReactECharts
        option={{
          grid: { left: 0, right: 0, top: 4, bottom: 4 },
          xAxis: { type: 'category', show: false, data: values.map((_, i) => i) },
          yAxis: { type: 'value', show: false, min: (value: { min: number; max: number }) => value.min * 0.98, max: (value: { min: number; max: number }) => value.max * 1.02 },
          series: [{
            type: 'line',
            data: values,
            showSymbol: false,
            smooth: true,
            lineStyle: { width: 1.5, color: isPositive ? '#52c41a' : '#ff4d4f' },
            areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: isPositive ? 'rgba(82,196,26,0.2)' : 'rgba(255,77,79,0.2)' }, { offset: 1, color: 'rgba(0,0,0,0)' }] } },
          }],
        }}
        style={{ width: '100%', height: 28, flex: 1 }}
      />
      <Text style={{ fontSize: 12, fontWeight: 600, color: isPositive ? '#52c41a' : '#ff4d4f', fontFamily: "'SF Mono', 'Consolas', monospace", whiteSpace: 'nowrap' }}>
        {((final_return - 1) * 100).toFixed(2)}%
      </Text>
    </div>
  )
}

const UsageGuide: React.FC = () => (
  <Card
    style={{
      background: '#f0f5ff',
      border: '1px solid #d6e4ff',
      borderRadius: 8,
    }}
    styles={{ body: { padding: '24px 28px' } }}
  >
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: '#e8f4fd',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <ThunderboltOutlined style={{ fontSize: 20, color: '#1677ff' }} />
      </div>
      <div style={{ flex: 1 }}>
        <Title level={5} style={{ color: '#1f2937', margin: '0 0 8px 0' }}>如何创建训练记录</Title>
        <Paragraph style={{ color: '#6b7280', margin: 0, fontSize: 13, lineHeight: 1.8 }}>
          执行训练脚本时传入 <Text code>--name</Text> 参数，训练完成后自动记录到 Dashboard：
        </Paragraph>

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', background: '#ffffff', borderRadius: 6,
            borderLeft: '3px solid #1677ff',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}>
            <ThunderboltOutlined style={{ color: '#faad14', fontSize: 14 }} />
            <Text style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 12, color: '#374151' }}>
              python tushare_hs300_rolling_train.py --name "CSI300滚动v2" --description "Alpha191因子"
            </Text>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', background: '#ffffff', borderRadius: 6,
            borderLeft: '3px solid #52c41a',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}>
            <DatabaseOutlined style={{ color: '#52c41a', fontSize: 14 }} />
            <Text style={{ fontSize: 12, color: '#6b7280' }}>
              训练完成后刷新此页面即可看到新的训练记录。
            </Text>
          </div>
        </div>

        <Row gutter={24} style={{ marginTop: 16 }}>
          <Col span={8}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                background: '#e8f4fd', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <ExperimentOutlined style={{ color: '#1677ff', fontSize: 18 }} />
              </div>
              <Text strong style={{ color: '#1f2937', fontSize: 12, display: 'block' }}>1. 指定名称</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>--name "训练名"</Text>
            </div>
          </Col>
          <Col span={8}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                background: '#f0fff0', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <UnorderedListOutlined style={{ color: '#52c41a', fontSize: 18 }} />
              </div>
              <Text strong style={{ color: '#1f2937', fontSize: 12, display: 'block' }}>2. 运行训练</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>等待训练完成</Text>
            </div>
          </Col>
          <Col span={8}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                background: '#fff7e6', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <CheckCircleOutlined style={{ color: '#fa8c16', fontSize: 18 }} />
              </div>
              <Text strong style={{ color: '#1f2937', fontSize: 12, display: 'block' }}>3. 查看结果</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>点击卡片查看详情</Text>
            </div>
          </Col>
        </Row>
      </div>
    </div>
  </Card>
)

const TrainingRecordsPage: React.FC = () => {
  const { message } = App.useApp()
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>(undefined)
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [editModalVisible, setEditModalVisible] = useState(false)
  const [editingRecord, setEditingRecord] = useState<TrainingRecord | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [createGroupModalVisible, setCreateGroupModalVisible] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [renameGroupModalVisible, setRenameGroupModalVisible] = useState(false)
  const [renameOldName, setRenameOldName] = useState('')
  const [renameNewName, setRenameNewName] = useState('')
  // 卡片模式分页：每个分组独立的当前页 + 全局 page size
  const [cardPageSize, setCardPageSize] = useState(12)
  const [cardPages, setCardPages] = useState<Record<string, number>>({})
  const getCardPage = (groupKey: string) => cardPages[groupKey] ?? 1
  const setCardPage = (groupKey: string, p: number) =>
    setCardPages((m) => ({ ...m, [groupKey]: p }))
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: recordsData, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['training-records', search, categoryFilter],
    queryFn: () => trainingService.list({ search, status: undefined, category: categoryFilter, page_size: 1000 }),
    retry: 1,
    refetchOnWindowFocus: true,
  })

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => trainingService.batchDelete(ids),
    onSuccess: (data) => {
      message.success(data.message || '删除成功')
      setSelectedIds([])
      queryClient.invalidateQueries({ queryKey: ['training-records'] })
    },
    onError: () => {
      message.error('删除失败')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => trainingService.update(id, data),
    onSuccess: () => {
      message.success('更新成功')
      setEditModalVisible(false)
      setEditingRecord(null)
      queryClient.invalidateQueries({ queryKey: ['training-records'] })
    },
    onError: () => {
      message.error('更新失败')
    },
  })

  const favoriteMutation = useMutation({
    mutationFn: ({ id, is_favorite }: { id: number; is_favorite: boolean }) => 
      trainingService.update(id, { is_favorite }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-records'] })
      queryClient.invalidateQueries({ queryKey: ['groups'] })
    },
    onError: () => {
      message.error('收藏操作失败')
    },
  })

  const { data: groupsData } = useQuery({
    queryKey: ['groups'],
    queryFn: () => trainingService.listGroups(),
    enabled: true,
  })

  const batchGroupMutation = useMutation({
    mutationFn: (params: { recordIds: number[]; groupName: string }) => 
      trainingService.batchUpdateGroup(params.recordIds, params.groupName),
    onSuccess: (data) => {
      message.success(data.message || '分组成功')
      setCreateGroupModalVisible(false)
      setNewGroupName('')
      setSelectedIds([])
      queryClient.invalidateQueries({ queryKey: ['training-records'] })
      queryClient.invalidateQueries({ queryKey: ['groups'] })
    },
    onError: () => {
      message.error('分组操作失败')
    },
  })

  const renameGroupMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      trainingService.renameGroup(oldName, newName),
    onSuccess: (data) => {
      message.success(data.message || '重命名成功')
      setRenameGroupModalVisible(false)
      queryClient.invalidateQueries({ queryKey: ['training-records'] })
      queryClient.invalidateQueries({ queryKey: ['groups'] })
    },
    onError: () => {
      message.error('重命名失败')
    },
  })

  const dissolveGroupMutation = useMutation({
    mutationFn: (groupName: string) => trainingService.dissolveGroup(groupName),
    onSuccess: (data) => {
      message.success(data.message || '解散成功')
      queryClient.invalidateQueries({ queryKey: ['training-records'] })
      queryClient.invalidateQueries({ queryKey: ['groups'] })
    },
    onError: () => {
      message.error('解散失败')
    },
  })

  const handleCreateGroup = () => {
    if (selectedIds.length === 0) {
      message.warning('请先选择要分组的记录')
      return
    }
    if (!newGroupName.trim()) {
      message.warning('请输入分组名称')
      return
    }
    const filteredIds = selectedIds.filter(id => {
      const record = records.find(r => r.id === id)
      return !record?.is_favorite
    })
    if (filteredIds.length === 0) {
      message.warning('收藏的记录不能移至其他分组，请取消收藏后再操作')
      return
    }
    batchGroupMutation.mutate({
      recordIds: filteredIds,
      groupName: newGroupName.trim(),
    })
  }

  const handleAddToGroup = (groupName: string) => {
    if (selectedIds.length === 0) {
      message.warning('请先选择要分组的记录')
      return
    }
    const filteredIds = selectedIds.filter(id => {
      const record = records.find(r => r.id === id)
      return !record?.is_favorite
    })
    if (filteredIds.length === 0) {
      message.warning('收藏的记录不能移至其他分组，请取消收藏后再操作')
      return
    }
    batchGroupMutation.mutate({
      recordIds: filteredIds,
      groupName: groupName,
    })
  }

  const handleOpenRenameGroup = (groupName: string) => {
    setRenameOldName(groupName)
    setRenameNewName(groupName)
    setRenameGroupModalVisible(true)
  }

  const handleSaveRenameGroup = () => {
    if (!renameNewName.trim() || renameNewName.trim() === renameOldName) {
      message.warning('请输入新的分组名称')
      return
    }
    renameGroupMutation.mutate({ oldName: renameOldName, newName: renameNewName.trim() })
  }

  const handleDissolveGroup = (groupName: string) => {
    Modal.confirm({
      title: '解散分组',
      icon: <ExclamationCircleOutlined />,
      content: `确定要解散"${groupName}"分组吗？所有记录将归回"普通"分组。`,
      okText: '确认解散',
      cancelText: '取消',
      okType: 'danger',
      onOk: () => dissolveGroupMutation.mutate(groupName),
    })
  }

  const handleToggleFavorite = (record: TrainingRecord, e: React.MouseEvent) => {
    e.stopPropagation()
    favoriteMutation.mutate({ id: record.id, is_favorite: !record.is_favorite })
  }

  const handleOpenEditModal = (record: TrainingRecord, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingRecord(record)
    setEditName(record.name)
    setEditDescription(record.description || '')
    setEditModalVisible(true)
  }

  const handleSaveEdit = () => {
    if (!editingRecord) return
    if (!editName.trim()) {
      message.warning('名称不能为空')
      return
    }
    updateMutation.mutate({
      id: editingRecord.id,
      data: { name: editName.trim(), description: editDescription.trim() || null },
    })
  }

  const records = recordsData?.data?.items || []
  const total = recordsData?.data?.total || 0
  const favoriteRecords = records.filter(r => r.is_favorite)
  const normalRecords = records.filter(r => r.group_name === 'default')
  const singleCount = records.filter(r => (r.run_count || 0) <= 1).length
  const rollingCount = records.filter(r => (r.run_count || 0) > 1).length
  const completedCount = records.filter(r => r.status === 'completed').length

  const handleSelectAll = () => {
    if (selectedIds.length === records.length) {
      setSelectedIds([])
    } else {
      setSelectedIds(records.map((r: TrainingRecord) => r.id))
    }
  }

  const handleSelect = (id: number, checked: boolean) => {
    if (checked) {
      setSelectedIds([...selectedIds, id])
    } else {
      setSelectedIds(selectedIds.filter(i => i !== id))
    }
  }

  const handleDelete = () => {
    if (selectedIds.length === 0) {
      message.warning('请先选择要删除的记录')
      return
    }
    const selectedRecords = records.filter(r => selectedIds.includes(r.id))
    const favoriteSelected = selectedRecords.filter(r => r.is_favorite)
    if (favoriteSelected.length > 0) {
      message.warning(`选中的记录中有 ${favoriteSelected.length} 条已收藏，请先取消收藏后再删除`)
      return
    }
    Modal.confirm({
      title: '确认删除',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除选中的 ${selectedIds.length} 条记录吗？此操作不可恢复，但不会影响本地 mlruns 中的文件。`,
      okText: '确认删除',
      cancelText: '取消',
      okType: 'danger',
      onOk: () => {
        deleteMutation.mutate(selectedIds)
      },
    })
  }

  const listColumns = [
    {
      title: (
        <div
          onClick={handleSelectAll}
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            border: selectedIds.length === records.length && records.length > 0 ? 'none' : '2px solid #d1d5db',
            background: selectedIds.length === records.length && records.length > 0 ? '#1677ff' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
        >
          {selectedIds.length === records.length && records.length > 0 && (
            <CheckCircleOutlined style={{ color: '#ffffff', fontSize: 12 }} />
          )}
        </div>
      ),
      dataIndex: 'select',
      key: 'select',
      width: 60,
      render: (_: unknown, record: TrainingRecord) => (
        <div
          onClick={(e) => {
            e.stopPropagation()
            handleSelect(record.id, !selectedIds.includes(record.id))
          }}
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            border: selectedIds.includes(record.id) ? 'none' : '2px solid #d1d5db',
            background: selectedIds.includes(record.id) ? '#1677ff' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
        >
          {selectedIds.includes(record.id) && (
            <CheckCircleOutlined style={{ color: '#ffffff', fontSize: 12 }} />
          )}
        </div>
      ),
    },
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 60,
      render: (id: number) => (
        <Text type="secondary" style={{ fontSize: 12, fontFamily: "'SF Mono', 'Consolas', monospace" }}>
          #{id}
        </Text>
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 280,
      render: (name: string, record: TrainingRecord) => (
        <Space size={4}>
          {record.is_favorite && <StarFilled style={{ color: '#faad14', fontSize: 12 }} />}
          <a onClick={() => navigate(`/training/${record.id}`)} style={{ color: '#1677ff', fontWeight: 500, fontSize: 13 }}>
            {name}
          </a>
          {!record.is_favorite && (
            <Tooltip title="收藏">
              <StarOutlined
                style={{ color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}
                onClick={(e) => handleToggleFavorite(record, e)}
              />
            </Tooltip>
          )}
          {record.is_favorite && (
            <Tooltip title="取消收藏">
              <StarFilled
                style={{ color: '#faad14', fontSize: 12, cursor: 'pointer' }}
                onClick={(e) => handleToggleFavorite(record, e)}
              />
            </Tooltip>
          )}
          <Tooltip title="编辑名称和描述">
            <EditOutlined
              style={{ color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}
              onClick={(e) => handleOpenEditModal(record, e)}
            />
          </Tooltip>
          {record.memo && (
            <MemoPopover memo={record.memo}>
              <FileTextOutlined
                style={{ color: '#1677ff', fontSize: 12, cursor: 'pointer' }}
                onClick={(e) => e.stopPropagation()}
              />
            </MemoPopover>
          )}
        </Space>
      ),
    },
    {
      title: '类型',
      dataIndex: 'category',
      key: 'category',
      width: 110,
      render: (_: string, record: TrainingRecord) => {
        const actualCategory = (record.run_count || 0) > 1 ? 'rolling' : 'single'
        const cfg = CATEGORY_CONFIG[actualCategory] || CATEGORY_CONFIG.single
        return <Tag color={cfg.color} style={{ fontSize: 11 }}>{cfg.label}</Tag>
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => {
        const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.completed
        return <Tag color={cfg.color} style={{ fontSize: 11 }}>{cfg.label}</Tag>
      },
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (desc: string) => <Text type="secondary" style={{ fontSize: 12 }}>{desc || '-'}</Text>,
    },
    {
      title: '累计收益',
      dataIndex: 'cumulative_return_preview',
      key: 'cumulative_return',
      width: 180,
      render: (_: unknown, record: TrainingRecord) => (
        <MiniReturnChart data={record.cumulative_return_preview} />
      ),
    },
    {
      title: '运行数',
      dataIndex: 'run_count',
      key: 'run_count',
      width: 90,
      align: 'center' as const,
      render: (runCount: number, record: TrainingRecord) => (
        <Badge
          count={runCount || record.run_ids?.length || 0}
          overflowCount={9999}
          style={{
            background: '#1677ff',
            fontFamily: "'SF Mono', 'Consolas', monospace",
            fontSize: 11,
          }}
        />
      ),
    },
    {
      title: '部署',
      dataIndex: 'deployments',
      key: 'deployments',
      width: 220,
      render: (_: unknown, record: TrainingRecord) => (
        <DeploymentBadges deployments={record.deployments} maxVisible={2} />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (time: string) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          <ClockCircleOutlined style={{ marginRight: 4 }} />
          {time ? dayjs(time).format('YYYY-MM-DD HH:mm') : '-'}
        </Text>
      ),
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <Title level={3} style={{ color: '#1f2937', margin: 0, marginBottom: 6 }}>
            训练记录
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            管理所有训练会话 {total > 0 && `· 共 ${total} 条记录`}
          </Text>
        </div>
        <Space size="small">
          <Select
            placeholder="筛选类型"
            allowClear
            value={categoryFilter}
            onChange={setCategoryFilter}
            options={[
              { value: 'single', label: '单次训练' },
              { value: 'rolling', label: '滚动训练' },
            ]}
            style={{ width: 140 }}
            size="small"
            suffixIcon={<FilterOutlined style={{ color: '#9ca3af' }} />}
          />
          <Input
            placeholder="搜索训练名称..."
            prefix={<SearchOutlined style={{ color: '#9ca3af' }} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            style={{ width: 280 }}
            size="small"
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => refetch()}
            size="small"
          >
            刷新
          </Button>
          <Segmented
            value={viewMode}
            onChange={(value) => setViewMode(value as 'card' | 'list')}
            options={[
              { value: 'card', icon: <AppstoreOutlined />, label: '卡片' },
              { value: 'list', icon: <UnorderedListOutlined />, label: '列表' },
            ]}
            size="small"
          />
          {selectedIds.length > 0 && (
            <>
              <Tooltip title={selectedIds.length < 2 ? '至少选择 2 条' : selectedIds.length > 3 ? '最多对比 3 条' : ''}>
                <Button
                  icon={<BarChartOutlined />}
                  onClick={() => navigate(`/training/compare?ids=${selectedIds.join(',')}`)}
                  size="small"
                  type="primary"
                  disabled={selectedIds.length < 2 || selectedIds.length > 3}
                >
                  对比 ({selectedIds.length}/3)
                </Button>
              </Tooltip>
              <Button
                icon={<FolderAddOutlined />}
                onClick={() => setCreateGroupModalVisible(true)}
                size="small"
                type="default"
              >
                创建分组 ({selectedIds.length})
              </Button>
              <Dropdown
                menu={{
                  items: [
                    { key: 'default', label: '普通分组', icon: <FolderOutlined /> },
                    ...(groupsData?.data || [])
                      .filter((g: any) => !g.is_system && g.name !== '普通' && g.name !== '收藏')
                      .map((g: any) => ({
                        key: g.name,
                        label: g.name,
                        icon: <FolderOutlined />,
                      })),
                  ],
                  onClick: (e) => handleAddToGroup(e.key),
                }}
                trigger={['click']}
              >
                <Button
                  icon={<FolderOpenOutlined />}
                  size="small"
                  type="default"
                >
                  添加到分组 ({selectedIds.length})
                </Button>
              </Dropdown>
              <Popconfirm
                title="确认删除"
                description={`确定要删除选中的 ${selectedIds.length} 条记录吗？此操作不可恢复，但不会影响本地 mlruns 中的文件。`}
                onConfirm={handleDelete}
                okText="确认删除"
                cancelText="取消"
                okType="danger"
              >
                <Button danger icon={<DeleteOutlined />} size="small">
                  删除 ({selectedIds.length})
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
      </div>

      {isError ? (
        <Alert
          type="error"
          message="无法连接到后端服务"
          description={
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                请确保后端服务已启动:
              </Text>
              <div style={{
                marginTop: 8, padding: '8px 12px', background: '#fafafa', borderRadius: 6,
                fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11, color: '#6b7280',
              }}>
                cd mlearnweb/backend && python -m uvicorn app.main:app --port 8000
              </div>
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  错误详情: {(error as Error)?.message || '未知错误'}
                </Text>
              </div>
            </div>
          }
          showIcon
          style={{ marginBottom: 24 }}
          action={
            <Button size="small" danger onClick={() => refetch()}>重试</Button>
          }
        />
      ) : null}

      {!isError && records.length > 0 && (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
            <Col span={6}>
              <Card
                size="small"
                styles={{ body: { padding: '14px 16px' } }}
                style={{
                  background: '#ffffff',
                  borderLeft: '3px solid #1677ff',
                  borderRadius: 8,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <Statistic
                  title={<span style={{ color: '#6b7280', fontSize: 11 }}>总训练数</span>}
                  value={total}
                  valueStyle={{ color: '#1677ff', fontFamily: "'SF Mono', 'Consolas', monospace", fontWeight: 700, fontSize: 22 }}
                  prefix={<UnorderedListOutlined style={{ color: '#1677ff' }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card
                size="small"
                styles={{ body: { padding: '14px 16px' } }}
                style={{
                  background: '#ffffff',
                  borderLeft: '3px solid #52c41a',
                  borderRadius: 8,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <Statistic
                  title={<span style={{ color: '#6b7280', fontSize: 11 }}>单次训练</span>}
                  value={singleCount}
                  valueStyle={{ color: '#52c41a', fontFamily: "'SF Mono', 'Consolas', monospace", fontWeight: 700, fontSize: 22 }}
                  prefix={<RocketOutlined style={{ color: '#52c41a' }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card
                size="small"
                styles={{ body: { padding: '14px 16px' } }}
                style={{
                  background: '#ffffff',
                  borderLeft: '3px solid #722ed1',
                  borderRadius: 8,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <Statistic
                  title={<span style={{ color: '#6b7280', fontSize: 11 }}>滚动训练</span>}
                  value={rollingCount}
                  valueStyle={{ color: '#722ed1', fontFamily: "'SF Mono', 'Consolas', monospace", fontWeight: 700, fontSize: 22 }}
                  prefix={<SyncOutlined style={{ color: '#722ed1' }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card
                size="small"
                styles={{ body: { padding: '14px 16px' } }}
                style={{
                  background: '#ffffff',
                  borderLeft: '3px solid #fa8c16',
                  borderRadius: 8,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <Statistic
                  title={<span style={{ color: '#6b7280', fontSize: 11 }}>已完成</span>}
                  value={completedCount}
                  valueStyle={{ color: '#fa8c16', fontFamily: "'SF Mono', 'Consolas', monospace", fontWeight: 700, fontSize: 22 }}
                  prefix={<CheckCircleOutlined style={{ color: '#fa8c16' }} />}
                />
              </Card>
            </Col>
          </Row>
        </>
      )}

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : isError ? null : records.length === 0 ? (
        <UsageGuide />
      ) : viewMode === 'list' ? (
        <Collapse
          defaultActiveKey={['favorite', 'normal']}
          bordered={false}
          style={{ background: 'transparent' }}
        >
          {favoriteRecords.length > 0 && (
            <Panel
              header={
                <Space>
                  <StarFilled style={{ color: '#faad14' }} />
                  <span style={{ fontWeight: 600 }}>收藏</span>
                  <Tag color="#faad14" style={{ marginLeft: 8 }}>{favoriteRecords.length}</Tag>
                </Space>
              }
              key="favorite"
              style={{ marginBottom: 16, background: '#fffbe6', borderRadius: 8, border: '1px solid #ffe58f' }}
            >
              <Table
                dataSource={favoriteRecords}
                columns={listColumns}
                rowKey="id"
                pagination={{
                  defaultPageSize: 20,
                  showSizeChanger: true,
                  pageSizeOptions: ['10', '20', '50', '100', '200'],
                  showTotal: (total) => `共 ${total} 条`,
                  size: 'small',
                }}
                size="middle"
                onRow={(record) => ({
                  onClick: () => navigate(`/training/${record.id}`),
                  style: { cursor: 'pointer', transition: 'all 0.2s' },
                })}
              />
            </Panel>
          )}
          {(groupsData?.data || [])
            .filter((g: any) => !g.is_system && g.name !== '普通' && g.name !== '收藏')
            .map((group: any) => {
              const groupRecords = records.filter(r => r.group_name === group.name)
              return (
                <Panel
                  key={group.name}
                  header={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <FolderOutlined style={{ color: '#722ed1' }} />
                      <span style={{ fontWeight: 600 }}>{group.name}</span>
                      <Tag color="#722ed1">{group.count}</Tag>
                      <Button
                        type="text"
                        size="small"
                        icon={<FormOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleOpenRenameGroup(group.name) }}
                        style={{ color: '#1677ff', fontSize: 11 }}
                      >
                        重命名
                      </Button>
                      <Popconfirm
                        title={`解散"${group.name}"`}
                        description="所有记录将归回普通分组"
                        onConfirm={() => handleDissolveGroup(group.name)}
                        okText="确认解散"
                        cancelText="取消"
                        okType="danger"
                      >
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontSize: 11 }}
                        >
                          解散
                        </Button>
                      </Popconfirm>
                    </div>
                  }
                  style={{ marginBottom: 16, background: '#f9f0ff', borderRadius: 8, border: '1px solid #d3adf7' }}
                >
                  {groupRecords.length === 0 ? (
                    <Empty description="暂无记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    <Table
                      dataSource={groupRecords}
                      columns={listColumns}
                      rowKey="id"
                      pagination={{
                        defaultPageSize: 20,
                        showSizeChanger: true,
                        pageSizeOptions: ['10', '20', '50', '100', '200'],
                        showTotal: (total) => `共 ${total} 条`,
                        size: 'small',
                      }}
                      size="middle"
                      onRow={(record) => ({
                        onClick: () => navigate(`/training/${record.id}`),
                        style: { cursor: 'pointer', transition: 'all 0.2s' },
                      })}
                    />
                  )}
                </Panel>
              )
            })
          }
          <Panel
            header={
              <Space>
                <FolderOutlined />
                <span style={{ fontWeight: 600 }}>普通</span>
                <Tag color="#1677ff" style={{ marginLeft: 8 }}>{normalRecords.length}</Tag>
              </Space>
            }
            key="normal"
            style={{ marginBottom: 16, background: '#fff', borderRadius: 8, border: '1px solid #e8e8e8' }}
          >
            {normalRecords.length === 0 ? (
              <Empty description="暂无记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Table
                dataSource={normalRecords}
                columns={listColumns}
                rowKey="id"
                pagination={{
                  defaultPageSize: 20,
                  showSizeChanger: true,
                  pageSizeOptions: ['10', '20', '50', '100', '200'],
                  showTotal: (total) => `共 ${total} 条`,
                  size: 'small',
                }}
                size="middle"
                onRow={(record) => ({
                  onClick: () => navigate(`/training/${record.id}`),
                  style: { cursor: 'pointer', transition: 'all 0.2s' },
                })}
              />
            )}
          </Panel>
        </Collapse>
      ) : (
        <Collapse
          defaultActiveKey={['favorite', 'normal']}
          bordered={false}
          style={{ background: 'transparent' }}
        >
          {favoriteRecords.length > 0 && (
            <Panel
              header={
                <Space>
                  <StarFilled style={{ color: '#faad14' }} />
                  <span style={{ fontWeight: 600 }}>收藏</span>
                  <Tag color="#faad14" style={{ marginLeft: 8 }}>{favoriteRecords.length}</Tag>
                </Space>
              }
              key="favorite"
              style={{ marginBottom: 16, background: '#fffbe6', borderRadius: 8, border: '1px solid #ffe58f' }}
            >
              <Row gutter={[20, 20]}>
                {favoriteRecords
                  .slice((getCardPage('favorite') - 1) * cardPageSize, getCardPage('favorite') * cardPageSize)
                  .map((record: TrainingRecord) => {
                  const actualCategory = (record.run_count || 0) > 1 ? 'rolling' : 'single'
                  const catCfg = CATEGORY_CONFIG[actualCategory] || CATEGORY_CONFIG.single
                  const stCfg = STATUS_CONFIG[record.status] || STATUS_CONFIG.completed
                  const isSelected = selectedIds.includes(record.id)
                  return (
                    <Col xs={24} sm={12} lg={8} xl={6} key={record.id}>
                      <Card
                        hoverable
                        onClick={() => navigate(`/training/${record.id}`)}
                        style={{
                          height: '100%',
                          background: isSelected ? '#f0f7ff' : '#ffffff',
                          border: isSelected ? '2px solid #1677ff' : '1px solid #e8e8e8',
                          borderRadius: 8,
                          transition: 'all 0.2s ease',
                          cursor: 'pointer',
                          boxShadow: isSelected ? '0 4px 12px rgba(22,119,255,0.15)' : '0 1px 3px rgba(0,0,0,0.06)',
                        }}
                        styles={{ body: { padding: 16 } }}
                      >
                        <Space direction="vertical" size={6} style={{ width: '100%' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <Tag color={catCfg.color} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 10 }}>
                                {catCfg.label}
                              </Tag>
                              <Tag color={stCfg.color} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 10 }}>
                                {stCfg.label}
                              </Tag>
                            </div>
                            <div
                              onClick={(e) => {
                                e.stopPropagation()
                                handleSelect(record.id, !isSelected)
                              }}
                              style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                border: isSelected ? 'none' : '2px solid #d1d5db',
                                background: isSelected ? '#1677ff' : 'transparent',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                transition: 'all 0.2s',
                              }}
                            >
                              {isSelected && <CheckCircleOutlined style={{ color: '#ffffff', fontSize: 12 }} />}
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <StarFilled style={{ color: '#faad14', fontSize: 14, flexShrink: 0 }} />
                            <Text type="secondary" style={{ fontSize: 11, fontFamily: "'SF Mono', 'Consolas', monospace", flexShrink: 0 }}>#{record.id}</Text>
                            <Title level={5} style={{ color: '#1f2937', margin: 0, lineHeight: 1.3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {record.name}
                            </Title>
                            <Tooltip title="取消收藏">
                              <StarFilled
                                style={{ color: '#faad14', fontSize: 14, cursor: 'pointer', flexShrink: 0 }}
                                onClick={(e) => handleToggleFavorite(record, e)}
                              />
                            </Tooltip>
                            <Tooltip title="编辑名称和描述">
                              <EditOutlined
                                style={{ color: '#9ca3af', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}
                                onClick={(e) => handleOpenEditModal(record, e)}
                              />
                            </Tooltip>
                            {record.memo && (
                              <MemoPopover memo={record.memo}>
                                <FileTextOutlined
                                  style={{ color: '#1677ff', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </MemoPopover>
                            )}
                          </div>

                          {record.description && (
                            <Tooltip title={record.description}>
                              <div style={{
                                fontSize: 12,
                                color: '#8c8c8c',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                lineHeight: 1.5,
                              }}>
                                {record.description}
                              </div>
                            </Tooltip>
                          )}

                          {record.cumulative_return_preview && (
                            <div style={{
                              padding: '8px 0',
                            }}>
                              <MiniReturnChart data={record.cumulative_return_preview} />
                            </div>
                          )}

                          <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}>
                            <Tooltip title={`关联 ${record.run_count || record.run_ids?.length || 0} 个运行`}>
                              <Badge
                                count={record.run_count || record.run_ids?.length || 0}
                                overflowCount={9999}
                                style={{
                                  background: '#1677ff',
                                  fontFamily: "'SF Mono', 'Consolas', monospace",
                                  fontSize: 11,
                                }}
                              />
                            </Tooltip>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              <ClockCircleOutlined style={{ marginRight: 4 }} />
                              {record.created_at ? dayjs(record.created_at).format('YYYY-MM-DD HH:mm') : '-'}
                            </Text>
                          </div>
                        </Space>
                      </Card>
                    </Col>
                  )
                })}
              </Row>
              {favoriteRecords.length > cardPageSize && (
                <div style={{ marginTop: 16, textAlign: 'right' }}>
                  <Pagination
                    current={getCardPage('favorite')}
                    pageSize={cardPageSize}
                    total={favoriteRecords.length}
                    showSizeChanger
                    pageSizeOptions={['12', '24', '48', '96']}
                    showTotal={(total) => `共 ${total} 条`}
                    size="small"
                    onChange={(p, ps) => {
                      setCardPage('favorite', p)
                      if (ps !== cardPageSize) setCardPageSize(ps)
                    }}
                  />
                </div>
              )}
            </Panel>
          )}

          {(groupsData?.data || [])
            .filter((g: any) => !g.is_system && g.name !== '普通' && g.name !== '收藏')
            .map((group: any) => {
              const groupRecords = records.filter(r => r.group_name === group.name)
              return (
                <Panel
                  key={group.name}
                  header={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <FolderOutlined style={{ color: '#722ed1' }} />
                      <span style={{ fontWeight: 600 }}>{group.name}</span>
                      <Tag color="#722ed1">{group.count}</Tag>
                      <Button
                        type="text"
                        size="small"
                        icon={<FormOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleOpenRenameGroup(group.name) }}
                        style={{ color: '#1677ff', fontSize: 11 }}
                      >
                        重命名
                      </Button>
                      <Popconfirm
                        title={`解散"${group.name}"`}
                        description="所有记录将归回普通分组"
                        onConfirm={() => handleDissolveGroup(group.name)}
                        okText="确认解散"
                        cancelText="取消"
                        okType="danger"
                      >
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontSize: 11 }}
                        >
                          解散
                        </Button>
                      </Popconfirm>
                    </div>
                  }
                  style={{ marginBottom: 16, background: '#f9f0ff', borderRadius: 8, border: '1px solid #d3adf7' }}
                >
                  {groupRecords.length === 0 ? (
                    <Empty description="暂无记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    <Row gutter={[20, 20]}>
                      {groupRecords
                        .slice((getCardPage(group.name) - 1) * cardPageSize, getCardPage(group.name) * cardPageSize)
                        .map((record: TrainingRecord) => {
                        const actualCategory = (record.run_count || 0) > 1 ? 'rolling' : 'single'
                        const catCfg = CATEGORY_CONFIG[actualCategory] || CATEGORY_CONFIG.single
                        const stCfg = STATUS_CONFIG[record.status] || STATUS_CONFIG.completed
                        const isSelected = selectedIds.includes(record.id)
                        return (
                          <Col xs={24} sm={12} lg={8} xl={6} key={record.id}>
                            <Card
                              hoverable
                              onClick={() => navigate(`/training/${record.id}`)}
                              style={{
                                height: '100%',
                                background: isSelected ? '#f0f7ff' : '#ffffff',
                                border: isSelected ? '2px solid #1677ff' : '1px solid #e8e8e8',
                                borderRadius: 8,
                                transition: 'all 0.2s ease',
                                cursor: 'pointer',
                                boxShadow: isSelected ? '0 4px 12px rgba(22,119,255,0.15)' : '0 1px 3px rgba(0,0,0,0.06)',
                              }}
                              styles={{ body: { padding: 16 } }}
                            >
                              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                    <Tag color={catCfg.color} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 10 }}>
                                      {catCfg.label}
                                    </Tag>
                                    <Tag color={stCfg.color} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 10 }}>
                                      {stCfg.label}
                                    </Tag>
                                  </div>
                                  <div
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleSelect(record.id, !isSelected)
                                    }}
                                  >
                                    {isSelected ? <CheckSquareFilled style={{ color: '#1677ff', fontSize: 16 }} /> : <BorderOutlined style={{ color: '#bfbfbf', fontSize: 16 }} />}
                                  </div>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <Text type="secondary" style={{ fontSize: 11, fontFamily: "'SF Mono', 'Consolas', monospace", flexShrink: 0 }}>#{record.id}</Text>
                                  <Title level={5} style={{ color: '#1f2937', margin: 0, lineHeight: 1.3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {record.name}
                                  </Title>
                                  {!record.is_favorite && (
                                    <Tooltip title="收藏">
                                      <StarOutlined
                                        style={{ color: '#9ca3af', fontSize: 14, cursor: 'pointer', flexShrink: 0 }}
                                        onClick={(e) => handleToggleFavorite(record, e)}
                                      />
                                    </Tooltip>
                                  )}
                                  {record.is_favorite && (
                                    <Tooltip title="取消收藏">
                                      <StarFilled
                                        style={{ color: '#faad14', fontSize: 14, cursor: 'pointer', flexShrink: 0 }}
                                        onClick={(e) => handleToggleFavorite(record, e)}
                                      />
                                    </Tooltip>
                                  )}
                                  <Tooltip title="编辑名称和描述">
                                    <EditOutlined
                                      style={{ color: '#9ca3af', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}
                                      onClick={(e) => handleOpenEditModal(record, e)}
                                    />
                                  </Tooltip>
                                  {record.memo && (
                                    <MemoPopover memo={record.memo}>
                                      <FileTextOutlined
                                        style={{ color: '#1677ff', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                    </MemoPopover>
                                  )}
                                </div>

                                {record.description && (
                                  <Tooltip title={record.description}>
                                    <div style={{
                                      fontSize: 12,
                                      color: '#8c8c8c',
                                      display: '-webkit-box',
                                      WebkitLineClamp: 2,
                                      WebkitBoxOrient: 'vertical',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      lineHeight: 1.5,
                                    }}>
                                      {record.description}
                                    </div>
                                  </Tooltip>
                                )}

                                {record.cumulative_return_preview && (
                                  <div style={{
                                    padding: '8px 0',
                                  }}>
                                    <MiniReturnChart data={record.cumulative_return_preview} />
                                  </div>
                                )}

                                <div style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                }}>
                                  <Tooltip title={`关联 ${record.run_count || record.run_ids?.length || 0} 个运行`}>
                                    <Badge
                                      count={record.run_count || record.run_ids?.length || 0}
                                      overflowCount={9999}
                                      style={{
                                        background: '#1677ff',
                                        fontFamily: "'SF Mono', 'Consolas', monospace",
                                        fontSize: 11,
                                      }}
                                    />
                                  </Tooltip>
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    <ClockCircleOutlined style={{ marginRight: 4 }} />
                                    {record.created_at ? dayjs(record.created_at).format('YYYY-MM-DD HH:mm') : '-'}
                                  </Text>
                                </div>
                              </Space>
                            </Card>
                          </Col>
                        )
                      })}
                    </Row>
                  )}
                  {groupRecords.length > cardPageSize && (
                    <div style={{ marginTop: 16, textAlign: 'right' }}>
                      <Pagination
                        current={getCardPage(group.name)}
                        pageSize={cardPageSize}
                        total={groupRecords.length}
                        showSizeChanger
                        pageSizeOptions={['12', '24', '48', '96']}
                        showTotal={(total) => `共 ${total} 条`}
                        size="small"
                        onChange={(p, ps) => {
                          setCardPage(group.name, p)
                          if (ps !== cardPageSize) setCardPageSize(ps)
                        }}
                      />
                    </div>
                  )}
                </Panel>
              )
            })}

          <Panel
            header={
              <Space>
                <FolderOutlined />
                <span style={{ fontWeight: 600 }}>普通</span>
                <Tag color="#1677ff" style={{ marginLeft: 8 }}>{normalRecords.length}</Tag>
              </Space>
            }
            key="normal"
            style={{ marginBottom: 16, background: '#fff', borderRadius: 8, border: '1px solid #e8e8e8' }}
          >
            {normalRecords.length === 0 ? (
              <Empty description="暂无记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Row gutter={[20, 20]}>
                {normalRecords
                  .slice((getCardPage('normal') - 1) * cardPageSize, getCardPage('normal') * cardPageSize)
                  .map((record: TrainingRecord) => {
                  const actualCategory = (record.run_count || 0) > 1 ? 'rolling' : 'single'
                  const catCfg = CATEGORY_CONFIG[actualCategory] || CATEGORY_CONFIG.single
                  const stCfg = STATUS_CONFIG[record.status] || STATUS_CONFIG.completed
                  const isSelected = selectedIds.includes(record.id)
                  return (
                    <Col xs={24} sm={12} lg={8} xl={6} key={record.id}>
                      <Card
                        hoverable
                        onClick={() => navigate(`/training/${record.id}`)}
                        style={{
                          height: '100%',
                          background: isSelected ? '#f0f7ff' : '#ffffff',
                          border: isSelected ? '2px solid #1677ff' : '1px solid #e8e8e8',
                          borderRadius: 8,
                          transition: 'all 0.2s ease',
                          cursor: 'pointer',
                          boxShadow: isSelected ? '0 4px 12px rgba(22,119,255,0.15)' : '0 1px 3px rgba(0,0,0,0.06)',
                        }}
                        styles={{ body: { padding: 16 } }}
                      >
                        <Space direction="vertical" size={6} style={{ width: '100%' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <Tag color={catCfg.color} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 10 }}>
                                {catCfg.label}
                              </Tag>
                              <Tag color={stCfg.color} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 10 }}>
                                {stCfg.label}
                              </Tag>
                            </div>
                            <div
                              onClick={(e) => {
                                e.stopPropagation()
                                handleSelect(record.id, !isSelected)
                              }}
                              style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                border: isSelected ? 'none' : '2px solid #d1d5db',
                                background: isSelected ? '#1677ff' : 'transparent',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                transition: 'all 0.2s',
                              }}
                            >
                              {isSelected && <CheckCircleOutlined style={{ color: '#ffffff', fontSize: 12 }} />}
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {record.is_favorite && <StarFilled style={{ color: '#faad14', fontSize: 14, flexShrink: 0 }} />}
                            <Text type="secondary" style={{ fontSize: 11, fontFamily: "'SF Mono', 'Consolas', monospace", flexShrink: 0 }}>#{record.id}</Text>
                            <Title level={5} style={{ color: '#1f2937', margin: 0, lineHeight: 1.3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {record.name}
                            </Title>
                            {!record.is_favorite && (
                              <Tooltip title="收藏">
                                <StarOutlined
                                  style={{ color: '#9ca3af', fontSize: 14, cursor: 'pointer', flexShrink: 0 }}
                                  onClick={(e) => handleToggleFavorite(record, e)}
                                />
                              </Tooltip>
                            )}
                            {record.is_favorite && (
                              <Tooltip title="取消收藏">
                                <StarFilled
                                  style={{ color: '#faad14', fontSize: 14, cursor: 'pointer', flexShrink: 0 }}
                                  onClick={(e) => handleToggleFavorite(record, e)}
                                />
                              </Tooltip>
                            )}
                            <Tooltip title="编辑名称和描述">
                              <EditOutlined
                                style={{ color: '#9ca3af', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}
                                onClick={(e) => handleOpenEditModal(record, e)}
                              />
                            </Tooltip>
                            {record.memo && (
                              <MemoPopover memo={record.memo}>
                                <FileTextOutlined
                                  style={{ color: '#1677ff', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </MemoPopover>
                            )}
                          </div>

                          {record.description && (
                            <Tooltip title={record.description}>
                              <div style={{
                                fontSize: 12,
                                color: '#8c8c8c',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                lineHeight: 1.5,
                              }}>
                                {record.description}
                              </div>
                            </Tooltip>
                          )}

                          {record.cumulative_return_preview && (
                            <div style={{
                              padding: '8px 0',
                            }}>
                              <MiniReturnChart data={record.cumulative_return_preview} />
                            </div>
                          )}

                          <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}>
                            <Tooltip title={`关联 ${record.run_count || record.run_ids?.length || 0} 个运行`}>
                              <Badge
                                count={record.run_count || record.run_ids?.length || 0}
                                overflowCount={9999}
                                style={{
                                  background: '#1677ff',
                                  fontFamily: "'SF Mono', 'Consolas', monospace",
                                  fontSize: 11,
                                }}
                              />
                            </Tooltip>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              <ClockCircleOutlined style={{ marginRight: 4 }} />
                              {record.created_at ? dayjs(record.created_at).format('YYYY-MM-DD HH:mm') : '-'}
                            </Text>
                          </div>
                        </Space>
                      </Card>
                    </Col>
                  )
                })}
              </Row>
            )}
            {normalRecords.length > cardPageSize && (
              <div style={{ marginTop: 16, textAlign: 'right' }}>
                <Pagination
                  current={getCardPage('normal')}
                  pageSize={cardPageSize}
                  total={normalRecords.length}
                  showSizeChanger
                  pageSizeOptions={['12', '24', '48', '96']}
                  showTotal={(total) => `共 ${total} 条`}
                  size="small"
                  onChange={(p, ps) => {
                    setCardPage('normal', p)
                    if (ps !== cardPageSize) setCardPageSize(ps)
                  }}
                />
              </div>
            )}
          </Panel>
        </Collapse>
      )}

      <Modal
        title="编辑训练记录"
        open={editModalVisible}
        onCancel={() => {
          setEditModalVisible(false)
          setEditingRecord(null)
        }}
        onOk={handleSaveEdit}
        confirmLoading={updateMutation.isPending}
        okText="保存"
        cancelText="取消"
      >
        <div style={{ marginBottom: 16 }}>
          <Text style={{ marginBottom: 8, display: 'block' }}>名称 <Text type="danger">*</Text></Text>
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="请输入训练记录名称"
            maxLength={255}
          />
        </div>
        <div>
          <Text style={{ marginBottom: 8, display: 'block' }}>描述</Text>
          <TextArea
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            placeholder="请输入描述（可选）"
            rows={4}
            maxLength={1000}
          />
        </div>
      </Modal>

      <Modal
        title="创建新分组"
        open={createGroupModalVisible}
        onCancel={() => {
          setCreateGroupModalVisible(false)
          setNewGroupName('')
        }}
        onOk={handleCreateGroup}
        confirmLoading={batchGroupMutation.isPending}
        okText="创建"
        cancelText="取消"
      >
        <div style={{ marginBottom: 12 }}>
          <Text style={{ marginBottom: 8, display: 'block' }}>分组名称 <Text type="danger">*</Text></Text>
          <Input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="请输入分组名称"
            prefix={<FolderAddOutlined />}
            maxLength={64}
            autoFocus
          />
        </div>
        <Alert
          type="info"
          message={`已选择 ${selectedIds.length} 条记录将移至新分组`}
          showIcon
          style={{ fontSize: 12 }}
        />
      </Modal>

      <Modal
        title="重命名分组"
        open={renameGroupModalVisible}
        onCancel={() => {
          setRenameGroupModalVisible(false)
          setRenameOldName('')
          setRenameNewName('')
        }}
        onOk={handleSaveRenameGroup}
        confirmLoading={renameGroupMutation.isPending}
        okText="保存"
        cancelText="取消"
      >
        <div style={{ marginBottom: 12 }}>
          <Text style={{ marginBottom: 8, display: 'block' }}>当前名称</Text>
          <Input value={renameOldName} disabled />
        </div>
        <div>
          <Text style={{ marginBottom: 8, display: 'block' }}>新名称 <Text type="danger">*</Text></Text>
          <Input
            value={renameNewName}
            onChange={(e) => setRenameNewName(e.target.value)}
            placeholder="请输入新的分组名称"
            prefix={<FormOutlined />}
            maxLength={64}
            autoFocus
          />
        </div>
      </Modal>
    </div>
  )
}

export default TrainingRecordsPage
