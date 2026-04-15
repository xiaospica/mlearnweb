import { useCallback } from 'react'
import { App, Input } from 'antd'
import React from 'react'
import {
  clearOpsPassword as _clearOpsPassword,
  hasOpsPassword as _hasOpsPassword,
  setOpsPassword as _setOpsPassword,
} from '@/services/liveTradingService'

// Re-export so existing callers can `import { hasOpsPassword } from '@/hooks/useOpsPassword'`.
// The actual storage is an in-memory closure inside liveTradingService (see the
// threat-model comment there). DO NOT reintroduce sessionStorage/localStorage here.
export const hasOpsPassword = _hasOpsPassword
export const clearOpsPassword = _clearOpsPassword

/**
 * Ask the user for the ops password via an antd Modal. Resolves to true
 * when the user confirms with a non-empty value. Used once per session or
 * whenever the server rejects the stored password with 401.
 */
export function useOpsPassword() {
  const { modal, message } = App.useApp()

  const promptPassword = useCallback(
    (title: string = '请输入实盘运维口令'): Promise<boolean> => {
      return new Promise((resolve) => {
        let entered = ''
        modal.confirm({
          title,
          content: React.createElement(Input.Password, {
            placeholder: '共享运维口令',
            autoFocus: true,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
              entered = e.target.value
            },
            onPressEnter: () => {
              // antd will let the OK button handler close the modal
            },
          }),
          okText: '确认',
          cancelText: '取消',
          onOk: () => {
            if (!entered) {
              message.warning('请输入口令')
              return Promise.reject()
            }
            _setOpsPassword(entered)
            resolve(true)
          },
          onCancel: () => resolve(false),
        })
      })
    },
    [modal, message],
  )

  /**
   * Wrap a write call so it's gated by the ops password. If no password is
   * stored, prompts the user first. If the call fails with 401/403, clears
   * the stored password, re-prompts, and retries exactly once.
   */
  const guardWrite = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      if (!hasOpsPassword()) {
        const ok = await promptPassword()
        if (!ok) return null
      }
      try {
        return await fn()
      } catch (e: unknown) {
        const status = (e as { response?: { status?: number } })?.response?.status
        if (status === 401 || status === 403) {
          clearOpsPassword()
          message.error('口令错误，请重新输入')
          const ok = await promptPassword('口令错误，请重新输入')
          if (!ok) return null
          return await fn()
        }
        if (status === 503) {
          message.error('后端未配置运维口令，写操作已禁用。请设置 LIVE_TRADING_OPS_PASSWORD')
          return null
        }
        throw e
      }
    },
    [promptPassword, message],
  )

  return { promptPassword, guardWrite, hasOpsPassword, clearOpsPassword }
}
