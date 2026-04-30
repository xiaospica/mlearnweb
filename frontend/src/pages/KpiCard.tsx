/**
 * 通用 KPI 卡（量化回测指标）
 *
 * 用于：
 *  - 单策略 KPI 网格（TrainingComparePage 累计收益卡顶部）
 *  - 组合 KPI 网格（PortfolioAnalyticsPanel）
 *
 * 视觉对位 MetricCardGrid 但语义不同：
 *  - MetricCardGrid 的 delta 用 A 股市场色板（up=红/down=绿）
 *  - 这里的 vs-best 比较用 success/warning 色板（better=绿/worse=黄）
 *  - 比较 line 仅在传入 `best` 时显示
 */

import { Card, Col, Row, Typography } from 'antd'
import type { ReactNode } from 'react'

const { Text } = Typography

export type KpiFormat = 'pct' | 'ratio'

export interface KpiSpec {
  /** 内部 key（用作 React key 也可用作字段） */
  key: string
  /** 显示标签 */
  label: string
  /** 是否 "高 = 好"（决定对比 delta 的着色方向） */
  higherIsBetter: boolean
  /** 显示格式：pct 百分比 / ratio 比率 */
  format: KpiFormat
}

export const fmtPct = (v: number | null | undefined, digits = 2): string =>
  v == null || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(digits)}%`

export const fmtRatio = (v: number | null | undefined, digits = 3): string =>
  v == null || !Number.isFinite(v) ? '-' : v.toFixed(digits)

interface KpiCardProps {
  spec: KpiSpec
  value: number | null | undefined
  /** 可选的对比基准（"单策略最佳"/"组合 vs 单策略" 等场景），不传则不渲染对比行 */
  best?: number | null | undefined
  /** 对比基准的标签（默认 "单策略最佳"） */
  bestLabel?: string
  /** 自定义副标题（替代 vs-best 对比行） */
  subtitle?: ReactNode
}

const KpiCard: React.FC<KpiCardProps> = ({ spec, value, best, bestLabel = '单策略最佳', subtitle }) => {
  const fmt = spec.format === 'pct' ? fmtPct : fmtRatio
  const valueStr = fmt(value)

  let comparisonNode: React.ReactNode = null
  if (best != null && Number.isFinite(best) && value != null && Number.isFinite(value)) {
    const delta = value - best
    const isBetter = spec.higherIsBetter ? delta > 1e-9 : delta < -1e-9
    const isWorse = spec.higherIsBetter ? delta < -1e-9 : delta > 1e-9
    const tone = isBetter
      ? 'var(--ap-success)'
      : isWorse
        ? 'var(--ap-warning)'
        : 'var(--ap-text-muted)'
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '='
    const deltaStr =
      spec.format === 'pct'
        ? `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}pp`
        : `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`
    comparisonNode = (
      <div
        style={{
          fontSize: 11,
          color: tone,
          fontFamily: "'SF Mono', 'Consolas', monospace",
          marginTop: 4,
        }}
      >
        {arrow} {deltaStr}{' '}
        <Text type="secondary" style={{ fontSize: 11 }}>
          ({bestLabel} {fmt(best)})
        </Text>
      </div>
    )
  }

  return (
    <Card
      style={{
        background: 'var(--ap-panel)',
        border: '1px solid var(--ap-border-muted)',
        borderRadius: 12,
        boxShadow: 'var(--ap-elevation-1)',
        height: '100%',
      }}
      styles={{ body: { padding: 16 } }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--ap-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 6,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {spec.label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: 'var(--ap-text)',
          lineHeight: 1.15,
          letterSpacing: '-0.02em',
          fontFamily: "'SF Mono', 'Consolas', monospace",
        }}
      >
        {valueStr}
      </div>
      {comparisonNode}
      {!comparisonNode && subtitle && (
        <div style={{ marginTop: 4 }}>{subtitle}</div>
      )}
    </Card>
  )
}

// ----------------------------------------------------------
// 通用 8 项指标 spec（与后端 _compute_merged_metrics 字段对应）
// ----------------------------------------------------------

/** 通用指标 spec：与后端 merged_metrics 字段名 + 前端 PortfolioMetrics 字段名共用 */
export const STANDARD_KPI_SPECS: KpiSpec[] = [
  { key: 'totalReturn', label: '总收益', higherIsBetter: true, format: 'pct' },
  { key: 'annualizedReturn', label: '年化收益', higherIsBetter: true, format: 'pct' },
  { key: 'sharpe', label: 'Sharpe', higherIsBetter: true, format: 'ratio' },
  { key: 'sortino', label: 'Sortino', higherIsBetter: true, format: 'ratio' },
  { key: 'calmar', label: 'Calmar', higherIsBetter: true, format: 'ratio' },
  { key: 'maxDrawdown', label: '最大回撤', higherIsBetter: true, format: 'pct' }, // dd 负数，越接近 0 越好
  { key: 'annualVolatility', label: '年化波动率', higherIsBetter: false, format: 'pct' },
  { key: 'winRate', label: '胜率', higherIsBetter: true, format: 'pct' },
]

// ----------------------------------------------------------
// KpiGrid：8 卡 × 4 列响应式
// ----------------------------------------------------------

export interface KpiGridProps {
  values: Record<string, number | null | undefined>
  bests?: Record<string, number | null | undefined>
  bestLabel?: string
  /** 标题（可选，渲染在 grid 上方） */
  title?: ReactNode
  /** 标题右侧的副标题/统计信息 */
  titleExtra?: ReactNode
}

const KpiGrid: React.FC<KpiGridProps> = ({ values, bests, bestLabel, title, titleExtra }) => (
  <div style={{ marginBottom: 16 }}>
    {(title || titleExtra) && (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        {title && <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>}
        {titleExtra && <div>{titleExtra}</div>}
      </div>
    )}
    <Row gutter={[12, 12]}>
      {STANDARD_KPI_SPECS.map((spec) => (
        <Col key={spec.key} xs={12} sm={12} md={8} lg={6} xl={6}>
          <KpiCard
            spec={spec}
            value={values[spec.key]}
            best={bests?.[spec.key]}
            bestLabel={bestLabel}
          />
        </Col>
      ))}
    </Row>
  </div>
)

export default KpiGrid
export { KpiCard }
