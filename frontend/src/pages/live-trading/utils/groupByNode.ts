import type { NodeStatus, StrategySummary } from '@/types/liveTrading'

export interface NodeGroup {
  node: NodeStatus
  strategies: StrategySummary[]
  liveCount: number
  simCount: number
  failedCount: number
  offlineCount: number
}

/**
 * 按 node_id 把策略分到对应节点；同时算出每节点 mode/状态聚合统计，给 NodeSectionHeader 直接用。
 *
 * - mlearnweb.db 历史快照里可能存在节点未在 nodes 列表中（yaml 删除后还有遗留）
 *   → 这种策略归到一个虚拟「未注册节点」组，mode 视为 offline。
 * - 节点存在但当前没有任何策略 → 仍返回该 group（strategies=[]），让前端能渲染节点 header + 「在此节点新建」CTA。
 */
export function groupStrategiesByNode(
  nodes: NodeStatus[],
  strategies: StrategySummary[],
): NodeGroup[] {
  const byNode = new Map<string, StrategySummary[]>()
  for (const s of strategies) {
    const arr = byNode.get(s.node_id) ?? []
    arr.push(s)
    byNode.set(s.node_id, arr)
  }

  const result: NodeGroup[] = nodes.map((node) => {
    const list = byNode.get(node.node_id) ?? []
    byNode.delete(node.node_id)
    return buildGroup(node, list)
  })

  // 兜底：节点不在 yaml 注册但 db 里还有历史策略
  for (const [nodeId, list] of byNode.entries()) {
    if (list.length === 0) continue
    const ghost: NodeStatus = {
      node_id: nodeId,
      base_url: '',
      enabled: false,
      online: false,
      last_probe_ts: null,
      last_error: '节点未在 vnpy_nodes.yaml 注册（仅展示历史快照）',
      mode: null,
      latency_ms: null,
      app_version: null,
    }
    result.push(buildGroup(ghost, list))
  }

  return result
}

function buildGroup(node: NodeStatus, list: StrategySummary[]): NodeGroup {
  let liveCount = 0
  let simCount = 0
  let failedCount = 0
  let offlineCount = 0
  for (const s of list) {
    if (s.node_offline) offlineCount += 1
    else if (s.mode === 'live') liveCount += 1
    else if (s.mode === 'sim') simCount += 1
    if (s.last_status === 'failed') failedCount += 1
  }
  return { node, strategies: list, liveCount, simCount, failedCount, offlineCount }
}

/** 全局 KPI strip 用：直接把所有策略汇总成一个对象，避免页面层重复计算。 */
export function summarizeStrategies(strategies: StrategySummary[]) {
  let live = 0
  let sim = 0
  let offline = 0
  let scheduleAlerts = 0
  let totalEquity = 0
  let totalEquityHit = false
  for (const s of strategies) {
    if (s.node_offline) offline += 1
    else if (s.mode === 'live') live += 1
    else if (s.mode === 'sim') sim += 1
    if (s.last_status === 'failed') scheduleAlerts += 1
    // 总权益用 strategy_value（已含 fallback chain），离线策略不计
    if (!s.node_offline && typeof s.strategy_value === 'number' && Number.isFinite(s.strategy_value)) {
      totalEquity += s.strategy_value
      totalEquityHit = true
    }
  }
  return {
    live,
    sim,
    offline,
    scheduleAlerts,
    total: strategies.length,
    totalEquity: totalEquityHit ? totalEquity : null,
  }
}

/** 反向扫描 signal_source_strategy → upstream_name。给上游策略卡片显示「🔗 N」用。 */
export function buildDownstreamCountMap(strategies: StrategySummary[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const s of strategies) {
    const parent = s.signal_source_strategy
    if (!parent) continue
    map.set(parent, (map.get(parent) ?? 0) + 1)
  }
  return map
}
