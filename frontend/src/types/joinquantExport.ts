/** 聚宽（JoinQuant）持仓 JSON 导出元数据。
 *  对应后端 ``app/schemas/schemas.py::JoinquantExportItem``。
 */
export interface JoinquantExport {
  id: number
  training_record_id: number
  file_name: string | null
  file_path: string | null
  file_size: number | null
  sha256: string | null
  mlflow_run_ids: string[] | null
  n_dates: number | null
  n_runs_used: number | null
  n_runs_skipped: number | null
  status: 'ok' | 'failed' | string
  error_msg: string | null
  created_by: string | null
  created_at: string | null  // ISO 时间戳
}
