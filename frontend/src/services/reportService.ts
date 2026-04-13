import apiClient from './apiClient'
import type { ReportData, ApiSuccessResponse, QLibFiguresData, FeatureImportanceData, SHAPAnalysisData, SHAPHeatmapData } from '@/types'

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

  getFeatureImportance(expId: string, runId: string): Promise<ApiSuccessResponse<FeatureImportanceData>> {
    return apiClient.get(`/runs/${runId}/feature-importance`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getSHAPAnalysis(
    expId: string, 
    runId: string, 
    sampleSize: number = 500, 
    segment: string = 'test'
  ): Promise<ApiSuccessResponse<SHAPAnalysisData>> {
    return apiClient.get(`/runs/${runId}/shap-analysis`, { 
      params: { exp_id: expId, sample_size: sampleSize, segment } 
    }).then((r) => r.data)
  },

  getModelInterpretability(expId: string, runId: string): Promise<ApiSuccessResponse<{
    feature_importance: FeatureImportanceData
    shap_analysis: SHAPAnalysisData
  }>> {
    return apiClient.get(`/runs/${runId}/model-interpretability`, { params: { exp_id: expId } }).then((r) => r.data)
  },

  getSHAPHeatmap(expId: string, runId: string): Promise<ApiSuccessResponse<SHAPHeatmapData>> {
    return apiClient
      .get(`/runs/${runId}/shap-heatmap`, { params: { experiment_id: expId } })
      .then((r) => r.data)
  },
}
