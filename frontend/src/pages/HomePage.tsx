import React, { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, Input, Row, Col, Typography, Tag, Space, Spin, Empty, Statistic, Badge, Tooltip, Alert, Button, Divider, Select } from 'antd'
import { SearchOutlined, ExperimentOutlined, ClockCircleOutlined, CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, ReloadOutlined, CodeOutlined, DatabaseOutlined, ThunderboltOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { experimentService } from '@/services/experimentService'
import type { Experiment } from '@/types'
import PageContainer from '@/components/layout/PageContainer'
import MetricCardGrid from '@/components/responsive/MetricCardGrid'

const { Title, Text, Paragraph } = Typography

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  active: { color: '#52c41a', icon: <CheckCircleOutlined /> },
  deleted: { color: '#ff4d4f', icon: <CloseCircleOutlined /> },
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
        <CodeOutlined style={{ fontSize: 20, color: '#1677ff' }} />
      </div>
      <div style={{ flex: 1 }}>
        <Title level={5} style={{ color: '#1f2937', margin: '0 0 8px 0' }}>如何使用回测看板</Title>
        <Paragraph style={{ color: '#6b7280', margin: 0, fontSize: 13, lineHeight: 1.8 }}>
          看板用于可视化 <Text code>mlruns/</Text> 目录中的历史回测记录。
          要在看板中看到数据，请先通过命令行执行训练：
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
              cd strategy_dev &amp;&amp; python tushare_hs300_rolling_train.py --name "我的训练"
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
              训练完成后，结果自动保存到 <Text code>mlruns/</Text> 目录，
              刷新此页面即可看到新的实验记录。
            </Text>
          </div>
        </div>

        <Divider style={{ borderColor: '#e8e8e8', margin: '16px 0' }} />

        <Row gutter={24}>
          <Col span={8}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                background: '#e8f4fd', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <ExperimentOutlined style={{ color: '#1677ff', fontSize: 18 }} />
              </div>
              <Text strong style={{ color: '#1f2937', fontSize: 12, display: 'block' }}>1. 浏览实验</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>点击实验卡片查看详情</Text>
            </div>
          </Col>
          <Col span={8}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                background: '#f0fff0', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <LoadingOutlined style={{ color: '#1677ff', fontSize: 18 }} />
              </div>
              <Text strong style={{ color: '#1f2937', fontSize: 12, display: 'block' }}>2. 查看运行</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>查看每次训练的运行记录</Text>
            </div>
          </Col>
          <Col span={8}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                background: '#fff7e6', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <ThunderboltOutlined style={{ color: '#fa8c16', fontSize: 18 }} />
              </div>
              <Text strong style={{ color: '#1f2937', fontSize: 12, display: 'block' }}>3. 查看报告</Text>
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
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: expData, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['experiments', search],
    queryFn: () => experimentService.list(search),
    retry: 1,
    refetchOnWindowFocus: true,
  })

  const experiments = expData?.data?.items || []
  const total = expData?.data?.total || 0

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
                marginTop: 8, padding: '8px 12px', background: '#fafafa', borderRadius: 6,
                fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11, color: '#6b7280',
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

      {experiments.length > 0 && !isError && (
        <>
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

          <Input
            placeholder="搜索实验名称..."
            prefix={<SearchOutlined style={{ color: '#9ca3af' }} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            style={{
              maxWidth: 400,
              marginBottom: 20,
            }}
          />
        </>
      )}

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : isError ? null : experiments.length === 0 ? (
        <UsageGuide />
      ) : (
        <Row gutter={[20, 20]}>
          {experiments.map((exp: Experiment) => (
            <Col xs={24} sm={12} lg={8} xl={6} key={exp.experiment_id}>
              <Card
                hoverable
                onClick={() => navigate(`/experiments/${exp.experiment_id}`)}
                style={{
                  height: '100%',
                  background: '#ffffff',
                  border: '1px solid #e8e8e8',
                  borderRadius: 8,
                  transition: 'all 0.2s ease',
                  cursor: 'pointer',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
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

                  <Title level={5} style={{ color: '#1f2937', margin: 0, lineHeight: 1.3, minHeight: 48 }}>
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
