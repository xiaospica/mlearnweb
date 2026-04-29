import apiClient from './apiClient'
import type {
  Experiment,
  ApiSuccessResponse,
  UnlinkedRunsListData,
  RunCleanupResultData,
} from '@/types'

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

  getUnlinkedRuns(experimentId: string): Promise<ApiSuccessResponse<UnlinkedRunsListData>> {
    return apiClient.get(`/experiments/${experimentId}/unlinked-runs`).then((r) => r.data)
  },

  cleanupRuns(
    experimentId: string,
    payload: { select: 'manual' | 'all_unlinked'; run_ids?: string[] },
  ): Promise<ApiSuccessResponse<RunCleanupResultData>> {
    return apiClient
      .post(`/experiments/${experimentId}/runs/cleanup`, payload)
      .then((r) => r.data)
  },
}
