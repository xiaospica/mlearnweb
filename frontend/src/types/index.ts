export interface Experiment {
  experiment_id: string
  name: string
  creation_time?: number | null
  run_count: number
  lifecycle_stage: string
}

export interface RunListItem {
  run_id: string
  run_name: string
  status: string
  status_code: number
  start_time: number | null
  end_time: number | null
  lifecycle_stage: string
}

export interface RunDetail {
  run_id: string
  run_name: string
  status: string
  start_time: number | null
  end_time: number | null
  duration_seconds: number | null
  params: Record<string, unknown>
  metrics: Record<string, unknown>
  tags: Record<string, string>
  artifacts: Array<{ path: string; size_kb: number; type: string }>
}

export interface KeyMetrics {
  annualized_return?: number | null
  max_drawdown?: number | null
  icir?: number | null
  mean_ic?: number | null
  information_ratio?: number | null
  rank_ic?: number | null
  l2_train?: number | null
  l2_valid?: number | null
  [key: string]: unknown
}

export interface ReportData {
  run_info: {
    run_id: string
    run_name: string
    status: string
    start_time: number | null
    end_time: number | null
    duration_seconds: number | null
  }
  key_metrics: KeyMetrics
  model_params: Record<string, unknown>
  portfolio_data: {
    available: boolean
    dates?: string[]
    cumulative_return?: Record<string, number[]>
    drawdown?: Record<string, number[]>
    turnover?: number[]
    daily_return?: Record<string, number[]>
    excess_return?: number[]
  }
  ic_analysis: {
    available: boolean
    ic_series?: { dates: string[]; values: (number | null)[] }
    ric_series?: { dates: string[]; values: (number | null)[] }
    summary?: { mean_ic: number | null; std_ic: number | null; ir: number | null; hit_rate: number | null }
  }
  risk_metrics: {
    available: boolean
    metrics?: Record<string, number>
    source?: string
  }
  prediction_stats: {
    available: boolean
    stats?: Record<string, number>
    histogram?: { counts: number[]; bin_edges: number[]; bin_centers: number[] }
  }
  pred_label_data?: {
    available: boolean
    labels?: number[]
    scores?: number[]
    correlation?: number
    count?: number
  }
  rolling_stats?: {
    available: boolean
    dates?: string[]
    rolling_return?: (number | null)[]
    rolling_volatility?: (number | null)[]
    rolling_sharpe?: (number | null)[]
  }
  monthly_returns?: {
    available: boolean
    monthly_list?: Array<{ month: string; year: number; month_num: number; return: number }>
    years?: number[]
    months?: string[]
    heatmap_data?: Array<[number, number, number]>
    histogram?: { values: number[]; labels: string[] }
  }
  annual_returns?: {
    available: boolean
    annual_returns?: Record<string, number>
    benchmark_annual_returns?: Record<string, number>
    annual_list?: Array<{ year: number; return: number }>
  }
  qlib_analysis?: {
    available: boolean
    report_data?: {
      dates: string[]
      return?: number[]
      cum_return?: number[]
      bench?: number[]
      cum_bench?: number[]
      turnover?: number[]
    }
    analysis_metrics?: Record<string, number>
    pred_label_data?: {
      available: boolean
      count: number
      label_mean: number
      label_std: number
      score_mean: number
      score_std: number
      correlation: number | null
    }
    ic_analysis?: {
      available: boolean
      ic_series?: Array<{ date: string; ic: number }>
      ic_mean?: number
      ic_std?: number
      icir?: number
      ic_positive_ratio?: number
    }
    score_distribution?: {
      available: boolean
      mean?: number
      std?: number
      min?: number
      max?: number
      median?: number
      skewness?: number
      kurtosis?: number
      histogram?: {
        counts: number[]
        bins: number[]
      }
    }
  }
  all_metrics_raw: Record<string, unknown>
  tags: Record<string, string>
}

// Phase 3B: 训练记录的部署追踪。详见 vnpy_common/naming.py 命名约定。
export interface TrainingDeployment {
  node_id: string
  engine: string
  strategy_name: string
  mode: 'live' | 'sim'
  gateway_name: string
  run_id: string
  bundle_dir: string
  first_seen_at: string
  last_seen_at: string
  active: boolean
}

