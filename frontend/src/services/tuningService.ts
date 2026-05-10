/**
 * 训练工作台 API 封装
 *
 * 对应后端 routers/tuning.py 的 12 个 endpoint。
 * SSE `/events` 用浏览器原生 EventSource，不通过 axios。
 */

import apiClient from './apiClient'
import type { ApiSuccessResponse } from '@/types'
import type {
  TuningJob,
  TuningTrial,
  TuningProgress,
  TuningJobCreateRequest,
  TuningFinalizeRequest,
  TuningDeployRequest,
  TuningWalkForwardRequest,
  WalkForwardResults,
  ParamImportanceResult,
} from '@/types/tuning'

export const tuningService = {
  capabilities(): Promise<ApiSuccessResponse<{
    enabled: boolean
    reasons: string[]
    strategy_dev_root: string | null
    tuning_python_exe: string | null
    tuning_runs_root: string
  }>> {
    return apiClient.get('/tuning/capabilities').then((r) => r.data)
  },

  // -------------------------------------------------------------------------
  // Job 生命周期
  // -------------------------------------------------------------------------

  create(body: TuningJobCreateRequest): Promise<ApiSuccessResponse<TuningJob>> {
    return apiClient.post('/tuning/jobs', body).then((r) => r.data)
  },

  list(params?: {
    page?: number
    page_size?: number
    status?: string
  }): Promise<ApiSuccessResponse<{ total: number; page: number; page_size: number; items: TuningJob[] }>> {
    return apiClient.get('/tuning/jobs', { params }).then((r) => r.data)
  },

  get(id: number): Promise<ApiSuccessResponse<TuningJob>> {
    return apiClient.get(`/tuning/jobs/${id}`).then((r) => r.data)
  },

  delete(id: number): Promise<ApiSuccessResponse<null>> {
    return apiClient.delete(`/tuning/jobs/${id}`).then((r) => r.data)
  },

  /** V3.7: 重命名 / 编辑描述 */
  update(
    id: number,
    body: { name?: string; description?: string },
  ): Promise<ApiSuccessResponse<TuningJob>> {
    return apiClient.patch(`/tuning/jobs/${id}`, body).then((r) => r.data)
  },

  start(
    id: number,
    params?: { n_jobs?: number; num_threads?: number; seed?: number },
  ): Promise<ApiSuccessResponse<TuningJob>> {
    return apiClient
      .post(`/tuning/jobs/${id}/start`, null, { params })
      .then((r) => r.data)
  },

  cancel(id: number): Promise<ApiSuccessResponse<TuningJob>> {
    return apiClient.post(`/tuning/jobs/${id}/cancel`).then((r) => r.data)
  },

  // -------------------------------------------------------------------------
  // Trial / 进度 / 日志
  // -------------------------------------------------------------------------

  listTrials(
    id: number,
    params?: {
      sort_by?: 'valid_sharpe' | 'test_sharpe' | 'trial_number'
      desc?: boolean
      only_completed?: boolean
    },
  ): Promise<
    ApiSuccessResponse<{ job_id: number; total: number; items: TuningTrial[] }>
  > {
    return apiClient.get(`/tuning/jobs/${id}/trials`, { params }).then((r) => r.data)
  },

  getProgress(id: number): Promise<ApiSuccessResponse<TuningProgress>> {
    return apiClient.get(`/tuning/jobs/${id}/progress`).then((r) => r.data)
  },

  getLogs(
    id: number,
    tailBytes = 16384,
    source: 'tuning' | 'stdout' | 'all' = 'tuning',
  ): Promise<
    ApiSuccessResponse<{
      job_id: number
      log_path: string
      source: string
      text: string
    }>
  > {
    return apiClient
      .get(`/tuning/jobs/${id}/logs`, {
        params: { tail_bytes: tailBytes, source },
      })
      .then((r) => r.data)
  },

  /**
   * SSE 实时事件流（在外部用 EventSource 自行连接，本函数仅返回 URL）
   */
  eventsUrl(id: number): string {
    return `/api/tuning/jobs/${id}/events`
  },

  // -------------------------------------------------------------------------
  // Finalize / 部署（Phase 2 实现，当前后端返回 501）
  // -------------------------------------------------------------------------

  finalize(
    id: number,
    body: TuningFinalizeRequest,
  ): Promise<ApiSuccessResponse<unknown>> {
    return apiClient.post(`/tuning/jobs/${id}/finalize`, body).then((r) => r.data)
  },

  deploy(
    id: number,
    body: TuningDeployRequest,
  ): Promise<ApiSuccessResponse<unknown>> {
    return apiClient.post(`/tuning/jobs/${id}/deploy`, body).then((r) => r.data)
  },

  // -------------------------------------------------------------------------
  // V3.3 队列调度（搜索任务 queue：晚上批量提交，scheduler 串行自动跑）
  // -------------------------------------------------------------------------

  getQueue(): Promise<
    ApiSuccessResponse<{ items: TuningJob[]; runner_busy: TuningJob | null }>
  > {
    return apiClient.get('/tuning/queue').then((r) => r.data)
  },

  enqueue(id: number): Promise<ApiSuccessResponse<TuningJob>> {
    return apiClient.post(`/tuning/jobs/${id}/enqueue`).then((r) => r.data)
  },

  dequeue(id: number): Promise<ApiSuccessResponse<TuningJob>> {
    return apiClient.post(`/tuning/jobs/${id}/dequeue`).then((r) => r.data)
  },

  reorderQueue(
    jobIds: number[],
  ): Promise<ApiSuccessResponse<{ items: TuningJob[] }>> {
    return apiClient
      .post('/tuning/queue/reorder', { job_ids: jobIds })
      .then((r) => r.data)
  },

  // -------------------------------------------------------------------------
  // V3.4 跨期验证 + 多 seed 复跑
  // -------------------------------------------------------------------------

  /** V3.7: 创建衍生验证 job（不再 inplace 跑），返回新 job 信息 */
  startWalkForward(
    id: number,
    body: TuningWalkForwardRequest,
  ): Promise<ApiSuccessResponse<TuningJob>> {
    return apiClient
      .post(`/tuning/jobs/${id}/walk-forward`, body)
      .then((r) => r.data)
  },

  /** V3.7: 列出某 source job 的所有衍生验证 job */
  listDerivedJobs(
    id: number,
  ): Promise<ApiSuccessResponse<{ parent_job_id: number; items: TuningJob[] }>> {
    return apiClient.get(`/tuning/jobs/${id}/derived`).then((r) => r.data)
  },

  getWalkForwardResults(
    id: number,
  ): Promise<ApiSuccessResponse<WalkForwardResults>> {
    return apiClient
      .get(`/tuning/jobs/${id}/walk-forward-results`)
      .then((r) => r.data)
  },

  getWalkForwardLog(
    id: number,
    tailBytes = 16384,
  ): Promise<ApiSuccessResponse<{ job_id: number; text: string }>> {
    return apiClient
      .get(`/tuning/jobs/${id}/walk-forward-log`, { params: { tail_bytes: tailBytes } })
      .then((r) => r.data)
  },

  /** V3.8: 用 Optuna fANOVA 算各 search_space 参数对 valid_sharpe 的贡献度 */
  getParamImportance(
    id: number,
  ): Promise<ApiSuccessResponse<ParamImportanceResult>> {
    return apiClient.get(`/tuning/jobs/${id}/param-importance`).then((r) => r.data)
  },

  /** V3.9: 只读获取部署 manifest（跳转部署页时预填字段用） */
  getDeploymentManifest(
    id: number,
  ): Promise<ApiSuccessResponse<{
    schema_version: number
    mlflow_run_id: string
    mlflow_experiment_id: string
    bundle_dir: string
    tuning_job_id: number
    training_record_id: number
  }>> {
    return apiClient.get(`/tuning/jobs/${id}/deployment-manifest`).then((r) => r.data)
  },
}
