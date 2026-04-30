/**
 * 组合分析面板：选定一个组合后，展示
 *  - 风险贡献分解（柱图：weight % vs riskShare %）
 *  - 回撤归因（top-5 DD 区间表 + 各策略贡献条）
 * 顶部提供「Max Sharpe / Min Var」自动权重按钮，应用到当前选中组合。
 */

import { useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Empty, Row, Segmented, Space, Tooltip, Typography } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import type { TrainingCompareRecord } from '@/types'
import ChartContainer from '@/components/responsive/ChartContainer'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'
import {
  computePortfolioCumulative,
  type PortfolioCombo,
} from './PortfolioCombo'
import {
  computeDrawdownAttribution,
  computeMaxSharpeWeights,
  computeMinVarianceWeights,
  computePortfolioMetrics,
  computeRiskContributions,
  type DrawdownPeriod,
  type PortfolioMetrics,
} from './MultiStrategyAnalytics'
import KpiGrid from './KpiCard'

const { Text } = Typography

interface Props {
  records: TrainingCompareRecord[]
  combos: PortfolioCombo[]
  onUpdateCombo: (key: string, weights: Record<string | number, number>) => void
}

const PortfolioAnalyticsPanel: React.FC<Props> = ({ records, combos, onUpdateCombo }) => {
  const [selectedKey, setSelectedKey] = useState<string | null>(combos[0]?.key ?? null)

  // combos 变化时同步选中
  const activeKey = useMemo(() => {
    if (selectedKey && combos.some((c) => c.key === selectedKey)) return selectedKey
    return combos[0]?.key ?? null
  }, [combos, selectedKey])

  const activeCombo = combos.find((c) => c.key === activeKey)

  const strategyInputs = useMemo(
    () =>
      records.map((r) => ({
        id: r.id,
        name: r.name || `#${r.id}`,
        dates: r.merged_report?.dates ?? [],
        cumulative: r.merged_report?.cumulative_return ?? [],
      })),
    [records],
  )

  const riskAnalysis = useMemo(
    () => (activeCombo ? computeRiskContributions(strategyInputs, activeCombo.weights) : null),
    [strategyInputs, activeCombo],
  )

  const drawdownPeriods = useMemo(
    () => (activeCombo ? computeDrawdownAttribution(strategyInputs, activeCombo.weights, 5) : []),
    [strategyInputs, activeCombo],
  )

  const handleAutoWeight = (mode: 'maxSharpe' | 'minVar') => {
    if (!activeCombo) return
    const result =
      mode === 'maxSharpe'
        ? computeMaxSharpeWeights(strategyInputs)
        : computeMinVarianceWeights(strategyInputs)
    if (!result) {
      // 协方差奇异（极端共线性等），无法求解 — UI 提示让用户察觉
      return
    }
    onUpdateCombo(activeCombo.key, result.weights)
  }

  const optimizedSummary = useMemo(() => {
    if (!activeCombo) return null
    // 用当前 weights 重算夏普/波动率作为对照
    const r = computeRiskContributions(strategyInputs, activeCombo.weights)
    return r ? r.portfolioVolatility : null
  }, [strategyInputs, activeCombo])

  // KPI 指标 + 单策略 best 对比 (Phase 2)
  const portfolioMetrics = useMemo(
    () => (activeCombo ? computePortfolioMetrics(strategyInputs, activeCombo.weights) : null),
    [strategyInputs, activeCombo],
  )

  const bestSingleStrategy = useMemo(() => computeBestSingleStrategyMetrics(records), [records])

  if (combos.length === 0) {
    return (
      <Empty
        description="先在上方添加策略组合，这里展示其风险贡献分解与回撤归因"
        style={{ padding: 24 }}
      />
    )
  }

  return (
    <div>
      {/* 顶部：组合选择 + 自动权重按钮 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Space size={8} align="center">
          <Text style={{ fontSize: 13, fontWeight: 500 }}>分析组合：</Text>
          {combos.length === 1 ? (
            <Text strong>{combos[0].name}</Text>
          ) : (
            <Segmented
              size="small"
              value={activeKey ?? undefined}
              onChange={(v) => setSelectedKey(String(v))}
              options={combos.map((c) => ({ label: c.name, value: c.key }))}
            />
          )}
        </Space>
        <Space size={8}>
          <Tooltip title="按 Σ⁻¹μ 解析解求最大夏普权重，负权重裁剪到 0 后归一化（长仓近似最优）">
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => handleAutoWeight('maxSharpe')}
            >
              Max Sharpe 权重
            </Button>
          </Tooltip>
          <Tooltip title="最小方差权重 Σ⁻¹·1，长仓裁剪后归一">
            <Button size="small" onClick={() => handleAutoWeight('minVar')}>
              Min Var 权重
            </Button>
          </Tooltip>
        </Space>
      </div>

      {/* 关键指标 KPI（含 vs 单策略最佳 对比 delta） */}
      {portfolioMetrics && bestSingleStrategy && (
        <KpiGrid
          values={portfolioMetricsToValues(portfolioMetrics)}
          bests={bestMetricsToValues(bestSingleStrategy)}
        />
      )}

      {/* 风险贡献分解 */}
      <Card size="small" title="风险贡献分解" style={{ marginBottom: 16 }}>
        {riskAnalysis ? (
          <RiskContributionView analysis={riskAnalysis} />
        ) : (
          <Empty description="无法计算（数据不足或协方差奇异）" style={{ padding: 24 }} />
        )}
      </Card>

      {/* 回撤归因 */}
      <Card size="small" title="回撤归因（Top 5 区间）">
        {drawdownPeriods.length > 0 && activeCombo ? (
          <DrawdownAttributionView
            records={records}
            combo={activeCombo}
            periods={drawdownPeriods}
          />
        ) : (
          <Empty description="组合未出现明显回撤区间" style={{ padding: 24 }} />
        )}
      </Card>

      {optimizedSummary != null && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message={`组合年化波动率: ${(optimizedSummary * 100).toFixed(2)}%`}
          description="风险贡献占比 = 该策略对组合方差的边际贡献 ÷ 组合总方差。riskShare 远高于 weight 的策略对风险偏吃重，可考虑减仓。"
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------
// 风险贡献子视图
// ----------------------------------------------------------
const RiskContributionView: React.FC<{
  analysis: NonNullable<ReturnType<typeof computeRiskContributions>>
}> = ({ analysis }) => {
  const { contributions, portfolioVolatility } = analysis

  const categories = contributions.map((c) => c.strategyName)
  const weights = contributions.map((c) => c.weight * 100)
  const riskShares = contributions.map((c) => c.riskShare * 100)

  const option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v: unknown) => (typeof v === 'number' ? `${v.toFixed(2)}%` : '-'),
    },
    legend: { data: ['权重 %', '风险贡献 %'], top: 0 },
    grid: { left: 60, right: 30, top: 40, bottom: 40 },
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: { fontSize: 11, rotate: categories.some((c) => c.length > 6) ? 20 : 0 },
    },
    yAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
    series: [
      { name: '权重 %', type: 'bar', data: weights, itemStyle: { color: '#1890ff' }, barWidth: '32%' },
      { name: '风险贡献 %', type: 'bar', data: riskShares, itemStyle: { color: '#fa8c16' }, barWidth: '32%' },
    ],
  }

  return (
    <div>
      <ChartContainer library="echarts" height={280} option={option} />
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ap-text-muted)' }}>
        组合年化波动率：<Text strong style={{ color: 'var(--ap-text)' }}>{(portfolioVolatility * 100).toFixed(2)}%</Text>
      </div>
    </div>
  )
}

