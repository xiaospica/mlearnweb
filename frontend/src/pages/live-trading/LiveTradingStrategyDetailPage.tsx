import React, { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { liveTradingService } from '@/services/liveTradingService'
import FullEquityChart from './components/FullEquityChart'
import LatestTopkCard from './components/LatestTopkCard'
import MlMonitorPanel from './components/MlMonitorPanel'
import PositionsTable from './components/PositionsTable'
import StrategyActions from './components/StrategyActions'
import StrategyEditModal from './components/StrategyEditModal'

dayjs.extend(relativeTime)

const { Title, Text } = Typography

const LiveTradingStrategyDetailPage: React.FC = () => {
  const navigate = useNavigate()
  const params = useParams<{ nodeId: string; engine: string; name: string }>()
  const nodeId = decodeURIComponent(params.nodeId || '')
  const engine = decodeURIComponent(params.engine || '')
  const name = decodeURIComponent(params.name || '')
  const [editOpen, setEditOpen] = useState(false)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['live-strategy', nodeId, engine, name],
    queryFn: () => liveTradingService.getStrategy(nodeId, engine, name),
    refetchInterval: 3000,
    staleTime: 0,
    enabled: !!(nodeId && engine && name),
  })

  const detail = data?.success ? data?.data : null
  const warning = data?.warning || (!data?.success ? data?.message : null)

  const badgeStatus: 'processing' | 'default' | 'warning' | 'error' = detail
    ? detail.running
      ? 'processing'
      : detail.inited
        ? 'warning'
        : 'default'
    : 'default'
  const badgeText = detail
    ? detail.running
      ? '运行中'
      : detail.inited
        ? '已初始化'
        : '未初始化'
    : '-'

  return (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ marginBottom: 16 }}>
        <Space size={8} style={{ marginBottom: 8 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/live-trading')}>
            返回
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            刷新
          </Button>
        </Space>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <Title level={3} style={{ margin: 0 }}>
              {name}
            </Title>
            <Space size={4} style={{ marginTop: 6 }}>
              <Tag color="geekblue">{nodeId}</Tag>
              <Tag color="purple">{engine}</Tag>
              {detail?.class_name && <Tag>{detail.class_name}</Tag>}
              {detail?.vt_symbol && <Tag color="gold">{detail.vt_symbol}</Tag>}
              <Badge status={badgeStatus} text={<Text style={{ fontSize: 12 }}>{badgeText}</Text>} />
            </Space>
            {detail?.last_update_ts && (
              <div style={{ marginTop: 4, fontSize: 11, color: '#8c8c8c' }}>
                最后更新: {dayjs(detail.last_update_ts).fromNow()}
              </div>
            )}
          </div>
          {detail && (
            <StrategyActions
              nodeId={nodeId}
              engine={engine}
              name={name}
              capabilities={detail.capabilities}
              inited={detail.inited}
              trading={detail.trading}
              onEdit={() => setEditOpen(true)}
            />
          )}
        </div>
      </div>

      {warning && (
        <Alert
          type={data?.success ? 'warning' : 'error'}
          showIcon
          message={warning}
          style={{ marginBottom: 12 }}
          closable
        />
      )}

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      ) : !detail ? (
        <Card>
          <Empty description="策略不存在或暂不可用" />
        </Card>
      ) : (
        <Tabs
          defaultActiveKey="curve"
          items={[
            {
              key: 'curve',
              label: '收益曲线与持仓',
              children: (
                <div>
                  <Card styles={{ body: { padding: 16 } }}>
                    <FullEquityChart
                      data={detail.curve}
                      sourceLabel={detail.source_label}
                    />
                  </Card>
                  <Card
                    title="当前持仓"
                    style={{ marginTop: 16 }}
                    styles={{ body: { padding: 0 } }}
                  >
                    <PositionsTable rows={detail.positions} />
                  </Card>
                  {engine === 'MlStrategy' && (
                    <LatestTopkCard nodeId={nodeId} strategyName={name} />
                  )}
                  <Card title="参数 / 运行时变量" style={{ marginTop: 16 }}>
                    <Descriptions
                      size="small"
                      column={2}
                      bordered
                      items={Object.entries(detail.parameters || {}).map(([k, v]) => ({
                        key: `p-${k}`,
                        label: k,
                        children: (
                          <span style={{ fontFamily: "'SF Mono', 'Consolas', monospace" }}>
                            {String(v)}
                          </span>
                        ),
                      }))}
                    />
                    <div style={{ marginTop: 12 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        Variables (只读):
                      </Text>
                      <pre
                        style={{
                          background: '#f6f8fa',
                          padding: 12,
                          borderRadius: 6,
                          fontSize: 12,
                          margin: '4px 0 0 0',
                        }}
                      >
                        {JSON.stringify(detail.variables || {}, null, 2)}
                      </pre>
                    </div>
                  </Card>
                </div>
              ),
            },
            {
              key: 'monitor',
              label: '策略监控',
              children: (
                <MlMonitorPanel nodeId={nodeId} strategyName={name} />
              ),
            },
          ]}
        />
      )}

      {detail && (
        <StrategyEditModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          nodeId={nodeId}
          engine={engine}
          name={name}
          parameters={detail.parameters || {}}
        />
      )}
    </div>
  )
}

export default LiveTradingStrategyDetailPage
