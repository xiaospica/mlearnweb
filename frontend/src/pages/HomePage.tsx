import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { App as AntApp, Card, Input, Row, Col, Typography, Tag, Space, Spin, Empty, Statistic, Badge, Tooltip, Alert, Button, Divider, Select } from 'antd'
import { SearchOutlined, ExperimentOutlined, ClockCircleOutlined, CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, ReloadOutlined, CodeOutlined, DatabaseOutlined, ThunderboltOutlined, UnorderedListOutlined, FileSearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { experimentService } from '@/services/experimentService'
import { runService } from '@/services/runService'
import type { Experiment } from '@/types'
import PageContainer from '@/components/layout/PageContainer'
import MetricCardGrid from '@/components/responsive/MetricCardGrid'

const { Title, Text, Paragraph } = Typography

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  active: { color: '#52c41a', icon: <CheckCircleOutlined /> },
  deleted: { color: '#ff4d4f', icon: <CloseCircleOutlined /> },
}

/** MLflow run_id 是 32 位 hex；这里允许 ≥16 hex 以兼容截断粘贴。 */
const RUN_ID_RE = /^[a-f0-9]{16,}$/i

const isRunIdLike = (value: string): boolean =>
  RUN_ID_RE.test(value.trim())

const UsageGuide: React.FC = () => (
  <Card
    style={{
      background: 'rgba(59, 130, 246, 0.06)',
      border: '1px solid rgba(59, 130, 246, 0.20)',
      borderRadius: 8,
    }}
    styles={{ body: { padding: '24px 28px' } }}
  >
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: 'rgba(59, 130, 246, 0.16)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <CodeOutlined style={{ fontSize: 20, color: '#1677ff' }} />
      </div>
      <div style={{ flex: 1 }}>
        <Title level={5} style={{ color: 'var(--ap-text)', margin: '0 0 8px 0' }}>如何使用回测看板</Title>
        <Paragraph style={{ color: 'var(--ap-text-muted)', margin: 0, fontSize: 13, lineHeight: 1.8 }}>
          看板用于可视化 <Text code>mlruns/</Text> 目录中的历史回测记录。
          要在看板中看到数据，请先通过命令行执行训练：
        </Paragraph>

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', background: 'var(--ap-panel-muted)', borderRadius: 6,
            borderLeft: '3px solid var(--ap-brand-primary)',
            boxShadow: '0 1px 2px var(--ap-shadow)',
          }}>
            <ThunderboltOutlined style={{ color: 'var(--ap-warning)', fontSize: 14 }} />
            <Text style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 12, color: 'var(--ap-text)' }}>
              cd strategy_dev &amp;&amp; python tushare_hs300_rolling_train.py --name "我的训练"
            </Text>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', background: 'var(--ap-panel-muted)', borderRadius: 6,
            borderLeft: '3px solid var(--ap-success)',
            boxShadow: '0 1px 2px var(--ap-shadow)',
          }}>
            <DatabaseOutlined style={{ color: 'var(--ap-success)', fontSize: 14 }} />
            <Text style={{ fontSize: 12, color: 'var(--ap-text-muted)' }}>
              训练完成后，结果自动保存到 <Text code>mlruns/</Text> 目录，
              刷新此页面即可看到新的实验记录。
            </Text>
          </div>
        </div>

        <Divider style={{ borderColor: 'var(--ap-border-muted)', margin: '16px 0' }} />

        <Row gutter={24}>
          <Col span={8}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                background: 'rgba(59, 130, 246, 0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <ExperimentOutlined style={{ color: '#1677ff', fontSize: 18 }} />
              </div>
              <Text strong style={{ color: 'var(--ap-text)', fontSize: 12, display: 'block' }}>1. 浏览实验</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>点击实验卡片查看详情</Text>
            </div>
          </Col>
          <Col span={8}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                background: 'rgba(34, 197, 94, 0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <LoadingOutlined style={{ color: '#1677ff', fontSize: 18 }} />
              </div>
              <Text strong style={{ color: 'var(--ap-text)', fontSize: 12, display: 'block' }}>2. 查看运行</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>查看每次训练的运行记录</Text>
            </div>
          </Col>
          <Col span={8}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                background: 'rgba(245, 158, 11, 0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <ThunderboltOutlined style={{ color: '#fa8c16', fontSize: 18 }} />
              </div>
              <Text strong style={{ color: 'var(--ap-text)', fontSize: 12, display: 'block' }}>3. 查看报告</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>收益曲线、模型参数、完整指标</Text>
            </div>
          </Col>
        </Row>
      </div>
    </div>
  </Card>
)