// ----------------------------------------------------------
// 回撤归因子视图
// 上：组合累积收益曲线 + Top-N 回撤区间用浅红 markArea 标记 + 区间编号
// 下：详情表（区间起止 / 持续天数 / 回撤幅度 / 各策略贡献）
// ----------------------------------------------------------
const DrawdownAttributionView: React.FC<{
  records: TrainingCompareRecord[]
  combo: PortfolioCombo
  periods: DrawdownPeriod[]
}> = ({ records, combo, periods }) => {
  // 计算组合累积收益曲线（用 PortfolioCombo 的 computePortfolioCumulative 同口径）
  const portfolioCurve = useMemo(() => {
    const inputs = records
      .map((r) => ({
        id: r.id,
        dates: r.merged_report?.dates ?? [],
        cumulative: r.merged_report?.cumulative_return ?? [],
      }))
      .filter((s) => s.dates.length > 0 && s.cumulative.length > 0)
    return computePortfolioCumulative(inputs, combo.weights)
  }, [records, combo.weights])

  // markArea：每个 DD 区间一条带；颜色按 |drawdown| 强度渐变（最深红 → 浅红）
  const maxAbsDD = Math.max(...periods.map((p) => Math.abs(p.drawdown)))
  const markAreaData = periods.map((p, i) => {
    const intensity = maxAbsDD > 0 ? Math.abs(p.drawdown) / maxAbsDD : 1
    const opacity = 0.10 + intensity * 0.18 // 0.10..0.28
    return [
      {
        xAxis: p.startDate,
        itemStyle: { color: `rgba(239, 68, 68, ${opacity.toFixed(3)})` },
        label: {
          show: true,
          position: 'insideTop' as const,
          color: 'var(--ap-text)',
          fontSize: 11,
          fontWeight: 'bold' as const,
          formatter: `#${i + 1}`,
        },
      },
      { xAxis: p.endDate },
    ]
  })

  // 把区间细节做成 dateRange→period 的查找表，给 tooltip 用
  const periodByStartDate = new Map<string, { idx: number; period: DrawdownPeriod }>()
  periods.forEach((p, idx) => periodByStartDate.set(p.startDate, { idx, period: p }))

  const option = {
    tooltip: {
      trigger: 'axis' as const,
      valueFormatter: (v: unknown) => (typeof v === 'number' ? `${v.toFixed(2)}%` : '-'),
    },
    grid: { left: 60, right: 30, top: 20, bottom: 50 },
    xAxis: {
      type: 'category' as const,
      data: portfolioCurve.dates,
      axisLabel: { fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      axisLabel: { formatter: (v: number) => `${v.toFixed(0)}%` },
    },
    dataZoom: [
      { type: 'slider', start: 0, end: 100, height: 20, bottom: 5 },
      { type: 'inside', start: 0, end: 100 },
    ],
    series: [
      {
        name: '组合累积收益',
        type: 'line' as const,
        data: portfolioCurve.cumulative.map((v) => (v == null ? null : v * 100)),
        showSymbol: false,
        lineStyle: { width: 2, color: '#3B82F6' },
        areaStyle: {
          color: {
            type: 'linear' as const,
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(59, 130, 246, 0.20)' },
              { offset: 1, color: 'rgba(59, 130, 246, 0.02)' },
            ],
          },
        },
        markArea: {
          itemStyle: { color: 'rgba(239, 68, 68, 0.15)' },
          data: markAreaData,
          silent: false,
        },
      },
    ],
  }

  // 详情表
  const columns: ResponsiveColumn<DrawdownPeriod & { key: string; index: number }>[] = [
    {
      title: '#',
      dataIndex: 'index',
      key: 'index',
      width: 50,
      align: 'center',
      mobileRole: 'badge',
      render: (i: number) => (
        <Text strong style={{ fontFamily: "'SF Mono', monospace" }}>
          #{i + 1}
        </Text>
      ),
    },
    {
      title: '区间',
      key: 'range',
      mobileRole: 'title',
      render: (_, p) => (
        <Text style={{ fontSize: 12 }}>
          {p.startDate} → <Text type="danger" strong>{p.troughDate}</Text> → {p.endDate}
        </Text>
      ),
    },
    {
      title: '回撤幅度',
      key: 'drawdown',
      width: 110,
      align: 'right',
      mobileRole: 'metric',
      render: (_, p) => (
        <Text strong style={{ color: 'var(--ap-market-down)', fontFamily: "'SF Mono', monospace" }}>
          {(p.drawdown * 100).toFixed(2)}%
        </Text>
      ),
    },
    {
      title: '持续天数',
      dataIndex: 'durationDays',
      key: 'duration',
      width: 90,
      align: 'right',
      mobileRole: 'metric',
      render: (n: number) => `${n} 天`,
    },
    {
      title: '各策略贡献',
      key: 'attribution',
      mobileRole: 'subtitle',
      render: (_, p) => (
        <Space size={[8, 4]} wrap>
          {p.perStrategyContribution.map((c) => (
            <Text
              key={String(c.id)}
              style={{
                fontSize: 11,
                fontFamily: "'SF Mono', monospace",
                color: c.contribution < 0 ? 'var(--ap-market-down)' : 'var(--ap-market-up)',
              }}
            >
              {c.name}: {(c.contribution * 100).toFixed(2)}%
            </Text>
          ))}
        </Space>
      ),
    },
  ]

  const dataSource = periods.map((p, i) => ({ ...p, key: `${p.startDate}-${i}`, index: i }))

  return (
    <div>
      <ChartContainer library="echarts" height={360} option={option} />
      <div style={{ marginTop: 12 }}>
        <ResponsiveTable
          dataSource={dataSource}
          columns={columns}
          rowKey="key"
          pagination={false}
          size="small"
          scrollX={830}
        />
      </div>
    </div>
  )
}

