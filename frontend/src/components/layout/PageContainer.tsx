/**
 * AlphaPilot 通用页面容器
 *
 * 替代散落各页的 `<div style={{ padding: 24 }}><h1>...</h1>...</div>`，
 * 提供统一的标题 / 副标题 / 标签 / 操作槽 + 可选 sticky 头。
 *
 * **不**额外加 padding —— 内容区 padding 已由 AppLayout Content 通过 CSS 变量
 * `--ap-content-px / py` 处理；PageContainer 仅做结构与排版。
 *
 * 响应式行为：
 * - 桌面：title + actions 同一行（justify-between，title 左、actions 右）
 * - 移动 (<sm)：actions 自动 wrap 到第二行（flex-wrap）；padding 不变
 *
 * sticky=true 时，header 区域吸顶（top = TopBar 高度），便于长页面始终可见标题。
 */

import { type ReactNode, type CSSProperties } from 'react'

export interface PageContainerProps {
  title?: ReactNode
  /** 在 title 下方一行的小字描述 */
  subtitle?: ReactNode
  /** 与 title 同行右侧的小标签（状态/统计 chip 等） */
  tags?: ReactNode
  /** 与 title 同行右侧的操作按钮组（移动端自动 wrap） */
  actions?: ReactNode
  /** 顶部全宽提示条（Alert / 衍生说明等） */
  alerts?: ReactNode
  /** 是否吸顶 header */
  sticky?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
}

const PageContainer = ({
  title,
  subtitle,
  tags,
  actions,
  alerts,
  sticky = false,
  className,
  style,
  children,
}: PageContainerProps) => {
  const showHeader = title != null || subtitle != null || tags != null || actions != null

  const headerStyle: CSSProperties = sticky
    ? {
        position: 'sticky',
        top: 'var(--ap-header-h, 56px)',
        zIndex: 10,
        background: 'var(--ap-bg)',
        marginInline: 'calc(-1 * var(--ap-content-px))',
        paddingInline: 'var(--ap-content-px)',
        paddingBlock: '12px 12px',
        borderBottom: '1px solid var(--ap-border-muted)',
        marginBottom: 16,
      }
    : {
        paddingBottom: 12,
        borderBottom: '1px solid var(--ap-border-muted)',
        marginBottom: 16,
      }

  return (
    <div className={className} style={style}>
      {showHeader && (
        <div style={headerStyle}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              columnGap: 16,
              rowGap: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                minWidth: 0, // 让 title 在窄屏可被压缩
              }}
            >
              {title != null && (
                <h1
                  style={{
                    margin: 0,
                    fontSize: 20,
                    lineHeight: 1.4,
                    fontWeight: 600,
                    color: 'var(--ap-text)',
                  }}
                >
                  {title}
                </h1>
              )}
              {tags != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {tags}
                </div>
              )}
            </div>
            {actions != null && (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  marginLeft: 'auto', // 桌面靠右；移动端 wrap 后失效
                }}
              >
                {actions}
              </div>
            )}
          </div>
          {subtitle != null && (
            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: 'var(--ap-text-muted)',
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      )}

      {alerts != null && <div style={{ marginBottom: 16 }}>{alerts}</div>}

      {children}
    </div>
  )
}

export default PageContainer