export interface TrainingRecord {
  id: number
  name: string
  description: string | null
  experiment_id: string
  experiment_name: string | null
  run_ids: string[]
  run_count: number
  config_snapshot: Record<string, unknown> | null
  status: string
  started_at: string | null
  completed_at: string | null
  duration_seconds: number | null
  command_line: string | null
  hostname: string | null
  python_version: string | null
  summary_metrics: Record<string, unknown> | null
  tags: string[]
  category: string | null
  memo: string | null
  group_name: string
  is_favorite: boolean
  deployments: TrainingDeployment[]
  created_at: string | null
  updated_at: string | null
  run_mappings?: RunMapping[]
  cumulative_return_preview?: {
    values: number[]
    final_return: number
    total_points: number
  }
}

export interface RunMapping {
  id: number
  run_id: string
  rolling_index: number | null
  segment_label: string | null
  train_start: string | null
  train_end: string | null
  valid_start: string | null
  valid_end: string | null
  test_start: string | null
  test_end: string | null
}

export type ApiSuccessResponse<T> = {
  success: true
  message?: string
  data: T
}

/**
 * QLib Plotly 图表数据结构
 */
export interface PlotlyFigure {
  data: Array<Record<string, unknown>>
  layout: Record<string, unknown>
}

export interface QLibFiguresData {
  available: boolean
  report_figures?: PlotlyFigure[]
  risk_figures?: PlotlyFigure[]
  ic_figures?: PlotlyFigure[]
  model_figures?: PlotlyFigure[]
}

export interface InsampleLayeredSegment {
  available: boolean
  sample_count?: number
  time_range?: [string, string] | null
  figures?: PlotlyFigure[]
  error?: string
  detail?: string
}

export interface InsampleLayeredData {
  available: boolean
  segments: Record<string, InsampleLayeredSegment>
  error?: string
  detail?: string
}

export interface TrainingCompareMergedReport {
  available: boolean
  dates: string[]
  total_days?: number
  cumulative_return: number[]
  daily_return: number[]
  run_boundaries?: Array<{ start_date: string; end_date: string; run_index: number | null; segment_label: string | null }>
  benchmark_cum_return?: number[]
  daily_benchmark?: number[]
  turnover?: number[]
}

export interface TrainingCompareMergedMetrics {
  available?: boolean
  total_trading_days?: number
  total_return?: number
  annualized_return?: number
  mean_daily_return?: number
  std_daily_return?: number
  max_drawdown?: number
  sharpe_ratio?: number | null
  sortino_ratio?: number
  calmar_ratio?: number | null
  win_rate?: number
  profit_loss_ratio?: number | null
  max_single_day_gain?: number
  max_single_day_loss?: number
  number_of_runs?: number
  excess_annualized_return?: number
  tracking_error?: number
  information_ratio?: number | null
  [key: string]: unknown
}

export interface TrainingCompareICAnalysis {
  available: boolean
  dates?: string[]
  ic_values?: (number | null)[]
  rank_ic_values?: (number | null)[]
  mean_ic?: number
  mean_rank_ic?: number
  ic_std?: number
  icir?: number
  [key: string]: unknown
}

export interface TrainingCompareRecord {
  id: number
  available: boolean
  name?: string
  category?: string
  experiment_id?: string
  experiment_name?: string
  status?: string
  summary_metrics?: Record<string, unknown>
  config_snapshot?: Record<string, unknown>
  tags?: string[]
  merged_report?: TrainingCompareMergedReport | null
  merged_metrics?: TrainingCompareMergedMetrics | null
  ic_analysis?: TrainingCompareICAnalysis | null
  monthly_returns?: Record<string, unknown> | null
  annual_returns?: Record<string, unknown> | null
  rolling_stats?: Record<string, unknown> | null
  individual_runs?: Array<{
    run_id: string
    rolling_index: number | null
    segment_label: string | null
    test_range: string
    data_points: number
  }>
  error?: string
}

export interface TrainingCompareData {
  records: TrainingCompareRecord[]
}

