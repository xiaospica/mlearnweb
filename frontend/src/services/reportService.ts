import apiClient from './apiClient'
import type { ReportData, ApiSuccessResponse, QLibFiguresData } from '@/types'

export const reportService = {
  getFullReport(expId: string, runId: string): Promise<ApiSuccessResponse<ReportData>> {
    return apiClient.get(`/runs/${runId}/report`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getPortfolioChart(expId: string, runId: string): Promise<ApiSuccessResponse<unknown>> {
    return apiClient.get(`/runs/${runId}/charts/portfolio`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getICChart(expId: string, runId: string): Promise<ApiSuccessResponse<unknown>> {
    return apiClient.get(`/runs/${runId}/charts/ic`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getRiskChart(expId: string, runId: string): Promise<ApiSuccessResponse<unknown>> {
    return apiClient.get(`/runs/${runId}/charts/risk`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getPredictionChart(expId: string, runId: string): Promise<ApiSuccessResponse<unknown>> {
    return apiClient.get(`/runs/${runId}/charts/prediction`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getQLibFigures(expId: string, runId: string): Promise<ApiSuccessResponse<QLibFiguresData>> {
    console.log('[reportService] getQLibFigures called with:', { expId, runId })
    const url = `/runs/${runId}/qlib-figures`
    const params = { exp_id: expId }
    console.log('[reportService] Request URL:', url, 'Params:', params)
    
    return apiClient
      .get(url, { params })
      .then((r) => {
        console.log('[reportService] getQLibFigures response:', r.data)
        return r.data
      })
      .catch((error) => {
        console.error('[reportService] getQLibFigures error:', error)
        console.error('[reportService] Error response:', error.response?.data)
        throw error
      })
  },
}
