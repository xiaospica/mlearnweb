/**
 * 关于
 *
 * 简洁的版本/品牌/模块清单页，便于 about-this-build 报告。
 */

import { Card, Descriptions, Tag, Space, Typography, Row, Col } from 'antd'
import { useQuery } from '@tanstack/react-query'
import PageContainer from '@/components/layout/PageContainer'
import Logo from '@/components/brand/Logo'
import { BRAND_NAME, BRAND_TAGLINE } from '@/config/brand'
import { fetchEnvInfo } from '@/services/settingsService'

const { Text, Paragraph } = Typography

interface ModuleSpec {
  key: string
  label: string
  desc: string
  routes: string[]
}

const MODULES: ModuleSpec[] = [
  {
    key: 'training',
    label: '训练记录',
    desc: '滚动训练记录索引、对比与详情',
    routes: ['/', '/training/:id', '/training/compare'],
  },
  {
    key: 'experiments',
    label: '实验浏览',
    desc: 'MLflow 实验列表 + run 详情 + 回测 Report',
    routes: ['/experiments', '/experiments/:expId', '/report/:expId/:runId'],
  },
  {
    key: 'workbench',
    label: '训练工作台',
    desc: 'Optuna 调参作业的创建与监控',
    routes: ['/workbench', '/workbench/new', '/workbench/jobs/:jobId'],
  },
  {
    key: 'live',
    label: '实盘交易',
    desc: 'vnpy 多节点策略汇总 + 单策略详情（独立 :8100 进程）',
    routes: ['/live-trading', '/live-trading/:nodeId/:engine/:name'],
  },
  {
    key: 'help',
    label: '帮助',
    desc: '因子分类、Alpha158 / 101 / 191 文档',
    routes: ['/help/categories', '/help/alpha158', '/help/alpha101', '/help/alpha191'],
  },
  {
    key: 'settings',
    label: '设置',
    desc: '外观、运行期默认、节点、系统限制、环境信息（当前页所属）',
    routes: ['/settings/*'],
  },
]

const BUILD_TIME = new Date().toISOString()

const SettingsAboutPage = () => {
  const { data } = useQuery({
    queryKey: ['settings', 'env'],
    queryFn: fetchEnvInfo,
    staleTime: 60_000,
  })

  return (
    <PageContainer
      title={`关于 ${BRAND_NAME}`}
      subtitle={BRAND_TAGLINE}
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card size="small">
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Logo variant="full" height={36} style={{ color: 'var(--ap-brand-primary)' }} />
              </div>
              <Paragraph style={{ margin: 0 }}>
                {BRAND_NAME} 是基于 qlib 的 A 股量化研究 → 训练 → 实盘一体化平台。
                研究侧在 :8000 端口，实盘侧在 :8100 端口独立运行；通过 SQLite WAL 共享数据。
              </Paragraph>

              <Descriptions column={1} size="small">
                <Descriptions.Item label="构建时间（前端）">
                  <Text code>{BUILD_TIME}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="后端 git">
                  {data?.git.sha ? (
                    <Space size={4}>
                      <Tag color="blue">{data.git.branch ?? '?'}</Tag>
                      <Text code>{data.git.sha}</Text>
                    </Space>
                  ) : (
                    <Text type="secondary">未知</Text>
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="Python">
                  {data ? `${data.python.version} (${data.python.implementation})` : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="平台">
                  {data
                    ? `${data.platform.system} ${data.platform.release}`
                    : '—'}
                </Descriptions.Item>
              </Descriptions>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card title="模块清单" size="small">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {MODULES.map((m) => (
                <div key={m.key}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Tag color="blue">{m.label}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>{m.desc}</Text>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    {m.routes.map((r) => (
                      <Tag key={r} style={{ marginInlineEnd: 4 }}>
                        <Text code style={{ fontSize: 11 }}>{r}</Text>
                      </Tag>
                    ))}
                  </div>
                </div>
              ))}
            </Space>
          </Card>
        </Col>
      </Row>
    </PageContainer>
  )
}

export default SettingsAboutPage
