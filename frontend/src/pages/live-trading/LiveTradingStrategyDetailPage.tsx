import React, { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import ResponsiveDescriptions from '@/components/responsive/ResponsiveDescriptions'
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { liveTradingService } from '@/services/liveTradingService'
import FullEquityChart from './components/FullEquityChart'
import CorpActionsCard from './components/CorpActionsCard'
import LatestTopkCard from './components/LatestTopkCard'
import MlMonitorPanel from './components/MlMonitorPanel'
import PositionsTable from './components/PositionsTable'
import StrategyActions from './components/StrategyActions'
import StrategyEditModal from './components/StrategyEditModal'
import PageContainer from '@/components/layout/PageContainer'

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
    <PageContainer
      sticky
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/live-trading')} size="small">
            返回
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()} size="small">
            刷新
          </Button>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </span>
        </span>
      }
      tags={
        <Space size={4} wrap>
          <Tag color="geekblue">{nodeId}</Tag>
          <Tag color="purple">{engine}</Tag>
          {detail?.class_name && <Tag>{detail.class_name}</Tag>}
          {detail?.vt_symbol && <Tag color="gold">{detail.vt_symbol}</Tag>}
          <Badge status={badgeStatus} text={<Text style={{ fontSize: 12 }}>{badgeText}</Text>} />
        </Space>
      }
      subtitle={
        detail?.last_update_ts ? (
          <span style={{ fontSize: 11, color: 'var(--ap-text-dim)' }}>
            最后更新: {dayjs(detail.last_update_ts).fromNow()}
          </span>
        ) : undefined
      }
      actions={
        detail ? (
          <StrategyActions
            nodeId={nodeId}
            engine={engine}
            name={name}
            capabilities={detail.capabilities}
            inited={detail.inited}
            trading={detail.trading}
            onEdit={() => setEditOpen(true)}
          />
        ) : undefined
      }
    >
      {detail?.mode === 'live' && (
        <Alert
          type="error"
          showIcon
          message="⚠ 实盘策略 — 真实账户操作请谨慎"
          description={detail.gateway_name ? `gateway: ${detail.gateway_name}` : undefined}
          style={{ marginBottom: 12 }}
        />
      )}
      {detail?.mode === 'sim' && (
        <Alert
          type="success"
          showIcon
          message={`🧪 模拟策略 (gateway: ${detail.gateway_name || '—'})`}
          description="本地撮合柜台，零真实下单。详见 vnpy_common/naming.py 命名约定。"
          style={{ marginBottom: 12 }}
          closable
        />
      )}

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
                  <CorpActionsCard
                    vtSymbols={(detail.positions || []).map((p) => p.vt_symbol)}
                    days={30}
                  />
                  <Card title="参数 / 运行时变量" style={{ marginTop: 16 }}>
                    <ResponsiveDescriptions
                      size="small"
                      bordered
                      columns={{ xxl: 3, xl: 2, lg: 2, md: 2, sm: 1, xs: 1 }}
                      items={Object.entries(detail.parameters || {}).map(([k, v]) => ({
                        key: `p-${k}`,
                        label: k,
                        value: (
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
                          background: 'var(--ap-panel-muted)',
                          color: 'var(--ap-text)',
                          border: '1px solid var(--ap-border-muted)',
                          padding: 12,
                          borderRadius: 6,
                          fontSize: 12,
                          margin: '4px 0 0 0',
                          overflowX: 'auto',
                          fontFamily: 'var(--ap-font-mono)',
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
    </PageContainer>
  )
}

export default LiveTradingStrategyDetailPage
