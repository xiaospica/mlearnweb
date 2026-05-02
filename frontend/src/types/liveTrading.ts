// Types for the live-trading module. Intentionally a separate file (not
// merged into types/index.ts) so the research and live modules stay
// decoupled.

export interface NodeStatus {
  node_id: string
  base_url: string
  enabled: boolean
  online: boolean
  last_probe_ts?: number | null
  last_error?: string | null
}

export interface EquityPoint {
  ts: number
  strategy_value: number | null
  account_equity: number | null
  source_label: SourceLabel | null
}

export type SourceLabel =
  | 'strategy_pnl'
  | 'position_sum_pnl'
  | 'account_equity'
  | 'unavailable'

export interface LivePosition {
  vt_symbol: string
  name?: string  // 股票中文简称
  direction: string
  volume: number
  price: number | null
  pnl: number | null
  yd_volume?: number | null
  frozen?: number | null
  market_value?: number  // 后端算: volume × cost_price + pnl
  weight?: number        // 后端算: market_value / total_market_value (持仓占比)
}

/** 历史持仓快照 (从 sim_trades 重建任意 yyyymmdd EOD 持仓) */
export interface HistoricalPosition {
  vt_symbol: string
  name?: string | null
  volume: number
  cost_price: number  // 含 settle 阶段 pct_chg 累乘的 mark price
  market_value: number  // volume × cost_price
  weight: number  // 持仓内部 sum=1
}

export interface DeleteRecordsStats {
  equity_snapshots: number
  ml_metric_snapshots: number
}

export interface StrategyTrade {
  vt_symbol: string
  name?: string  // 股票中文简称
  tradeid: string
  orderid: string
  direction: string
  offset: string
  price: number
  volume: number
  datetime: string
  reference: string
}

export interface CorpActionEvent {
  vt_symbol: string
  name: string
  trade_date: string  // yyyy-mm-dd
  pct_chg: number          // 复权涨跌幅 (%)
  raw_change_pct: number   // 原始 close 涨跌幅 (%)
  magnitude_pct: number    // 二者绝对差 (%)，越大越显著
  pre_close: number
  close: number
}

export type StrategyMode = 'live' | 'sim'

export interface StrategySummary {
  node_id: string
  engine: string
  strategy_name: string
  class_name: string | null
  vt_symbol: string | null
  author: string | null
  inited: boolean
  trading: boolean
  running: boolean
  strategy_value: number | null
  source_label: SourceLabel | null
  account_equity: number | null
  positions_count: number
  last_update_ts: number | null
  mini_curve: EquityPoint[]
  capabilities: StrategyCapability[]
  // 实盘 / 模拟 标识（详见 vnpy_common/naming.py 命名约定）；离线时为 null
  mode: StrategyMode | null
  gateway_name: string | null
  // 节点离线时为 true，从 mlearnweb.db 历史快照拼出
  node_offline?: boolean
  offline_reason?: string
}

export type StrategyCapability = 'add' | 'edit' | 'init' | 'remove' | 'start' | 'stop'

export interface StrategyDetail extends StrategySummary {
  parameters: Record<string, unknown>
  variables: Record<string, unknown>
  curve: EquityPoint[]
  positions: LivePosition[]
}

export interface StrategyEngineInfo {
  app_name: string
  display_name: string | null
  event_type: string | null
  capabilities: StrategyCapability[]
}

export interface StrategyCreatePayload {
  engine: string
  class_name: string
  strategy_name: string
  vt_symbol?: string | null
  setting: Record<string, unknown>
}

export interface StrategyEditPayload {
  setting: Record<string, unknown>
}

export interface LiveTradingResponse<T> {
  success: boolean
  message?: string
  data: T
  warning?: string | null
}
