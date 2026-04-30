/**
 * AlphaPilot KPI 卡组
 *
 * 替代各页面零散的 4 张 Statistic 卡 Row+Col 实现，统一视觉语言：
 * - 左侧 tone 染色图标徽章 + 右侧 label/value/delta 排版
 * - 默认列数：xs:1 / sm:2 / md:2 / lg:4 / xl:4
 * - hoverable=true 当 onClick 提供时生效
 *
 * 适配 QuantDinger 截图的 KPI 卡视觉。
 */

import { type ReactNode } from 'react'
import { Card, Col, Row, Skeleton } from 'antd'

export type MetricTone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral'

export interface MetricDelta {
  value: number | string
  /** 单位后缀，如 '%' '$' */
  suffix?: string
  /** 上涨绿/下跌红视场景而定，由调用方明示 */
  tone?: 'up' | 'down' | 'neutral'
}

export interface MetricCard {
  key: string
  label: ReactNode
  value: ReactNode
  delta?: MetricDelta
  /** 左侧图标徽章（图标组件元素） */
  icon?: ReactNode
  /** 影响图标徽章配色 */
  tone?: MetricTone
  onClick?: () => void
}

export interface MetricCardGridProps {
  items: MetricCard[]
  /** 各断点列数，默认 {xs:1, sm:2, md:2, lg:4, xl:4} */
  columns?: Partial<Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', number>>
  loading?: boolean
  /** 单元卡片间距（gutter）。默认 [16, 16] */
  gutter?: [number, number]
  className?: string
  style?: React.CSSProperties
}

const DEFAULT_COLUMNS: Required<NonNullable<MetricCardGridProps['columns']>> = {
  xs: 1,
  sm: 2,
  md: 2,
  lg: 4,
  xl: 4,
}

/** tone → {图标前景色, 图标徽章背景色} */
const TONE_STYLES: Record<MetricTone, { fg: string; bg: string }> = {
  primary: { fg: 'var(--ap-brand-primary)', bg: 'rgba(59, 130, 246, 0.16)' },
  success: { fg: 'var(--ap-success)', bg: 'rgba(34, 197, 94, 0.16)' },
  warning: { fg: 'var(--ap-warning)', bg: 'rgba(245, 158, 11, 0.16)' },
  danger: { fg: 'var(--ap-danger)', bg: 'rgba(239, 68, 68, 0.16)' },
  neutral: { fg: 'var(--ap-text-muted)', bg: 'rgba(148, 163, 184, 0.16)' },
}

const colSpan = (n?: number): number => Math.floor(24 / Math.max(1, Math.min(24, n ?? 1)))

interface MetricCardItemProps {
  item: MetricCard
}

const MetricCardItem = ({ item }: MetricCardItemProps) => {
  const tone = TONE_STYLES[item.tone ?? 'neutral']
  const deltaColor =
    item.delta?.tone === 'up'
      ? 'var(--ap-market-up)'
      : item.delta?.tone === 'down'
        ? 'var(--ap-market-down)'
        : 'var(--ap-text-muted)'
  const deltaArrow =
    item.delta?.tone === 'up' ? '▲ ' : item.delta?.tone === 'down' ? '▼ ' : ''

  return (
    <Card
      hoverable={!!item.onClick}
      onClick={item.onClick}
      style={{
        background: 'var(--ap-panel)',
        border: '1px solid var(--ap-border-muted)',
        borderRadius: 12,
        boxShadow: 'var(--ap-elevation-1)',
        cursor: item.onClick ? 'pointer' : 'default',
        height: '100%',
      }}
      styles={{ body: { padding: 24 } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {item.icon != null && (
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 10,
              background: tone.bg,
              color: tone.fg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
              flexShrink: 0,
            }}
          >
            {item.icon}
          </div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 12,
              color: 'var(--ap-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 6,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {item.label}
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: 'var(--ap-text)',
              lineHeight: 1.15,
              letterSpacing: '-0.02em',
              wordBreak: 'break-word',
            }}
          >
            {item.value}
          </div>
          {item.delta != null && (
            <div
              style={{
                fontSize: 12,
                marginTop: 6,
                color: deltaColor,
                whiteSpace: 'nowrap',
              }}
            >
              {deltaArrow}
              {item.delta.value}
              {item.delta.suffix ?? ''}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

const SkeletonCard = () => (
  <Card
    style={{
      background: 'var(--ap-panel)',
      border: '1px solid var(--ap-border-muted)',
      borderRadius: 12,
      height: '100%',
    }}
    styles={{ body: { padding: 24 } }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <Skeleton.Avatar active size={48} shape="square" />
      <div style={{ flex: 1 }}>
        <Skeleton active paragraph={{ rows: 1, width: '60%' }} title={{ width: '80%' }} />
      </div>
    </div>
  </Card>
)

const MetricCardGrid = ({
  items,
  columns,
  loading = false,
  gutter = [16, 16],
  className,
  style,
}: MetricCardGridProps) => {
  const cols = { ...DEFAULT_COLUMNS, ...(columns ?? {}) }

  const colProps = {
    xs: colSpan(cols.xs),
    sm: colSpan(cols.sm),
    md: colSpan(cols.md),
    lg: colSpan(cols.lg),
    xl: colSpan(cols.xl),
  }

  if (loading) {
    const placeholderCount = Math.max(items.length || 4, 1)
    return (
      <Row className={className} style={style} gutter={gutter}>
        {Array.from({ length: placeholderCount }).map((_, i) => (
          <Col key={i} {...colProps}>
            <SkeletonCard />
          </Col>
        ))}
      </Row>
    )
  }

  return (
    <Row className={className} style={style} gutter={gutter}>
      {items.map((item) => (
        <Col key={item.key} {...colProps}>
          <MetricCardItem item={item} />
        </Col>
      ))}
    </Row>
  )
}

export default MetricCardGrid
