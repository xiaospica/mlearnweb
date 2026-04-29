/**
 * AlphaPilot 视口懒挂载
 *
 * 接近视口边缘时才挂载子树，未触达前用占位 div 维持滚动高度（避免 CLS）。
 * 主要用于 ReportPage 这种 15+ 图表 / 多段 Collapse 场景，避免一次性挂载
 * 全部 chart instance 把首屏拖死。
 *
 * 默认行为：
 * - rootMargin: '300px' — 视口外 300px 就开始预挂载，体感无感
 * - once: true — 挂载后不再卸载（图表实例丢失会要求重建，体验差）
 * - placeholderHeight: 200 — 占位高度，建议接近真实图表高度避免滚动跳动
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface LazyMountProps {
  /** 距视口边缘多远开始挂载，IntersectionObserver rootMargin 格式。默认 '300px' */
  rootMargin?: string
  /** 一次挂载后永不卸载。默认 true */
  once?: boolean
  /** 未挂载时占位高度（px 数值或 CSS 字符串），默认 200 */
  placeholderHeight?: number | string
  /** 占位时显示的内容（默认空） */
  placeholder?: ReactNode
  className?: string
  style?: React.CSSProperties
  children: ReactNode
}

const LazyMount = ({
  rootMargin = '300px',
  once = true,
  placeholderHeight = 200,
  placeholder,
  className,
  style,
  children,
}: LazyMountProps) => {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (shown && once) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // 老浏览器降级：直接挂载
      setShown(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting)
        if (visible) {
          setShown(true)
          if (once) io.disconnect()
        } else if (!once) {
          setShown(false)
        }
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin, once, shown])

  return (
    <div
      ref={ref}
      className={className}
      style={
        shown
          ? style
          : {
              minHeight:
                typeof placeholderHeight === 'number' ? `${placeholderHeight}px` : placeholderHeight,
              ...style,
            }
      }
    >
      {shown ? children : placeholder ?? null}
    </div>
  )
}

export default LazyMount
