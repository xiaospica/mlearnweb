import apiClient from './apiClient'
import type { TrainingRecord, ApiSuccessResponse } from '@/types'

export const trainingService = {
  create(data: { name: string; description?: string; experiment_id: string; experiment_name?: string; command_line?: string; category?: string }): Promise<ApiSuccessResponse<TrainingRecord>> {
    return apiClient.post('/training-records', data).then((r) => r.data)
  },

  list(params?: { page?: number; page_size?: number; status?: string; category?: string; search?: string }): Promise<ApiSuccessResponse<{ total: number; page: number; page_size: number; items: TrainingRecord[] }>> {
    return apiClient.get('/training-records', { params }).then((r) => r.data)
  },

  get(id: number): Promise<ApiSuccessResponse<TrainingRecord>> {
    return apiClient.get(`/training-records/${id}`).then((r) => r.data)
  },

  update(id: number, data: Record<string, unknown>): Promise<ApiSuccessResponse<TrainingRecord>> {
    return apiClient.put(`/training-records/${id}`, data).then((r) => r.data)
  },

  delete(id: number): Promise<ApiSuccessResponse<null>> {
    return apiClient.delete(`/training-records/${id}`).then((r) => r.data)
  },

  batchDelete(ids: number[]): Promise<ApiSuccessResponse<{ deleted: number; failed_ids?: number[] }>> {
    return apiClient.post('/training-records/batch-delete', { ids }).then((r) => r.data)
  },

  getMergedReport(recordId: number): Promise<ApiSuccessResponse<{
    record_info: { id: number; name: string; category: string; total_runs: number; successful_runs: number }
    merged_report: {
      available: boolean
      dates: string[]
      total_days: number
      cumulative_return: number[]
      daily_return: number[]
      run_boundaries: Array<{ start_date: string; end_date: string; run_index: number | null; segment_label: string | null }>
      benchmark_cum_return?: number[]
      daily_benchmark?: number[]
      turnover?: number[]
    }
    merged_metrics: {
      available: boolean
      total_trading_days: number
      total_return: number
      annualized_return: number
      mean_daily_return: number
      std_daily_return: number
      max_drawdown: number
      sharpe_ratio: number | null
      sortino_ratio: number
      calmar_ratio: number | null
      win_rate: number
      profit_loss_ratio: number | null
      max_single_day_gain: number
      max_single_day_loss: number
      number_of_runs: number
      excess_annualized_return?: number
      tracking_error?: number
      information_ratio?: number | null
    }
    individual_runs: Array<{ run_id: string; rolling_index: number | null; segment_label: string | null; test_range: string; data_points: number }>
  }>> {
    return apiClient.get(`/training-records/${recordId}/merged-report`).then((r) => r.data)
  },

  getLog(recordId: number): Promise<ApiSuccessResponse<{ log_content: string; has_log: boolean }>> {
    return apiClient.get(`/training-records/${recordId}/log`).then((r) => r.data)
  },
}
