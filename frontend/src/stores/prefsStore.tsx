/**
 * AlphaPilot 客户端偏好 (L3) store
 *
 * 用于持久化「仅本浏览器、无需服务端」的用户偏好。与 themeStore 协同：
 * - themeStore  → key `alphapilot.theme` (单字段，特殊高频)
 * - prefsStore  → key `alphapilot.prefs.v1` (合并对象，未来扩展不增 key)
 *
 * 暴露：
 * - <PrefsProvider> 顶层注入
 * - usePrefs()       hook，返回 { prefs, setPrefs(patch), reset() }
 * - getPrefsSync()   非 React 同步读，给 chart-utils / 工具函数用
 *
 * 设计：
 * - 全量合并：setPrefs 接收 partial，与当前合并后整体写入
 * - 跨标签页同步：监听 storage 事件
 * - schema 升级：localStorage key 带 .v1，未来不兼容时升 .v2 不丢用户当前值
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

const STORAGE_KEY = 'alphapilot.prefs.v1'

/** 图表高度覆盖：所有字段可选；未提供的走 chart-utils 内置默认 */
export interface ChartHeightOverrides {
  xs?: number
  sm?: number
  md?: number
  lg?: number
}

export interface ClientPrefs {
  /** 图表默认高度覆盖（按断点） */
  chartHeights?: ChartHeightOverrides
  /** Sidebar 启动时是否折叠的「持久偏好」（与 alphapilot.sidebar.collapsed 区分：那是上次会话状态，这是默认值） */
  sidebarDefaultCollapsed?: boolean
}

const DEFAULT_PREFS: ClientPrefs = {}

const readStored = (): ClientPrefs => {
  if (typeof window === 'undefined') return { ...DEFAULT_PREFS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return { ...DEFAULT_PREFS, ...parsed }
    return { ...DEFAULT_PREFS }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

const writeStored = (p: ClientPrefs): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

/** 非 React 同步读：给 chart-utils 等模块用，无订阅 */
export const getPrefsSync = (): ClientPrefs => readStored()

interface PrefsStoreValue {
  prefs: ClientPrefs
  setPrefs: (patch: Partial<ClientPrefs>) => void
  reset: () => void
}

const PrefsContext = createContext<PrefsStoreValue | null>(null)

export const PrefsProvider = ({ children }: { children: ReactNode }) => {
  const [prefs, setState] = useState<ClientPrefs>(() => readStored())

  const setPrefs = useCallback((patch: Partial<ClientPrefs>) => {
    setState((prev) => {
      const next: ClientPrefs = { ...prev, ...patch }
      // 嵌套对象需要单独合并（避免 patch.chartHeights 整体覆盖）
      if (patch.chartHeights) {
        next.chartHeights = { ...(prev.chartHeights ?? {}), ...patch.chartHeights }
      }
      writeStored(next)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    writeStored({ ...DEFAULT_PREFS })
    setState({ ...DEFAULT_PREFS })
  }, [])

  // 跨标签页同步
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      setState(readStored())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  const value = useMemo<PrefsStoreValue>(() => ({ prefs, setPrefs, reset }), [prefs, setPrefs, reset])

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
}

export const usePrefs = (): PrefsStoreValue => {
  const ctx = useContext(PrefsContext)
  if (!ctx) {
    throw new Error('usePrefs must be used within <PrefsProvider>')
  }
  return ctx
}
