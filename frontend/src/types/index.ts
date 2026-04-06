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
  // 新增：详细时序数据
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
  // 新增：日收益率分布
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
  // 新增：IC分析数据
  ic_analysis?: {
    available: boolean
    dates?: string[]
    ic_values?: number[]
    mean_ic?: number
    std_ic?: number
    icir?: number
    hit_rate?: number
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
