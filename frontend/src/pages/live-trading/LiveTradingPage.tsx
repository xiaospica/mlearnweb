import React, { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { PlusOutlined, ReloadOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { tuningService } from '@/services/tuningService'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
import { liveTradingService } from '@/services/liveTradingService'
import type { SourceLabel, StrategySummary } from '@/types/liveTrading'
import MiniEquityChart from './components/MiniEquityChart'
import NodeStatusBar from './components/NodeStatusBar'
import StrategyActions from './components/StrategyActions'
import StrategyCreateWizard from './components/StrategyCreateWizard'
import PageContainer from '@/components/layout/PageContainer'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

const { Title, Text } = Typography

const SOURCE_LABEL_TEXT: Record<SourceLabel, string> = {
  strategy_pnl: '策略PnL',
  position_sum_pnl: '持仓浮盈',
  account_equity: '账户权益',
  unavailable: '无数据',
}

const SOURCE_LABEL_HELP: Record<SourceLabel, string> = {
  strategy_pnl: '从策略 variables 中的 PnL 字段直接读取',
  position_sum_pnl: '按 vt_symbol 聚合匹配持仓的浮动盈亏',
  account_equity: '账户总权益，多策略共享时为近似值',
  unavailable: '当前没有可用数据',
}

function fmtValue(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-'
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function valueColor(
  v: number | null | undefined,
  label: SourceLabel | null,
): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '#8c8c8c'
  // account_equity / strategy_pnl: absolute number, use neutral blue
  if (label === 'account_equity') return '#1677ff'
  // position_sum_pnl / strategy_pnl: signed value, red/green A-share convention
  if (v > 0) return '#f5222d'
  if (v < 0) return '#52c41a'
  return '#1f2937'
}

interface StrategyCardProps {
  item: StrategySummary
  onClick: () => void
}

const StrategyCard: React.FC<StrategyCardProps> = ({ item, onClick }) => {
  const label = (item.source_label || 'unavailable') as SourceLabel
  const isOffline = Boolean(item.node_offline)
  const badgeStatus: 'processing' | 'default' | 'warning' | 'error' =
    isOffline ? 'error' : item.running ? 'processing' : item.inited ? 'warning' : 'default'
  const badgeText = isOffline ? '节点离线' : item.running ? '运行中' : item.inited ? '已初始化' : '未初始化'

  // mode 视觉编码：实盘红色警示，模拟绿色，离线灰色
  const isLive = item.mode === 'live'
  const modeColor = isOffline ? '#8c8c8c' : isLive ? '#cf1322' : '#389e0d'
  const modeBg = isOffline ? '#f5f5f5' : isLive ? '#fff1f0' : '#f6ffed'
  const modeText = isOffline ? '离线' : isLive ? '实盘' : '模拟'
  const modeIcon = isOffline ? '🔌' : isLive ? '⚠' : '🧪'

  return (
    <Card
      hoverable
      onClick={onClick}
      style={{
        cursor: 'pointer',
        borderLeft: `4px solid ${modeColor}`,
      }}
      styles={{ body: { padding: '16px 18px' } }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: '#1f2937',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={item.strategy_name}
          >
            <span
              style={{
                display: 'inline-block',
                marginRight: 8,
                padding: '1px 8px',
                fontSize: 11,
                fontWeight: 600,
                color: modeColor,
                background: modeBg,
                border: `1px solid ${modeColor}`,
                borderRadius: 3,
                verticalAlign: 'middle',
              }}
              title={item.gateway_name ? `gateway: ${item.gateway_name}` : '未识别 gateway'}
            >
              {modeIcon} {modeText}
            </span>
            {item.strategy_name}
          </div>
          <Space size={4} style={{ marginTop: 4 }}>
            <Tag color="geekblue" style={{ margin: 0 }}>
              {item.node_id}
            </Tag>
            <Tag color="purple" style={{ margin: 0 }}>
              {item.engine}
            </Tag>
            {item.class_name && (
              <Tag style={{ margin: 0 }}>{item.class_name}</Tag>
            )}
          </Space>
        </div>
        <Badge status={badgeStatus} text={<Text style={{ fontSize: 12 }}>{badgeText}</Text>} />
      </div>

      <div style={{ marginTop: 14 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {SOURCE_LABEL_TEXT[label]}{' '}
              <Tooltip title={SOURCE_LABEL_HELP[label]}>
                <InfoCircleOutlined style={{ fontSize: 10 }} />
              </Tooltip>
            </Text>
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: valueColor(item.strategy_value, label),
                fontFamily: "'SF Mono', 'Consolas', monospace",
              }}
            >
              {fmtValue(item.strategy_value)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              持仓 {item.positions_count}
            </Text>
            <div style={{ fontSize: 11, color: '#8c8c8c' }}>
              {item.last_update_ts ? dayjs(item.last_update_ts).fromNow() : '-'}
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, height: 40 }}>
        <MiniEquityChart points={item.mini_curve} height={40} />
      </div>

      <div style={{ marginTop: 12 }}>
        <StrategyActions
          nodeId={item.node_id}
          engine={item.engine}
          name={item.strategy_name}
          capabilities={item.capabilities}
          inited={item.inited}
          trading={item.trading}
          compact
        />
      </div>
    </Card>
  )
}

type ModeFilter = 'all' | 'live' | 'sim'

const LiveTradingPage: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardInitialValues, setWizardInitialValues] = useState<{
    nodeId?: string
    engine?: string
    className?: string
    strategy_name?: string
    vt_symbol?: string
    settingOverrides?: Record<string, unknown>
  } | undefined>(undefined)
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')

  // V3.9: 工作台 DeployModal 跳转过来时 location.state 携带 prefillFromTuningJob
  // 拉 manifest → 预填 wizard → 自动打开
  useEffect(() => {
    const state = location.state as
      | { prefillFromTuningJob?: number; prefillNodeId?: string; prefillEngine?: string; prefillStrategyName?: string; prefillVtSymbol?: string }
      | null
    if (!state?.prefillFromTuningJob) return
    const jobId = state.prefillFromTuningJob
    tuningService
      .getDeploymentManifest(jobId)
      .then((resp) => {
        const m = resp.data
        setWizardInitialValues({
          nodeId: state.prefillNodeId,
          engine: state.prefillEngine,
          className: undefined,  // 让用户自己选（class 跟 engine 强相关）
          strategy_name: state.prefillStrategyName,
          vt_symbol: state.prefillVtSymbol,
          settingOverrides: {
            mlflow_run_id: m.mlflow_run_id,
            bundle_dir: m.bundle_dir,
            tuning_job_id: m.tuning_job_id,
            training_record_id: m.training_record_id,
          },
        })
        setWizardOpen(true)
      })
      .catch(() => {
        // 失败让用户手动新建
        setWizardOpen(true)
      })
      .finally(() => {
        // 清掉 state 防 reload 重复触发
        navigate(location.pathname, { replace: true, state: null })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const nodesQuery = useQuery({
    queryKey: ['live-nodes'],
    queryFn: () => liveTradingService.listNodes(),
    refetchInterval: 10000,
    staleTime: 0,
  })

  const strategiesQuery = useQuery({
    queryKey: ['live-strategies'],
    queryFn: () => liveTradingService.listStrategies(),
    refetchInterval: 5000,
    staleTime: 0,
  })

  const nodes = nodesQuery.data?.data || []
  const allStrategies = strategiesQuery.data?.data || []
  const strategies = modeFilter === 'all'
    ? allStrategies
    : allStrategies.filter((s) => s.mode === modeFilter)
  const liveCount = allStrategies.filter((s) => s.mode === 'live').length
  const simCount = allStrategies.filter((s) => s.mode === 'sim').length
  const warning = strategiesQuery.data?.warning || null
  const allOffline = nodes.length > 0 && nodes.every((n) => !n.online)

  return (
    <PageContainer
      title="实盘交易"
      subtitle="跨节点策略汇总 · 5秒自动刷新"
      actions={
        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              nodesQuery.refetch()
              strategiesQuery.refetch()
            }}
          >
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setWizardOpen(true)}
            disabled={nodes.filter((n) => n.online).length === 0}
          >
            新建策略
          </Button>
        </Space>
      }
    >

      <Card styles={{ body: { padding: '12px 16px' } }} style={{ marginBottom: 12 }}>
        <NodeStatusBar nodes={nodes} />
      </Card>

      <div style={{ marginBottom: 12 }}>
        <Segmented
          value={modeFilter}
          onChange={(v) => setModeFilter(v as ModeFilter)}
          options={[
            { label: `全部 (${allStrategies.length})`, value: 'all' },
            { label: `⚠ 实盘 (${liveCount})`, value: 'live' },
            { label: `🧪 模拟 (${simCount})`, value: 'sim' },
          ]}
        />
      </div>

      {allOffline && (
        <Alert
          type="error"
          showIcon
          message="所有 vnpy 节点均不可达"
          description="请检查 SSH 隧道 / vnpy_webtrader 是否启动"
          style={{ marginBottom: 12 }}
        />
      )}

      {warning && (
        <Alert
          type="warning"
          showIcon
          message={warning}
          style={{ marginBottom: 12 }}
          closable
        />
      )}

      {strategiesQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      ) : strategies.length === 0 ? (
        <Card>
          <Empty description="尚无策略。点击右上角『新建策略』开始" />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {strategies.map((s) => (
            <Col key={`${s.node_id}-${s.engine}-${s.strategy_name}`} xs={24} md={12} xl={8}>
              <StrategyCard
                item={s}
                onClick={() =>
                  navigate(
                    `/live-trading/${encodeURIComponent(s.node_id)}/${encodeURIComponent(s.engine)}/${encodeURIComponent(s.strategy_name)}`,
                  )
                }
              />
            </Col>
          ))}
        </Row>
      )}

      <StrategyCreateWizard
        open={wizardOpen}
        onClose={() => {
          setWizardOpen(false)
          setWizardInitialValues(undefined)
        }}
        nodes={nodes}
        initialValues={wizardInitialValues}
      />
    </PageContainer>
  )
}

export default LiveTradingPage
