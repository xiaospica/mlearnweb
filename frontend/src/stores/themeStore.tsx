/**
 * AlphaPilot 主题切换 store
 * 基于 React Context + localStorage（避免新增 zustand 依赖）。
 * 默认 dark；用户偏好持久化在 localStorage。
 * 同步把 :root[data-theme=...] 写到 <html> 上以驱动 global.css 变量。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ThemeMode } from '@/theme/tokens'

const STORAGE_KEY = 'alphapilot.theme'
const DEFAULT_MODE: ThemeMode = 'dark'

const readStoredMode = (): ThemeMode => {
  if (typeof window === 'undefined') return DEFAULT_MODE
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

const applyToDom = (mode: ThemeMode) => {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', mode)
}

interface ThemeStoreValue {
  mode: ThemeMode
  setMode: (m: ThemeMode) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeStoreValue | null>(null)

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const m = readStoredMode()
    applyToDom(m)
    return m
  })

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m)
    applyToDom(m)
    try {
      window.localStorage.setItem(STORAGE_KEY, m)
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [])

  const toggle = useCallback(() => {
    setMode(mode === 'dark' ? 'light' : 'dark')
  }, [mode, setMode])

  // 跨标签页同步
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      const next = e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : DEFAULT_MODE
      if (next !== mode) {
        setModeState(next)
        applyToDom(next)
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [mode])

  const value = useMemo<ThemeStoreValue>(() => ({ mode, setMode, toggle }), [mode, setMode, toggle])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useThemeStore = (): ThemeStoreValue => {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useThemeStore must be used within <ThemeProvider>')
  }
  return ctx
}
