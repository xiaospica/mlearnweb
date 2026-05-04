import React, { createContext, useContext, useEffect, useRef, useState } from 'react'

/**
 * 顶层单 timer + Context 广播：把每张策略卡都各自跑一个 setInterval(1000) 的设计
 * 收敛成全局 1 个 timer。30 张卡对应 30 timers → 1 timer 的省渲染优化。
 *
 * tickMs 默认 1000；倒计时精度足够。
 *
 * 浏览器标签页隐藏时（document.visibilityState === 'hidden'）暂停 ticking，
 * 防止后台 tab 持续触发渲染浪费 CPU。
 */
const NowMsContext = createContext<number>(Date.now())

export interface NowMsProviderProps {
  /** 心跳间隔（ms），默认 1000 */
  tickMs?: number
  children: React.ReactNode
}

export const NowMsProvider: React.FC<NowMsProviderProps> = ({ tickMs = 1000, children }) => {
  const [now, setNow] = useState<number>(() => Date.now())
  const visibleRef = useRef<boolean>(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  )

  useEffect(() => {
    const onVisChange = () => {
      visibleRef.current = document.visibilityState !== 'hidden'
      if (visibleRef.current) setNow(Date.now())  // 重新可见时立即刷一次
    }
    document.addEventListener('visibilitychange', onVisChange)
    return () => document.removeEventListener('visibilitychange', onVisChange)
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (visibleRef.current) setNow(Date.now())
    }, Math.max(100, tickMs))
    return () => window.clearInterval(id)
  }, [tickMs])

  return <NowMsContext.Provider value={now}>{children}</NowMsContext.Provider>
}

/** 订阅当前时间戳（毫秒）。Provider 缺失时退化到组件挂载时的固定时间。 */
export function useNowMs(): number {
  return useContext(NowMsContext)
}
