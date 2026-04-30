/**
 * 组合分析面板：选定一个组合后，展示
 *  - 风险贡献分解（柱图：weight % vs riskShare %）
 *  - 回撤归因（top-5 DD 区间表 + 各策略贡献条）
 * 顶部提供「Max Sharpe / Min Var」自动权重按钮，应用到当前选中组合。
 */

import { useMemo, useState } from 'react'
import { Alert, Button, Card, Empty, Segmented, Space, Tooltip, Typography } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import type { TrainingCompareRecord } from '@/types'
import ChartContainer from '@/components/responsive/ChartContainer'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'
import type { PortfolioCombo } from './PortfolioCombo'
import {
  computeDrawdownAttribution,
  computeMaxSharpeWeights,
  computeMinVarianceWeights,
  computeRiskContributions,
  type DrawdownPeriod,
} from './MultiStrategyAnalytics'

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
        {drawdownPeriods.length > 0 ? (
          <DrawdownAttributionView periods={drawdownPeriods} />
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
// ----------------------------------------------------------
const DrawdownAttributionView: React.FC<{ periods: DrawdownPeriod[] }> = ({ periods }) => {
  const columns: ResponsiveColumn<DrawdownPeriod & { key: string }>[] = [
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
      mobileRole: 'badge',
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

  const dataSource = periods.map((p, i) => ({ ...p, key: `${p.startDate}-${i}` }))

  return (
    <ResponsiveTable
      dataSource={dataSource}
      columns={columns}
      rowKey="key"
      pagination={false}
      size="small"
      scrollX={780}
    />
  )
}

export default PortfolioAnalyticsPanel
