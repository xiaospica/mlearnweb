import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

export type ModeFilter = 'all' | 'live' | 'sim' | 'offline'
export type StatusFilter = 'all' | 'running' | 'inited' | 'failed' | 'never_run'
export type SortKey = 'next_run' | 'equity' | 'last_status' | 'name'

export interface StrategyFilters {
  mode: ModeFilter
  nodeIds: string[]  // 空数组 = 全部节点
  status: StatusFilter
  sort: SortKey
  search: string
}

const DEFAULTS: StrategyFilters = {
  mode: 'all',
  nodeIds: [],
  status: 'all',
  sort: 'next_run',
  search: '',
}

/**
 * 实盘页筛选/排序状态 ↔ URL query 同步：
 * - 可分享、可书签、刷新页面保留
 * - 通过 useSearchParams 派发，保持 React Router 体系内
 */
export function useStrategyFilters(): {
  filters: StrategyFilters
  set: (patch: Partial<StrategyFilters>) => void
  reset: () => void
} {
  const [params, setParams] = useSearchParams()

  const filters: StrategyFilters = useMemo(() => {
    const mode = (params.get('mode') as ModeFilter) ?? DEFAULTS.mode
    const status = (params.get('status') as StatusFilter) ?? DEFAULTS.status
    const sort = (params.get('sort') as SortKey) ?? DEFAULTS.sort
    const search = params.get('q') ?? ''
    const nodesRaw = params.get('node') ?? ''
    const nodeIds = nodesRaw ? nodesRaw.split(',').filter(Boolean) : []
    return {
      mode: validateMode(mode),
      status: validateStatus(status),
      sort: validateSort(sort),
      search,
      nodeIds,
    }
  }, [params])

  const set = useCallback(
    (patch: Partial<StrategyFilters>) => {
      const next = { ...filters, ...patch }
      const sp = new URLSearchParams()
      if (next.mode !== DEFAULTS.mode) sp.set('mode', next.mode)
      if (next.status !== DEFAULTS.status) sp.set('status', next.status)
      if (next.sort !== DEFAULTS.sort) sp.set('sort', next.sort)
      if (next.search) sp.set('q', next.search)
      if (next.nodeIds.length > 0) sp.set('node', next.nodeIds.join(','))
      setParams(sp, { replace: true })
    },
    [filters, setParams],
  )

  const reset = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams])

  return { filters, set, reset }
}

function validateMode(m: string): ModeFilter {
  return m === 'live' || m === 'sim' || m === 'offline' ? m : 'all'
}

function validateStatus(s: string): StatusFilter {
  return s === 'running' || s === 'inited' || s === 'failed' || s === 'never_run' ? s : 'all'
}

function validateSort(s: string): SortKey {
  return s === 'equity' || s === 'last_status' || s === 'name' ? s : 'next_run'
}