// ============================================================
// 计算单策略最佳值 + 类型适配（KpiGrid 用 Record<string,number> 接口）
// ============================================================

export interface BestMetrics {
  totalReturn: number | null
  annualizedReturn: number | null
  sharpe: number | null
  sortino: number | null
  calmar: number | null
  maxDrawdown: number | null
  annualVolatility: number | null
  winRate: number | null
}

const safeMax = (xs: Array<number | null | undefined>): number | null => {
  const valid = xs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return valid.length ? Math.max(...valid) : null
}
const safeMin = (xs: Array<number | null | undefined>): number | null => {
  const valid = xs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return valid.length ? Math.min(...valid) : null
}

export const computeBestSingleStrategyMetrics = (records: TrainingCompareRecord[]): BestMetrics => {
  const m = (key: string) =>
    records.map((r) => (r.merged_metrics?.[key] as number | undefined) ?? null)
  return {
    totalReturn: safeMax(m('total_return')),
    annualizedReturn: safeMax(m('annualized_return')),
    sharpe: safeMax(m('sharpe_ratio')),
    sortino: safeMax(m('sortino_ratio')),
    calmar: safeMax(m('calmar_ratio')),
    // max_drawdown 是负数；最佳 = 最接近 0 = max
    maxDrawdown: safeMax(m('max_drawdown')),
    // 年化波动率 = std_daily * sqrt(252)；最佳 = 最低
    annualVolatility: (() => {
      const stds = m('std_daily_return')
      const minStd = safeMin(stds)
      return minStd !== null ? minStd * Math.sqrt(252) : null
    })(),
    winRate: safeMax(m('win_rate')),
  }
}

const portfolioMetricsToValues = (m: PortfolioMetrics): Record<string, number | null> => ({
  totalReturn: m.totalReturn,
  annualizedReturn: m.annualizedReturn,
  sharpe: m.sharpe,
  sortino: m.sortino,
  calmar: m.calmar,
  maxDrawdown: m.maxDrawdown,
  annualVolatility: m.annualVolatility,
  winRate: m.winRate,
})

const bestMetricsToValues = (b: BestMetrics): Record<string, number | null> => ({
  totalReturn: b.totalReturn,
  annualizedReturn: b.annualizedReturn,
  sharpe: b.sharpe,
  sortino: b.sortino,
  calmar: b.calmar,
  maxDrawdown: b.maxDrawdown,
  annualVolatility: b.annualVolatility,
  winRate: b.winRate,
})

export default PortfolioAnalyticsPanel
