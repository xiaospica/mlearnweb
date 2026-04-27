/**
 * 训练工作台 (Tuning Workbench) 类型定义
 *
 * 与后端 `mlearnweb/backend/app/schemas/schemas.py` 保持一致：
 * TuningJob / TuningTrial / TuningProgress / TuningJobCreate /
 * TuningFinalizeRequest / TuningDeployRequest
 */

// ---------------------------------------------------------------------------
// 5 类可配置参数（前端 Stepper 收集，组装成 config_snapshot 提交给后端）
// ---------------------------------------------------------------------------

export interface TaskConfig {
  /** Alpha158Custom / Alpha158 / Alpha101 / Alpha191 等 */
  dataset_class?: string
  /** train/valid/test 时间段（单期模式用） */
  segments?: {
    train?: [string, string]
    valid?: [string, string]
    test?: [string, string]
  }
  /** 数据 handler 配置（缓存路径 / 过滤等，通常用默认） */
  handler_kwargs?: Record<string, unknown>
}

export interface CustomSegment {
  train: [string, string]
  valid: [string, string]
  test: [string, string]
}

export interface GbdtModelConfig {
  class?: string
  module_path?: string
  /** LightGBM 关键超参；调参时由 Optuna 采样覆盖 */
  kwargs?: {
    learning_rate?: number
    num_leaves?: number
    max_depth?: number
    min_child_samples?: number
    lambda_l1?: number
    lambda_l2?: number
    colsample_bytree?: number
    subsample?: number
    subsample_freq?: number
    early_stopping_rounds?: number
    n_estimators?: number
    num_threads?: number
    seed?: number
    [key: string]: unknown
  }
}

export interface BtStrategy {
  topk: number
  n_drop: number
  only_tradable: boolean
  signal: string
}

export type SearchSpaceParam =
  | { type: 'float'; low: number; high: number; log?: boolean }
  | { type: 'int'; low: number; high: number; log?: boolean }
  | { type: 'categorical'; choices: Array<string | number> }

export type SearchSpace = Record<string, SearchSpaceParam>

export interface TuningConfigSnapshot {
  task_config?: TaskConfig | Record<string, unknown>
  custom_segments?: CustomSegment[]
  gbdt_model?: GbdtModelConfig
  /**
   * RECORD_CONFIG 嵌套较深，前端按 raw JSON 编辑。
   * V3.1: bt_strategy 已合并到 record_config 内 PortAnaRecord 的 strategy.kwargs（不再独立字段）
   */
  record_config?: Array<Record<string, unknown>>
  /** Optuna 搜索空间（V3）：每参数 {type, low, high, log?} 或 {type:'categorical', choices} */
  search_space?: SearchSpace
}

// ---------------------------------------------------------------------------
// 后端实体
// ---------------------------------------------------------------------------

export type TuningJobStatus =
  | 'created'
  | 'running'
  | 'searching'
  | 'finalizing'
  | 'done'
  | 'cancelled'
  | 'failed'
  | 'zombie'

export type TuningSearchMode = 'single_segment' | 'walk_forward_5p'

export interface TuningJob {
  id: number
  name: string
  description?: string | null
  status: TuningJobStatus
  search_mode: TuningSearchMode
  n_trials_target: number
  n_trials_done: number
  n_trials_failed: number
  best_trial_number?: number | null
  best_objective_value?: number | null
  finalized_training_record_id?: number | null
  started_at?: string | null
  completed_at?: string | null
  duration_seconds?: number | null
  error?: string | null
  config_snapshot?: TuningConfigSnapshot | null
  /** V3.3 队列调度：null=不在队列；非 null 数字越小越先跑 */
  queue_position?: number | null
  start_n_jobs?: number | null
  start_num_threads?: number | null
  start_seed?: number | null
  created_at: string
  updated_at: string
}

export type TuningTrialState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'pruned'
  | 'metrics_missing'
  | 'no_run_index'
  | 'empty_run_index'
  | 'no_sharpe'
  | 'unknown'

