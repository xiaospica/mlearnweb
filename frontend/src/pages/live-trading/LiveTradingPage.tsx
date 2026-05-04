import React, { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Card,
  Empty,
  Segmented,
  Skeleton,
  Space,
} from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { tuningService } from '@/services/tuningService'
import { liveTradingService } from '@/services/liveTradingService'
import type { StrategySummary } from '@/types/liveTrading'
import StrategyCreateWizard from './components/StrategyCreateWizard'
import PageContainer from '@/components/layout/PageContainer'
import GlobalKpiStrip from './components/GlobalKpiStrip'
import FilterBar from './components/FilterBar'
import NodeSection from './components/NodeSection'
import { NowMsProvider } from './hooks/useNowMs'
import { useDensity } from './hooks/useDensity'
import { useNodeCollapse } from './hooks/useNodeCollapse'
import { useStrategyFilters } from './hooks/useStrategyFilters'
import {
  buildDownstreamCountMap,
  groupStrategiesByNode,
  summarizeStrategies,
} from './utils/groupByNode'
import { nextRunInMs, parseTimeOfDay } from './utils/scheduleParse'
import dayjs from 'dayjs'

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

  const [density, setDensity] = useDensity()
  const collapse = useNodeCollapse()
  const { filters, set: setFilters } = useStrategyFilters()

  // V3.9 工作台 → 实盘部署预填
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
      .catch(() => setWizardOpen(true))
      .finally(() => navigate(location.pathname, { replace: true, state: null }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const nodesQuery = useQuery({
    queryKey: ['live-nodes'],
    queryFn: () => liveTradingService.listNodes(),
    refetchInterval: 10000,
    staleTime: 0,
  })

  const nodes = nodesQuery.data?.data || []
  const allOffline = nodes.length > 0 && nodes.every((n) => !n.online)

  const strategiesQuery = useQuery({
    queryKey: ['live-strategies'],
    queryFn: () => liveTradingService.listStrategies(),
    refetchInterval: 5000,
    staleTime: 0,
    enabled: nodes.length === 0 ? true : !allOffline,  // 全离线时停止策略轮询，nodes 仍轮询以恢复
  })

  const allStrategies = strategiesQuery.data?.data || []
  const warning = strategiesQuery.data?.warning || null

  // 应用 filter / sort / search
  const visibleStrategies = useMemo(
    () => filterAndSort(allStrategies, filters),
    [allStrategies, filters],
  )

  const summary = useMemo(() => summarizeStrategies(allStrategies), [allStrategies])
  const groups = useMemo(
    () => groupStrategiesByNode(nodes, visibleStrategies),
    [nodes, visibleStrategies],
  )
  const downstreamCounts = useMemo(
    () => buildDownstreamCountMap(allStrategies),
    [allStrategies],
  )

  // 单节点退化：当用户实际只配了一个节点时，隐藏 NodeSectionHeader 直接平铺
  const singleNode = nodes.length <= 1

  // 跨卡片跳转（影子 → 上游）
  const handleJumpToStrategy = (name: string) => {
    const el = document.querySelector(`[data-strategy-name="${CSS.escape(name)}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.animate(
      [
        { boxShadow: '0 0 0 0 rgba(59, 130, 246, 0.6)' },
        { boxShadow: '0 0 0 6px rgba(59, 130, 246, 0)' },
      ],
      { duration: 1200, iterations: 2 },
    )
  }

  const handleCreateForNode = (nodeId: string) => {
    setWizardInitialValues({ nodeId })
    setWizardOpen(true)
  }

  return (
    <NowMsProvider>
      <PageContainer
        title="实盘交易"
        subtitle="跨节点策略汇总 · 5秒自动刷新"
        actions={
          <Space wrap>
            <Segmented
              size="small"
              value={density}
              onChange={(v) => setDensity(v as typeof density)}
              options={[
                { label: '舒适', value: 'comfort' },
                { label: '紧凑', value: 'compact' },
              ]}
            />
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
        <div style={{ marginBottom: 12 }}>
          <GlobalKpiStrip
            liveCount={summary.live}
            simCount={summary.sim}
            offlineCount={summary.offline}
            scheduleAlerts={summary.scheduleAlerts}
            totalEquity={summary.totalEquity}
            nodeOnline={nodes.filter((n) => n.online).length}
            nodeTotal={nodes.length}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <FilterBar
            filters={filters}
            setFilters={setFilters}
            nodes={nodes}
            liveCount={summary.live}
            simCount={summary.sim}
            offlineCount={summary.offline}
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

        {/* 状态分支 */}
        {strategiesQuery.isLoading && nodesQuery.isLoading ? (
          <Card>
            <Skeleton active paragraph={{ rows: 6 }} />
          </Card>
        ) : nodes.length === 0 ? (
          <Card>
            <Empty description="尚未注册 vnpy 节点；请检查 mlearnweb/backend/vnpy_nodes.yaml" />
          </Card>
        ) : visibleStrategies.length === 0 && allStrategies.length > 0 ? (
          <Card>
            <Empty description="无策略匹配当前过滤条件" />
          </Card>
        ) : groups.length === 0 ? (
          <Card>
            <Empty description="尚无策略。点击右上角『新建策略』开始" />
          </Card>
        ) : (
          groups.map((g) => (
            <NodeSection
              key={g.node.node_id}
              node={g.node}
              strategies={g.strategies}
              liveCount={g.liveCount}
              simCount={g.simCount}
              failedCount={g.failedCount}
              offlineCount={g.offlineCount}
              density={density}
              collapsed={collapse.isCollapsed(g.node.node_id)}
              onToggleCollapse={() => collapse.toggle(g.node.node_id)}
              downstreamCounts={downstreamCounts}
              onJumpToStrategy={handleJumpToStrategy}
              onCreateStrategy={handleCreateForNode}
              hideHeader={singleNode}
            />
          ))
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
    </NowMsProvider>
  )
}

/** 应用 filter + sort + search 全管线。 */
function filterAndSort(
  strategies: StrategySummary[],
  filters: ReturnType<typeof useStrategyFilters>['filters'],
): StrategySummary[] {
  let out = strategies

  // mode
  if (filters.mode !== 'all') {
    if (filters.mode === 'offline') out = out.filter((s) => s.node_offline)
    else out = out.filter((s) => s.mode === filters.mode || s.node_offline)
  }

  // node 多选
  if (filters.nodeIds.length > 0) {
    const set = new Set(filters.nodeIds)
    out = out.filter((s) => set.has(s.node_id))
  }

  // status
  if (filters.status !== 'all') {
    out = out.filter((s) => {
      if (s.node_offline) return false
      if (filters.status === 'running') return s.running
      if (filters.status === 'inited') return s.inited && !s.running
      if (filters.status === 'failed') return s.last_status === 'failed'
      if (filters.status === 'never_run') return !s.last_run_date
      return true
    })
  }

  // search
  const q = filters.search.trim().toLowerCase()
  if (q) {
    out = out.filter(
      (s) =>
        s.strategy_name.toLowerCase().includes(q) ||
        (s.vt_symbol ?? '').toLowerCase().includes(q),
    )
  }

  // sort
  const sorted = [...out]
  const now = dayjs()
  switch (filters.sort) {
    case 'name':
      sorted.sort((a, b) => a.strategy_name.localeCompare(b.strategy_name))
      break
    case 'equity':
      sorted.sort(
        (a, b) =>
          (b.strategy_value ?? -Infinity) - (a.strategy_value ?? -Infinity),
      )
      break
    case 'last_status':
      // failed > empty > null > ok
      sorted.sort((a, b) => statusRank(a.last_status) - statusRank(b.last_status))
      break
    case 'next_run':
    default:
      sorted.sort((a, b) => {
        const an = nextRunMinutes(a, now)
        const bn = nextRunMinutes(b, now)
        return an - bn
      })
      break
  }
  return sorted
}

function statusRank(s: StrategySummary['last_status']): number {
  if (s === 'failed') return 0
  if (s === 'empty') return 1
  if (!s) return 2
  return 3  // ok 排最后（最不需要关注）
}

function nextRunMinutes(s: StrategySummary, now: dayjs.Dayjs): number {
  const mins = [parseTimeOfDay(s.trigger_time), parseTimeOfDay(s.buy_sell_time)]
    .filter((v): v is number => v != null)
  const ms = nextRunInMs(mins, now)
  // 没有 schedule 的策略排到最后
  if (ms == null) return Number.MAX_SAFE_INTEGER
  return ms
}

export default LiveTradingPage