const HomePage: React.FC = () => {
  const [search, setSearch] = useState('')
  const [runIdLooking, setRunIdLooking] = useState(false)
  const navigate = useNavigate()
  const { message } = AntApp.useApp()

  /** 跨实验按 run_id 查找 → 直接跳报告页；失败则 toast 提示。 */
  const handleRunIdSearch = async (rawValue: string) => {
    const rid = rawValue.trim()
    if (!rid) return
    if (rid.length < 8) {
      message.warning('run_id 至少 8 位字符')
      return
    }
    setRunIdLooking(true)
    try {
      const res = await runService.findById(rid)
      if (res.success && res.data) {
        navigate(`/report/${res.data.experiment_id}/${res.data.run_id}`)
      } else {
        message.error(res.message || `未找到 run_id=${rid}`)
      }
    } catch (e) {
      message.error(`查找失败：${(e as Error)?.message || e}`)
    } finally {
      setRunIdLooking(false)
    }
  }

  // 输入是 run_id 时不要发实验列表查询：(1) 后端按名字 like 搜，hex 串大概率
  // 0 命中，会让搜索框 + 数据卡片消失；(2) run_id 走专门的 lookup 端点。
  const treatAsRunId = isRunIdLike(search)
  const expSearchTerm = treatAsRunId ? '' : search

  const { data: expData, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['experiments', expSearchTerm],
    queryFn: () => experimentService.list(expSearchTerm),
    retry: 1,
    refetchOnWindowFocus: true,
  })

  const experiments = expData?.data?.items || []
  const total = expData?.data?.total || 0
  // 是否处于「真没数据」状态（首次/全量为空），与「搜不到」区分
  const reallyEmpty = !isLoading && !isError && experiments.length === 0 && expSearchTerm === ''
  const noMatch = !isLoading && !isError && experiments.length === 0 && expSearchTerm !== ''

  return (
    <PageContainer
      title="实验浏览"
      subtitle={`浏览 MLFlow 原始实验数据${total > 0 ? ` · 共 ${total} 个实验` : ''}`}
      actions={
        <Button icon={<ReloadOutlined />} onClick={() => refetch()} size="small">
          刷新数据
        </Button>
      }
    >
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
                marginTop: 8, padding: '8px 12px', background: 'var(--ap-panel-muted)', borderRadius: 6,
                fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11, color: 'var(--ap-text-muted)',
              }}>
                cd mlearnweb/backend &amp;&amp; python -m uvicorn app.main:app --port 8000
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

      {/* 搜索框始终显示（即使 0 实验也要让用户能粘贴 run_id 跳转）。
          输入命中 run_id 格式时前缀图标变蓝、右侧出现「跳转」按钮。 */}
      {!isError && (
        <Input.Search
          placeholder="搜索实验名 / 粘贴 run_id 跳转报告"
          prefix={
            treatAsRunId
              ? <FileSearchOutlined style={{ color: 'var(--ap-brand-primary)' }} />
              : <SearchOutlined style={{ color: '#9ca3af' }} />
          }
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(value) => {
            if (isRunIdLike(value)) handleRunIdSearch(value)
          }}
          enterButton={treatAsRunId ? '跳转' : false}
          loading={runIdLooking}
          allowClear
          style={{ width: '100%', maxWidth: 480, marginBottom: 20 }}
        />
      )}

      {experiments.length > 0 && !isError && (
        <MetricCardGrid
          style={{ marginBottom: 20 }}
          items={[
            {
              key: 'total',
              label: '总实验数',
              value: total,
              tone: 'primary',
              icon: <ExperimentOutlined />,
            },
            {
              key: 'active',
              label: '活跃实验',
              value: experiments.filter((e) => e.lifecycle_stage === 'active').length,
              tone: 'success',
              icon: <CheckCircleOutlined />,
            },
            {
              key: 'runs',
              label: '总运行次数',
              value: experiments.reduce((sum, e) => sum + e.run_count, 0),
              tone: 'primary',
              icon: <LoadingOutlined />,
            },
            {
              key: 'avg',
              label: '平均运行数',
              value: `${total > 0 ? Math.round(experiments.reduce((sum, e) => sum + e.run_count, 0) / total) : 0}/exp`,
              tone: 'warning',
            },
          ]}
        />
      )}

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : isError ? null : reallyEmpty ? (
        <UsageGuide />
      ) : noMatch ? (
        <Empty
          description={
            treatAsRunId
              ? `按回车或点击「跳转」查找 run_id ${search.slice(0, 12)}…`
              : `没有名称匹配「${search}」的实验`
          }
          style={{ padding: 60 }}
        />
      ) : (
        <Row gutter={[20, 20]}>
          {experiments.map((exp: Experiment) => (
            <Col xs={24} sm={12} lg={8} xl={6} key={exp.experiment_id}>
              <Card
                hoverable
                onClick={() => navigate(`/experiments/${exp.experiment_id}`)}
                style={{
                  height: '100%',
                  background: 'var(--ap-panel)',
                  border: '1px solid var(--ap-border)',
                  borderRadius: 8,
                  transition: 'all 0.2s ease',
                  cursor: 'pointer',
                  boxShadow: '0 1px 3px var(--ap-shadow)',
                }}
                styles={{ body: { padding: 20 } }}
              >
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <div>
                    <Tag
                      color={STATUS_CONFIG[exp.lifecycle_stage]?.color || '#d9d9d9'}
                      style={{ marginRight: 8, fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 10 }}
                    >
                      {exp.lifecycle_stage}
                    </Tag>
                  </div>

                  <Title level={5} style={{ color: 'var(--ap-text)', margin: 0, lineHeight: 1.3, minHeight: 48 }}>
                    {exp.name || exp.experiment_id}
                  </Title>

                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      <ClockCircleOutlined style={{ marginRight: 4 }} />
                      {exp.creation_time ? dayjs(exp.creation_time).format('YYYY-MM-DD HH:mm') : '-'}
                    </Text>
                    <Tooltip title="运行记录数量">
                      <Badge
                        count={exp.run_count}
                        overflowCount={9999}
                        style={{
                          background: '#1677ff',
                          fontFamily: "'SF Mono', 'Consolas', monospace",
                          fontSize: 11,
                        }}
                      />
                    </Tooltip>
                  </div>

                  <div style={{
                    height: 4,
                    background: '#f0f0f0',
                    borderRadius: 2,
                    position: 'relative',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: 2,
                      background: '#1677ff',
                      opacity: 0.6,
                      borderRadius: 2,
                    }} />
                  </div>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </PageContainer>
  )
}

export default HomePage
