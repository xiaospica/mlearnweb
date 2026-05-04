import { useCallback, useEffect, useState } from 'react'

export type Density = 'comfort' | 'compact'

const STORAGE_KEY = 'mlearnweb.live.density'

function read(): Density {
  if (typeof window === 'undefined') return 'comfort'
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === 'compact' ? 'compact' : 'comfort'
  } catch {
    return 'comfort'
  }
}

/** 实盘页密度模式：localStorage 持久化，跨会话稳定（与折叠态用 sessionStorage 不同）。 */
export function useDensity(): [Density, (d: Density) => void] {
  const [density, setDensityState] = useState<Density>(() => read())

  // 多 tab 同步：另一标签页改了 localStorage 后这里也跟着切
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      setDensityState(e.newValue === 'compact' ? 'compact' : 'comfort')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setDensity = useCallback((d: Density) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, d)
    } catch {
      /* ignore */
    }
    setDensityState(d)
  }, [])

  return [density, setDensity]
}
