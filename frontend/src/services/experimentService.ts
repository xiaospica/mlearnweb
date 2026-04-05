import apiClient from './apiClient'
import type { Experiment, ApiSuccessResponse } from '@/types'

export const experimentService = {
  list(search = ''): Promise<ApiSuccessResponse<{ total: number; items: Experiment[] }>> {
    return apiClient.get('/experiments', { params: { search } }).then((r) => r.data)
  },

  get(experimentId: string): Promise<ApiSuccessResponse<Experiment>> {
    return apiClient.get(`/experiments/${experimentId}`).then((r) => r.data)
  },

  getSummary(experimentId: string): Promise<ApiSuccessResponse<Experiment & { status_counts: Record<string, number>; total_runs: number }>> {
    return apiClient.get(`/experiments/${experimentId}/summary`).then((r) => r.data)
  },
}
