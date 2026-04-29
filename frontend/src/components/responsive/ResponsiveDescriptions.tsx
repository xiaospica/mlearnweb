/**
 * AlphaPilot 响应式描述列表
 *
 * 包 AntD <Descriptions>，在 <md (移动) 切换为扁平 <dl>-style 列表
 * （摆脱 bordered 网格在窄屏被拉伸成超高表的尴尬）。
 *
 * 默认列数：xxl:4 / xl:3 / lg:2 / md:2 / sm:1 / xs:1
 *
 * 用法：
 *   <ResponsiveDescriptions
 *     bordered
 *     items={[
 *       { label: '创建时间', value: '2026-04-29 23:05' },
 *       { label: '运行模式', value: <Tag>滚动</Tag> },
 *       ...
 *     ]}
 *   />
 *
 * 移动端样式：dt 用 `--ap-text-muted` 小字、dd 用 `--ap-text` 正常字号，
 * 上下排列；不渲染 bordered（即使 prop 传了）。
 */

import { type ReactNode, Fragment } from 'react'
import { Descriptions, type DescriptionsProps } from 'antd'
import { useIsMobile } from '@/hooks/useBreakpoint'

export interface ResponsiveDescriptionItem {
  /** 唯一 key，建议显式传以避免 React 警告 */
  key?: string | number
  label: ReactNode
  value: ReactNode
  /** 桌面 Descriptions 中的列跨度（默认 1） */
  span?: number
}

export interface ResponsiveDescriptionsProps {
  items: ResponsiveDescriptionItem[]
  size?: 'small' | 'middle' | 'default'
  /** 桌面是否带边框网格；移动端始终扁平，此项被忽略 */
  bordered?: boolean
  /** 各断点列数，默认 {xxl:4, xl:3, lg:2, md:2, sm:1, xs:1} */
  columns?: Partial<Record<'xxl' | 'xl' | 'lg' | 'md' | 'sm' | 'xs', number>>
  /** 移动端列表行间距：compact 4px / normal 10px。默认 normal */
  density?: 'compact' | 'normal'
  /** 桌面 Descriptions 顶部标题 */
  title?: ReactNode
  /** 桌面 Descriptions 顶部右侧 extra 区域 */
  extra?: ReactNode
  className?: string
  style?: React.CSSProperties
  /** 移动端列表 label 列固定宽度（不传则按内容自适应） */
  mobileLabelWidth?: number | string
}

const DEFAULT_COLUMNS: Required<NonNullable<ResponsiveDescriptionsProps['columns']>> = {
  xxl: 4,
  xl: 3,
  lg: 2,
  md: 2,
  sm: 1,
  xs: 1,
}

const ResponsiveDescriptions = ({
  items,
  size = 'small',
  bordered = false,
  columns,
  density = 'normal',
  title,
  extra,
  className,
  style,
  mobileLabelWidth,
}: ResponsiveDescriptionsProps) => {
  const isMobile = useIsMobile()

  if (isMobile) {
    const rowGap = density === 'compact' ? 4 : 10
    const useTwoColRow = mobileLabelWidth != null
    return (
      <div className={className} style={style}>
        {title && (
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--ap-text)',
              marginBottom: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{title}</span>
            {extra}
          </div>
        )}
        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: useTwoColRow ? `${typeof mobileLabelWidth === 'number' ? `${mobileLabelWidth}px` : mobileLabelWidth} 1fr` : '1fr',
            gap: useTwoColRow ? `${rowGap}px 12px` : `${rowGap}px 0`,
          }}
        >
          {items.map((it, i) => (
            <Fragment key={it.key ?? i}>
              <dt
                style={{
                  fontSize: 12,
                  color: 'var(--ap-text-muted)',
                  margin: 0,
                  alignSelf: useTwoColRow ? 'baseline' : undefined,
                }}
              >
                {it.label}
              </dt>
              <dd
                style={{
                  fontSize: 13,
                  color: 'var(--ap-text)',
                  margin: 0,
                  marginTop: useTwoColRow ? 0 : 2,
                  wordBreak: 'break-word',
                }}
              >
                {it.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>
    )
  }

  // 桌面：AntD Descriptions
  const mergedCols = { ...DEFAULT_COLUMNS, ...(columns ?? {}) }

  const descItems: DescriptionsProps['items'] = items.map((it, i) => ({
    key: String(it.key ?? i),
    label: it.label,
    children: it.value,
    span: it.span,
  }))

  return (
    <Descriptions
      className={className}
      style={style}
      title={title}
      extra={extra}
      bordered={bordered}
      size={size}
      column={mergedCols}
      items={descItems}
    />
  )
}

export default ResponsiveDescriptions
