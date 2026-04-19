import apiClient from './apiClient'
import type { LiveTradingResponse } from '@/types/liveTrading'

// Shape notes:
//   Matches the payloads produced by
//   qlib_strategy_core.cli.run_inference (metrics.json / diagnostics.json)
//   and the mlearnweb ml_aggregation_service roll-up shapes.

export interface PsiByFeature {
  [feature: string]: number
}

export interface HistogramBin {
  bin_id: number
  edge_lo: number
  edge_hi: number
  count: number
  probability: number
}

export interface MetricSnapshot {
  node_id: string
  engine: string
  strategy_name: string
  trade_date: string | null
  ic: number | null
  rank_ic: number | null
  psi_mean: number | null
  psi_max: number | null
  psi_n_over_0_25: number | null
  psi_by_feature: PsiByFeature | null
  ks_by_feature: PsiByFeature | null
  pred_mean: number | null
  pred_std: number | null
  pred_zero_ratio: number | null
  n_predictions: number | null
  feat_missing: Record<string, number> | null
  model_run_id: string | null
  core_version: string | null
  status: string | null
}

export interface RollingSummary {
  node_id: string
  strategy_name: string
  window: number
  icir_30d: { window: number; icir: number | null; ic_mean: number | null; ic_std: number | null; n_samples: number }
  icir_60d: { window: number; icir: number | null; ic_mean: number | null; ic_std: number | null; n_samples: number }
  psi_alert: {
    triggered: boolean
    threshold: number
    consecutive_days: number
    last_streak_days: number
    max_streak_days: number
    first_alert_date: string | null
  }
  history_count: number
}

export interface TopkEntry {
  instrument?: string
  score?: number
  rank?: number
  [key: string]: unknown
}

export interface PredictionSummary {
  node_id?: string
  engine?: string
  strategy_name?: string
  trade_date: string | null
  topk: TopkEntry[]
  score_histogram: HistogramBin[]
  n_symbols: number | null
  coverage_ratio: number | null
  pred_mean: number | null
  pred_std: number | null
  model_run_id: string | null
  status: string | null
}

export interface MlHealthItem {
  node_id: string
  ok: boolean
  error: string | null
  strategies: Array<{
    name: string
    last_run_date: string
    last_status: string
    last_error: string
    last_model_run_id: string
    last_n_pred: number
    last_duration_ms: number
  }>
}

function enc(s: string): string {
  return encodeURIComponent(s)
}

export const mlMonitoringService = {
  /** Historical per-day metrics (from SQLite, populated by ml_snapshot_loop). */
  metricsHistory(
    nodeId: string,
    strategyName: string,
    days = 30,
  ): Promise<LiveTradingResponse<MetricSnapshot[]>> {
    return apiClient
      .get(`/live-trading/ml/${enc(nodeId)}/${enc(strategyName)}/metrics/history`, {
        params: { days },
      })
      .then((r) => r.data)
  },

  /** ICIR + PSI trend alerts — main call for Tab2. */
  metricsRolling(
    nodeId: string,
    strategyName: string,
    window = 30,
  ): Promise<LiveTradingResponse<RollingSummary>> {
    return apiClient
      .get(`/live-trading/ml/${enc(nodeId)}/${enc(strategyName)}/metrics/rolling`, {
        params: { window },
      })
      .then((r) => r.data)
  },

  /** Per-day prediction summary (topk + histogram), from SQLite. */
  predictionByDate(
    nodeId: string,
    strategyName: string,
    yyyymmdd: string,
  ): Promise<LiveTradingResponse<PredictionSummary>> {
    return apiClient
      .get(
        `/live-trading/ml/${enc(nodeId)}/${enc(strategyName)}/prediction/summary/${enc(yyyymmdd)}`,
      )
      .then((r) => r.data)
  },

  /** Realtime pass-through to vnpy node (bypasses SQLite cache). */
  metricsLatest(
    nodeId: string,
    strategyName: string,
  ): Promise<LiveTradingResponse<MetricSnapshot>> {
    return apiClient
      .get(`/live-trading/ml/${enc(nodeId)}/${enc(strategyName)}/metrics/latest`)
      .then((r) => r.data)
  },

  predictionLatestSummary(
    nodeId: string,
    strategyName: string,
  ): Promise<LiveTradingResponse<PredictionSummary>> {
    return apiClient
      .get(`/live-trading/ml/${enc(nodeId)}/${enc(strategyName)}/prediction/latest/summary`)
      .then((r) => r.data)
  },

  globalHealth(): Promise<LiveTradingResponse<MlHealthItem[]>> {
    return apiClient.get('/live-trading/ml/health').then((r) => r.data)
  },
}

export default mlMonitoringService