export interface TuningTrial {
  trial_number: number
  state: TuningTrialState
  params: Record<string, number | string>
  valid_sharpe?: number | null
  test_sharpe?: number | null
  overfit_ratio?: number | null
  composite_scores: Record<string, number | null>
  hard_constraint_passed: boolean
  hard_constraint_failed_items: string[]
  run_id?: string | null
  duration_sec?: number | null
  error?: string | null
  started_at?: string | null
  completed_at?: string | null
}

export interface TuningProgress {
  job_id: number
  status: TuningJobStatus
  n_trials_target: number
  n_trials_done: number
  n_trials_failed: number
  best_trial_number?: number | null
  best_objective_value?: number | null
  last_log_offset: number
  duration_seconds?: number | null
}

// ---------------------------------------------------------------------------
// API 请求体
// ---------------------------------------------------------------------------

export interface TuningJobCreateRequest {
  name: string
  description?: string
  search_mode: TuningSearchMode
  n_trials: number
  n_jobs?: number
  num_threads?: number
  seed?: number
  /** V3.3: true=创建后立即入队等待 scheduler 自动启动；false=仅创建草稿 */
  enqueue?: boolean
  config_snapshot: TuningConfigSnapshot
}

export interface TuningFinalizeRequest {
  trial_number: number
  seed?: number
  name?: string
  description?: string
}

export interface TuningDeployRequest {
  node_id: string
  engine: string
  class_name: string
  strategy_name: string
  vt_symbol?: string
  setting_overrides?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// V3.4 跨期验证 + 多 seed 复跑
// ---------------------------------------------------------------------------

export interface TuningWalkForwardRequest {
  trial_numbers: number[]
  seed?: number
  num_threads?: number
  /** 非空时在 walk_forward 后再跑 multi-seed reproduce */
  reproduce_seeds?: number[]
}

export interface WalkForwardRow {
  trial_id: number
  seed?: number | null
  run_name?: string
  duration_sec?: number | null
  subprocess_returncode?: number | null
  error?: string | null
  // 仅成功行有以下字段
  n_periods?: number | null
  valid_sharpe_per_period?: number[] | null
  test_sharpe_per_period?: number[] | null
  valid_sharpe_mean?: number | null
  valid_sharpe_std?: number | null
  valid_sharpe_min?: number | null
  valid_sharpe_max?: number | null
  test_sharpe_mean?: number | null
  test_sharpe_std?: number | null
  test_sharpe_min?: number | null
  valid_rank_icir_mean?: number | null
  overfit_ratio_max?: number | null
  valid_max_drawdown_max?: number | null
  cross_period_pass_count?: number | null
  cross_period_pass_rate?: number | null
  all_positive?: boolean | null
  worst_period_idx?: number | null
  stability_score?: number | null
  run_ids?: string | null
}

export interface ReproduceRow {
  trial_id: number
  seed: number
  run_name?: string
  duration_sec?: number | null
  subprocess_returncode?: number | null
  test_sharpe?: number | null
  test_long_short_sharpe?: number | null
  test_max_drawdown?: number | null
  test_annualized_return?: number | null
  test_rank_icir?: number | null
  valid_rank_icir?: number | null
  train_rank_icir?: number | null
  overfit_ratio?: number | null
  hard_constraint_passed?: boolean | null
  hard_constraint_failed_items?: string | null
  composite_score?: number | null
  run_id?: string | null
  error?: string | null
}

export interface ReproduceAggregateStat {
  n: number
  mean: number | null
  std: number | null
  min: number | null
  max: number | null
  median: number | null
}

export interface ReproduceAggregate {
  trial_id: number
  n_seeds: number
  hard_pass_count: number
  test_sharpe: ReproduceAggregateStat
  test_max_drawdown: ReproduceAggregateStat
  test_annualized_return: ReproduceAggregateStat
  overfit_ratio: ReproduceAggregateStat
  rows: ReproduceRow[]
}

export interface WalkForwardResults {
  job_id: number
  running: boolean
  pid?: number | null
  walk_forward: WalkForwardRow[]
  reproduce: ReproduceRow[]
  reproduce_aggregate: ReproduceAggregate[]
  summary_md?: string | null
}
