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
} from '@/types/tuning'

export const tuningService = {
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
  ): Promise<
    ApiSuccessResponse<{ job_id: number; log_path: string; text: string }>
  > {
    return apiClient
      .get(`/tuning/jobs/${id}/logs`, { params: { tail_bytes: tailBytes } })
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
}