export interface InSampleSegmentResult {
  pred_shape?: number[]
  n_stocks?: number
  time_range?: [string, string]
  risk_metrics: {
    available: boolean
    total_days?: number
    total_return?: number
    annualized_return?: number
    annualized_volatility?: number
    sharpe_ratio?: number
    max_drawdown?: number
    mean_daily_return?: number
    std_daily_return?: number
    win_rate?: number
    excess_annualized_return?: number
    information_ratio?: number
    mean_turnover?: number
    [key: string]: unknown
  }
  indicator_dict?: Record<string, unknown>
  portfolio_data?: {
    available: boolean
    dates?: string[]
    cumulative_return?: {
      strategy?: number[]
      benchmark?: number[]
    }
    drawdown?: {
      strategy?: number[]
      benchmark?: number[]
    }
    daily_return?: {
      strategy?: number[]
    }
    turnover?: number[]
  }
  daily_return_distribution?: {
    available: boolean
    mean?: number
    std?: number
    min?: number
    max?: number
    median?: number
    skewness?: number
    kurtosis?: number
    positive_ratio?: number
    negative_days?: number
    count?: number
    histogram?: {
      counts: number[]
      bins: number[]
      bin_centers: number[]
    }
  }
  ic_analysis?: {
    available: boolean
    dates?: string[]
    ic_values?: number[]
    mean_ic?: number
    std_ic?: number
    icir?: number
    hit_rate?: number
    rolling_icir?: (number | null)[]
    rolling_window?: number
  }
  rank_ic_analysis?: {
    available: boolean
    dates?: string[]
    rank_ic_values?: number[]
    mean_rank_ic?: number
    std_rank_ic?: number
    rank_icir?: number
    hit_rate?: number
    rolling_rank_icir?: (number | null)[]
    rolling_window?: number
  }
  pred_label_data?: {
    available: boolean
    scores?: number[]
    labels?: number[]
    correlation?: number
    count?: number
    score_mean?: number
    score_std?: number
    label_mean?: number
    label_std?: number
    score_histogram?: {
      counts: number[]
      bins: number[]
      bin_centers: number[]
    }
    label_histogram?: {
      counts: number[]
      bins: number[]
      bin_centers: number[]
    }
  }
  lag_ic?: LagICAnalysis
  holdings_analysis?: HoldingsAnalysis
  position_analysis?: {
    available: boolean
    error?: string
    dates?: string[]
    num_stocks?: number[]
    max_weights?: number[]
    min_weights?: number[]
  }
}

export interface LagICResult {
  mean_ic: number
  std_ic: number
  n_dates: number
}

export interface LagICAnalysis {
  [lag: string]: LagICResult  // keys: "1", "2", "3", "5", "10"
}

export interface HoldingStock {
  stock_id: string
  hold_days: number
  hold_rate: number
}

export interface HoldingsAnalysis {
  top_stocks: HoldingStock[]
  unique_stocks: number
  avg_holding_days: number
  total_days: number
}

export interface SHAPHeatmapData {
  features: string[]
  periods: string[]
  matrix: number[][]  // shape: [n_features x n_periods]
}

export interface FeatureImportanceData {
  available: boolean
  error?: string
  features: Array<{
    name: string
    importance_split: number
    importance_gain: number
    rank: number
  }>
  total_features: number
  model_type: string
}

export interface SHAPAnalysisData {
  available: boolean
  error?: string
  feature_names: string[]
  shap_values: number[][]
  feature_values?: number[][]
  base_value: number
  sample_size: number
  feature_stats?: Record<string, {
    mean_abs_shap: number
    min_shap: number
    max_shap: number
  }>
}

export interface ModelInterpretabilityResponse {
  success: boolean
  data: {
    feature_importance: FeatureImportanceData
    shap_analysis: SHAPAnalysisData
  }
}

export interface InSampleBacktestResponse {
  success: boolean
  message: string
  data?: {
    run_id: string
    experiment_id: string
    segments: Record<string, InSampleSegmentResult>
  }
}

export interface FactorDoc {
  name: string
  expression: string
  description: string
  category: string
}

export interface Alpha158DocsResponse {
  factors: FactorDoc[]
  categories: Record<string, string>
  total_count: number
}
