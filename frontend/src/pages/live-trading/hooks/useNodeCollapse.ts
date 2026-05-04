import { useCallback, useState } from 'react'

const STORAGE_KEY = 'mlearnweb.live.collapsedNodes'

function readSet(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function writeSet(s: Set<string>) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...s]))
  } catch {
    /* ignore */
  }
}

/**
 * 节点折叠态：sessionStorage 存储（标签页关闭即清），避免第二天打开时
 * 用户错过故障节点。返回 (collapsedSet, toggle, isCollapsed) 三元组。
 */
export function useNodeCollapse(): {
  isCollapsed: (nodeId: string) => boolean
  toggle: (nodeId: string) => void
  collapseAll: (nodeIds: string[]) => void
  expandAll: () => void
} {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readSet())

  const toggle = useCallback((nodeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      writeSet(next)
      return next
    })
  }, [])

  const collapseAll = useCallback((nodeIds: string[]) => {
    setCollapsed(() => {
      const next = new Set(nodeIds)
      writeSet(next)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    setCollapsed(() => {
      const next = new Set<string>()
      writeSet(next)
      return next
    })
  }, [])

  const isCollapsed = useCallback((nodeId: string) => collapsed.has(nodeId), [collapsed])

  return { isCollapsed, toggle, collapseAll, expandAll }
}
