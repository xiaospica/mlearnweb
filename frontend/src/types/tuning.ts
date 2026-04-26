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

export interface TuningConfigSnapshot {
  task_config?: TaskConfig
  custom_segments?: CustomSegment[]
  gbdt_model?: GbdtModelConfig
  bt_strategy?: BtStrategy
  /** RECORD_CONFIG 嵌套较深，前端按 raw JSON 编辑 */
  record_config?: Array<Record<string, unknown>>
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
