import apiClient from './apiClient'
import type { RunListItem, RunDetail, ApiSuccessResponse } from '@/types'

export const runService = {
  list(expId: string, params?: { page?: number; page_size?: number; status?: string; sort_by?: string; order?: string }): Promise<ApiSuccessResponse<{ total: number; items: RunListItem[] }>> {
    return apiClient.get('/runs', { params: { exp_id: expId, ...params } }).then((r) => r.data)
  },

  get(expId: string, runId: string): Promise<ApiSuccessResponse<RunDetail>> {
    return apiClient.get(`/runs/${runId}`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getParams(expId: string, runId: string): Promise<ApiSuccessResponse<{ raw: Record<string, unknown>; structured: Record<string, unknown> }>> {
    return apiClient.get(`/runs/${runId}/params`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getMetrics(expId: string, runId: string): Promise<ApiSuccessResponse<Record<string, unknown>>> {
    return apiClient.get(`/runs/${runId}/metrics`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getArtifacts(expId: string, runId: string): Promise<ApiSuccessResponse<Array<{ path: string; size_kb: number; type: string }>>> {
    return apiClient.get(`/runs/${runId}/artifacts`, { params: { exp_id: expId } }).then((r) => r.data)
  },
}
