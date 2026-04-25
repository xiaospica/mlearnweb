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
  direction: string
  volume: number
  price: number | null
  pnl: number | null
  yd_volume?: number | null
  frozen?: number | null
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
