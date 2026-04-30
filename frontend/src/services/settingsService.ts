/**
 * 应用设置 API 客户端
 *
 * - Phase 1：GET /env  只读环境快照
 * - Phase 2：GET/PATCH/DELETE /runtime/{key}  运行期可热改 + GET /runtime 列表
 */

import apiClient from './apiClient'

export interface VnpyNodeSummary {
  node_id: string | null
  base_url: string | null
  username: string | null
  has_password: boolean
  enabled: boolean
  mode: string | null
}

export interface VnpyNodesSummary {
  config_path: string
  exists: boolean
  nodes: VnpyNodeSummary[]
  error: string | null
}

export interface RuntimeOverrideMark {
  source: 'db' | 'env'
  default_value: unknown
  updated_at: string | null
}

export interface L1FieldSourceOfTruth {
  repo: string
  writer_path: string
  writer_env: string
  default_writer_value: string
  note: string
}

export interface L1FieldMeta {
  env_var: string
  restart: 'main' | 'live_main' | 'both'
  /** mlearnweb_owned = 本仓权威；remote_mount_view = 仅本地挂载视图，源头在别处 */
  ownership: 'mlearnweb_owned' | 'remote_mount_view'
  hint: string
  /** 仅 remote_mount_view 类型携带：描述权威写方在哪里 */
  source_of_truth?: L1FieldSourceOfTruth
}

export interface EnvFileInfo {
  env_file_path: string
  env_file_exists: boolean
  env_example_path: string | null
  backend_dir: string
}

export interface EnvInfo {
  fetched_at: string
  python: { executable: string; version: string; implementation: string }
  platform: { system: string; release: string; machine: string; node: string }
  git: { sha: string | null; branch: string | null }
  paths: {
    mlruns_dir: string
    database_url: string
    upload_dir: string
    vnpy_nodes_config_path: string
    daily_merged_root: string
    ml_live_output_root: string | null
  }
  vnpy: {
    request_timeout: number
    poll_interval_seconds: number
    snapshot_retention_days: number
    ops_password_set: boolean
    nodes: VnpyNodesSummary
  }
  limits: {
    max_image_size_mb: number
    allowed_image_exts: string[]
    orphan_grace_seconds: number
  }
  sync: { deployment_sync_interval_seconds: number }
  cors_origins: string[]
  /** L2 字段当前是否被 DB 覆盖（key → meta） */
  runtime_overrides: Record<string, RuntimeOverrideMark>
  /** L1 字段（仅 .env + 重启）元数据：env 变量名 + 重启进程提示 */
  l1_field_meta: Record<string, L1FieldMeta>
  /** .env 文件位置 + 状态 */
  env_file_info: EnvFileInfo
}

export const fetchEnvInfo = async (): Promise<EnvInfo> => {
  const { data } = await apiClient.get<{ success: boolean; message: string; data: EnvInfo }>(
    '/settings/env',
  )
  return data.data
}

// ---------------------------------------------------------------------------
// Runtime settings (Phase 2)
// ---------------------------------------------------------------------------

export type RuntimeValueType = 'int' | 'float' | 'str' | 'bool' | 'list_str'
export type RuntimeCategory = 'paths' | 'vnpy' | 'limits'

export interface RuntimeSettingItem {
  key: string
  value_type: RuntimeValueType
  category: RuntimeCategory
  label: string
  description: string
  hot_reload: boolean
  sensitive: boolean
  min: number | null
  max: number | null
  current_value: unknown
  default_value: unknown
  source: 'db' | 'env'
  updated_at: string | null
}

export const listRuntimeSettings = async (): Promise<RuntimeSettingItem[]> => {
  const { data } = await apiClient.get<{
    success: boolean
    message: string
    data: { items: RuntimeSettingItem[] }
  }>('/settings/runtime')
  return data.data.items
}

export const patchRuntimeSetting = async (
  key: string,
  value: unknown,
): Promise<RuntimeSettingItem> => {
  const { data } = await apiClient.patch<{
    success: boolean
    message: string
    data: RuntimeSettingItem
  }>(`/settings/runtime/${encodeURIComponent(key)}`, { value })
  return data.data
}

export const deleteRuntimeSetting = async (key: string): Promise<RuntimeSettingItem> => {
  const { data } = await apiClient.delete<{
    success: boolean
    message: string
    data: RuntimeSettingItem
  }>(`/settings/runtime/${encodeURIComponent(key)}`)
  return data.data
}
