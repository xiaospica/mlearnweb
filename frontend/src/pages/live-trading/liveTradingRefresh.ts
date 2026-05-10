import type { QueryClient } from '@tanstack/react-query'
import type { LiveTradingEvent, LiveTradingQueryGroup } from '@/types/liveTrading'

export const LIVE_NODES_FALLBACK_REFRESH_MS = 30_000
export const LIVE_STRATEGIES_FALLBACK_REFRESH_MS = 30_000
export const LIVE_DETAIL_FALLBACK_REFRESH_MS = 30_000
export const LIVE_SUMMARY_FALLBACK_REFRESH_MS = 30_000
export const LIVE_TRADES_FALLBACK_REFRESH_MS = 30_000
export const LIVE_RISK_FALLBACK_REFRESH_MS = 30_000
export const ML_MONITOR_FALLBACK_REFRESH_MS = 180_000
export const ML_MONITOR_STALE_MS = 30_000
export const HISTORY_POSITION_DATES_STALE_MS = 300_000
export const HISTORY_QUERY_STALE_MS = 60_000
export const HISTORY_POSITIONS_STALE_MS = HISTORY_QUERY_STALE_MS
export const CORP_ACTIONS_REFRESH_MS = 5 * 60 * 1000
export const CORP_ACTIONS_STALE_MS = 60_000

export const liveTradingQueryKeys = {
  nodes: () => ['live-nodes'] as const,
  strategies: () => ['live-strategies'] as const,
  strategyDetail: (nodeId: string, engine: string, strategyName: string) =>
    ['live-strategy', nodeId, engine, strategyName] as const,
  strategyPerformanceSummary: (nodeId: string, engine: string, strategyName: string) =>
    ['live-strategy-performance-summary', nodeId, engine, strategyName] as const,
  trades: (nodeId: string, engine: string, strategyName: string) =>
    ['live-trades', nodeId, engine, strategyName] as const,
  orders: (nodeId: string, engine: string, strategyName: string) =>
    ['live-orders', nodeId, engine, strategyName] as const,
  riskEvents: (nodeId: string, engine: string, strategyName: string) =>
    ['live-risk-events', nodeId, engine, strategyName] as const,
  mlTopkLatest: (nodeId: string, strategyName: string) =>
    ['ml-topk-latest', nodeId, strategyName] as const,
  mlMetricsHistory: (nodeId: string, strategyName: string) =>
    ['ml-metrics-history', nodeId, strategyName] as const,
  mlMetricsRolling: (nodeId: string, strategyName: string) =>
    ['ml-metrics-rolling', nodeId, strategyName] as const,
  mlPredictionLatest: (nodeId: string, strategyName: string) =>
    ['ml-prediction-latest', nodeId, strategyName] as const,
  mlPredictionByDate: (nodeId: string, strategyName: string, yyyymmdd: string | null) =>
    ['ml-prediction-by-date', nodeId, strategyName, yyyymmdd] as const,
  mlPredictionAll: (nodeId: string, strategyName: string, yyyymmdd: string | null) =>
    ['ml-prediction-all', nodeId, strategyName, yyyymmdd] as const,
  historicalPositionDates: (
    nodeId: string,
    engine: string,
    strategyName: string,
    gatewayName?: string,
  ) => ['historical-position-dates', nodeId, engine, strategyName, gatewayName ?? ''] as const,
  historicalPositions: (
    nodeId: string,
    engine: string,
    strategyName: string,
    yyyymmdd: string,
    gatewayName?: string,
  ) => ['historical-positions', nodeId, engine, strategyName, yyyymmdd, gatewayName ?? ''] as const,
  corpActions: (sortedVtSymbols: string, days: number) =>
    ['live-corp-actions', sortedVtSymbols, days] as const,
}

interface LiveStrategyIdentity {
  nodeId: string
  engine: string
  strategyName: string
}

export async function invalidateLiveStrategyDetailQueries(
  queryClient: QueryClient,
  { nodeId, engine, strategyName }: LiveStrategyIdentity,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.strategyDetail(nodeId, engine, strategyName),
    }),
    queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.strategyPerformanceSummary(nodeId, engine, strategyName),
    }),
    queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.trades(nodeId, engine, strategyName),
    }),
    queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.riskEvents(nodeId, engine, strategyName),
    }),
    queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.mlTopkLatest(nodeId, strategyName),
    }),
    queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.mlMetricsHistory(nodeId, strategyName),
    }),
    queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.mlMetricsRolling(nodeId, strategyName),
    }),
    queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.mlPredictionLatest(nodeId, strategyName),
    }),
  ])
}

export function liveFallbackInterval(eventsConnected: boolean, intervalMs: number): number | false {
  return eventsConnected ? false : intervalMs
}

async function invalidateIdentityGroup(
  queryClient: QueryClient,
  group: LiveTradingQueryGroup,
  event: LiveTradingEvent,
): Promise<void> {
  const nodeId = event.node_id || ''
  const engine = event.engine || ''
  const strategyName = event.strategy_name || ''
  const hasIdentity = !!(nodeId && engine && strategyName)

  if (group === 'nodes') {
    await queryClient.invalidateQueries({ queryKey: liveTradingQueryKeys.nodes() })
    return
  }
  if (group === 'strategy_list') {
    await queryClient.invalidateQueries({ queryKey: liveTradingQueryKeys.strategies() })
    return
  }
  if (group === 'corp_actions') {
    await queryClient.invalidateQueries({ queryKey: ['live-corp-actions'] })
    return
  }
  if (!hasIdentity) return

  if (group === 'strategy_detail') {
    await queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.strategyDetail(nodeId, engine, strategyName),
    })
  } else if (group === 'performance_summary') {
    await queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.strategyPerformanceSummary(nodeId, engine, strategyName),
    })
  } else if (group === 'trades') {
    await queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.trades(nodeId, engine, strategyName),
    })
    await queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.orders(nodeId, engine, strategyName),
    })
  } else if (group === 'risk_events') {
    await queryClient.invalidateQueries({
      queryKey: liveTradingQueryKeys.riskEvents(nodeId, engine, strategyName),
    })
  } else if (group === 'ml_latest') {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: liveTradingQueryKeys.mlTopkLatest(nodeId, strategyName) }),
      queryClient.invalidateQueries({ queryKey: liveTradingQueryKeys.mlPredictionLatest(nodeId, strategyName) }),
    ])
  } else if (group === 'ml_metrics') {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: liveTradingQueryKeys.mlMetricsHistory(nodeId, strategyName) }),
      queryClient.invalidateQueries({ queryKey: liveTradingQueryKeys.mlMetricsRolling(nodeId, strategyName) }),
    ])
  } else if (group === 'history_dates') {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['historical-position-dates', nodeId, engine, strategyName],
      }),
      queryClient.invalidateQueries({
        queryKey: ['ml-prediction-by-date', nodeId, strategyName],
      }),
      queryClient.invalidateQueries({
        queryKey: ['ml-prediction-all', nodeId, strategyName],
      }),
    ])
  }
}

export async function invalidateLiveTradingEventQueries(
  queryClient: QueryClient,
  event: LiveTradingEvent,
): Promise<void> {
  const groups = Array.from(new Set(event.query_groups || []))
  await Promise.all(groups.map((group) => invalidateIdentityGroup(queryClient, group, event)))
}

export async function invalidateLiveStrategyMutationQueries(
  queryClient: QueryClient,
  identity: LiveStrategyIdentity,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: liveTradingQueryKeys.strategies() }),
    invalidateLiveStrategyDetailQueries(queryClient, identity),
  ])
}
