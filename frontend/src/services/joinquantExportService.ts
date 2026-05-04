import apiClient from './apiClient'
import type { ApiSuccessResponse } from '@/types'
import type { JoinquantExport } from '@/types/joinquantExport'

/** 聚宽持仓 JSON 导出 API 客户端。
 *  端点定义见后端 ``app/routers/joinquant_exports.py``。
 *
 *  下载走 GET /api/joinquant-exports/{id}/download，后端 Content-Disposition=attachment，
 *  前端用 ``getDownloadUrl(id)`` 拼接 ``<a href download>`` 直接走浏览器下载，
 *  不经 axios blob — 大文件不占内存且节省 base64 转换。
 */
export const joinquantExportService = {
  /** 触发生成。同步阻塞 1-5s。失败时 success=false 但 data 仍含 error_msg 行（不抛 5xx）。 */
  generate(recordId: number): Promise<ApiSuccessResponse<JoinquantExport>> {
    return apiClient
      .post(`/training-records/${recordId}/joinquant-exports`)
      .then((r) => r.data)
  },

  /** 列出该 record 全部历史导出（按 created_at 倒序）。 */
  list(recordId: number): Promise<ApiSuccessResponse<JoinquantExport[]>> {
    return apiClient
      .get(`/training-records/${recordId}/joinquant-exports`)
      .then((r) => r.data)
  },

  remove(exportId: number): Promise<ApiSuccessResponse<null>> {
    return apiClient.delete(`/joinquant-exports/${exportId}`).then((r) => r.data)
  },

  /** 浏览器直接打开此 URL 即触发下载（后端 FileResponse + attachment）。 */
  getDownloadUrl(exportId: number): string {
    // apiClient.baseURL = '/api'，这里手动拼上 /api 前缀避免依赖 axios
    return `/api/joinquant-exports/${exportId}/download`
  },
}
