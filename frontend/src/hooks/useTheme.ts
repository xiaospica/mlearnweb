/**
 * AlphaPilot 主题 hook（公开 API 层）
 *
 * 实际状态由 src/stores/themeStore.tsx 的 React Context 承载（F1 已落）。
 * 这里做一个 hooks 包路径的薄封装，让消费方统一从 `@/hooks/useTheme` 引用，
 * 后续若改用 zustand / jotai / redux 也只需要改这一处。
 */

import { useThemeStore } from '@/stores/themeStore'
import type { ThemeMode } from '@/theme/tokens'

export interface UseThemeReturn {
  mode: ThemeMode
  isDark: boolean
  isLight: boolean
  setMode: (m: ThemeMode) => void
  toggle: () => void
}

export const useTheme = (): UseThemeReturn => {
  const { mode, setMode, toggle } = useThemeStore()
  return {
    mode,
    isDark: mode === 'dark',
    isLight: mode === 'light',
    setMode,
    toggle,
  }
}
