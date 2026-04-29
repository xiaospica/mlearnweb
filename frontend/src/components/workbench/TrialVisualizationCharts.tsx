/**
 * V3.8 trial 可视化：3 个 echarts 图组件 + 共享 utility
 *
 * - ParetoScatterChart：双轴散点 + 帕累托前沿点描金边（identifier "既好又稳" 的 trial）
 * - ParallelCoordinatesChart：10 维超参 + valid_sharpe 末轴；trial 线按 sharpe 着色
 * - ParamImportanceChart：横向柱状图（Optuna fANOVA importance）
 *
 * 数据源：tuning_trials 表（前 2 个图直接从 trials 数组算）+ /param-importance API（第 3 个图）。
 */

import React, { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import { Empty, Select, Space, Typography, Alert } from 'antd'
import type { TuningTrial, ParamImportanceResult } from '@/types/tuning'

const { Text } = Typography

// 双轴 Pareto 散点：x 轴可选 overfit_ratio / max_drawdown，y 轴可选 valid_sharpe / test_sharpe
type XAxisKey = 'overfit_ratio' | 'test_max_drawdown'
type YAxisKey = 'valid_sharpe' | 'test_sharpe'

const X_AXIS_OPTIONS: Record<XAxisKey, { label: string; pickFromMetrics: (m: Record<string, number | null>) => number | null; lowerBetter: boolean }> = {
  overfit_ratio: {
    label: 'overfit_ratio（越低越稳，无过拟合）',
    pickFromMetrics: (m) => null,
    lowerBetter: true,
  },
  test_max_drawdown: {
    label: 'test_max_drawdown（越低越好）',
    pickFromMetrics: (m) => (typeof m.test_max_drawdown === 'number' ? m.test_max_drawdown : null),
    lowerBetter: true,
  },
}

const Y_AXIS_OPTIONS: Record<YAxisKey, { label: string }> = {
  valid_sharpe: { label: 'valid_sharpe（越高越好）' },
  test_sharpe: { label: 'test_sharpe（越高越好）' },
}

/** 计算帕累托前沿（在 x 轴 lowerBetter, y 轴 higherBetter 假设下）：
 * 一个点是前沿点 ⇔ 不存在另一个点在两个轴上都不差 + 至少一轴更好。
 * 复杂度 O(n²)，n < 500 完全够用。
 */
function computeParetoFrontier(
  points: { x: number; y: number; idx: number }[],
  xLowerBetter: boolean,
): Set<number> {
  const frontier = new Set<number>()
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    let dominated = false
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue
      const b = points[j]
      const xBetter = xLowerBetter ? b.x <= a.x : b.x >= a.x
      const yBetter = b.y >= a.y
      const strictlyBetter = xLowerBetter ? b.x < a.x || b.y > a.y : b.x > a.x || b.y > a.y
      if (xBetter && yBetter && strictlyBetter) {
        dominated = true
        break
      }
    }
    if (!dominated) frontier.add(a.idx)
  }
  return frontier
}

// ---------------------------------------------------------------------------
// Pareto 散点图
// ---------------------------------------------------------------------------

export const ParetoScatterChart: React.FC<{
  trials: TuningTrial[]
  /** 点击点时联动外部（如选中 trial） */
  onTrialClick?: (trialNumber: number) => void
}> = ({ trials, onTrialClick }) => {
  const [xAxis, setXAxis] = React.useState<XAxisKey>('overfit_ratio')
  const [yAxis, setYAxis] = React.useState<YAxisKey>('valid_sharpe')

  const points = useMemo(() => {
    const xCfg = X_AXIS_OPTIONS[xAxis]
    return trials
      .filter((t) => t.state === 'completed')
      .map((t, idx) => {
        const xVal =
          xAxis === 'overfit_ratio'
            ? t.overfit_ratio
            : xCfg.pickFromMetrics((t.metrics ?? {}) as Record<string, number | null>)
        const yVal = yAxis === 'valid_sharpe' ? t.valid_sharpe : t.test_sharpe
        if (xVal == null || yVal == null) return null
        return {
          idx,
          trial_number: t.trial_number,
          x: xVal,
          y: yVal,
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
  }, [trials, xAxis, yAxis])

  const xCfg = X_AXIS_OPTIONS[xAxis]
  const frontierIdx = useMemo(
    () => computeParetoFrontier(points, xCfg.lowerBetter),
    [points, xCfg.lowerBetter],
  )

  const seriesData = points.map((p) => ({
    value: [p.x, p.y, p.trial_number],
    itemStyle: {
      color: frontierIdx.has(p.idx) ? '#faad14' : '#1677ff',
      borderColor: frontierIdx.has(p.idx) ? '#fa8c16' : 'transparent',
      borderWidth: frontierIdx.has(p.idx) ? 2 : 0,
      opacity: 0.85,
    },
    symbolSize: frontierIdx.has(p.idx) ? 12 : 8,
  }))

  const option = {
    grid: { left: 60, right: 30, top: 30, bottom: 60 },
    xAxis: {
      type: 'value',
      name: xCfg.label,
      nameLocation: 'middle',
      nameGap: 30,
      axisLine: { lineStyle: { color: '#999' } },
    },
    yAxis: {
      type: 'value',
      name: Y_AXIS_OPTIONS[yAxis].label,
      nameLocation: 'middle',
      nameGap: 50,
      axisLine: { lineStyle: { color: '#999' } },
    },
    tooltip: {
      trigger: 'item',
      formatter: (p: { value: [number, number, number] }) =>
        `trial #${p.value[2]}<br/>` +
        `${X_AXIS_OPTIONS[xAxis].label.split('（')[0]}: ${p.value[0].toFixed(4)}<br/>` +
        `${Y_AXIS_OPTIONS[yAxis].label.split('（')[0]}: ${p.value[1].toFixed(4)}`,
    },
    series: [
      {
        type: 'scatter',
        data: seriesData,
        emphasis: { focus: 'series', itemStyle: { borderColor: '#000', borderWidth: 2 } },
      },
    ],
  }

  if (points.length === 0) {
    return <Empty description="无数据点（trials 全部不含选定指标）" />
  }

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>X 轴:</Text>
        <Select<XAxisKey>
          size="small"
          value={xAxis}
          onChange={setXAxis}
          options={[
            { value: 'overfit_ratio', label: 'overfit_ratio' },
            { value: 'test_max_drawdown', label: 'test_max_drawdown' },
          ]}
          style={{ width: 180 }}
        />
        <Text type="secondary" style={{ fontSize: 12, marginLeft: 12 }}>Y 轴:</Text>
        <Select<YAxisKey>
          size="small"
          value={yAxis}
          onChange={setYAxis}
          options={[
            { value: 'valid_sharpe', label: 'valid_sharpe' },
            { value: 'test_sharpe', label: 'test_sharpe' },
          ]}
          style={{ width: 160 }}
        />
        <Text type="secondary" style={{ fontSize: 11, marginLeft: 12 }}>
          🟡 <Text style={{ color: '#fa8c16' }}>金边大点 = 帕累托前沿（不被其他 trial 全方位支配）</Text>
        </Text>
      </Space>
      <ReactECharts
        option={option}
        style={{ height: 420 }}
        onEvents={{
          click: (params: { value?: [number, number, number] }) => {
            if (onTrialClick && params.value && params.value.length >= 3) {
              onTrialClick(params.value[2])
            }
          },
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 平行坐标图
// ---------------------------------------------------------------------------

const PARAM_AXES: Array<{ key: string; label: string; logScale?: boolean }> = [
  { key: 'learning_rate', label: 'lr', logScale: true },
  { key: 'num_leaves', label: 'leaves' },
  { key: 'max_depth', label: 'depth' },
  { key: 'min_child_samples', label: 'min_child' },
  { key: 'lambda_l1', label: 'L1' },
  { key: 'lambda_l2', label: 'L2' },
  { key: 'colsample_bytree', label: 'colsample' },
  { key: 'subsample', label: 'subsample' },
  { key: 'subsample_freq', label: 'sub_freq' },
  { key: 'early_stopping_rounds', label: 'early_stop' },
]

export const ParallelCoordinatesChart: React.FC<{
  trials: TuningTrial[]
}> = ({ trials }) => {
  const completed = useMemo(
    () => trials.filter((t) => t.state === 'completed' && t.valid_sharpe != null),
    [trials],
  )
  const sharpes = completed.map((t) => t.valid_sharpe!).filter((v) => Number.isFinite(v))
  const sharpeMin = Math.min(...sharpes)
  const sharpeMax = Math.max(...sharpes)

  const data = completed.map((t) => {
    const params = t.params || {}
    return [
      ...PARAM_AXES.map((ax) => {
        const v = params[ax.key]
        return typeof v === 'number' ? v : null
      }),
      t.valid_sharpe ?? null,
    ]
  })

  const option = {
    parallelAxis: [
      ...PARAM_AXES.map((ax, i) => ({
        dim: i,
        name: ax.label,
        type: 'value' as const,
        scale: true,
        nameLocation: 'end' as const,
        nameTextStyle: { fontSize: 11, color: '#666' },
        axisLabel: { fontSize: 9, color: '#999' },
      })),
      {
        dim: PARAM_AXES.length,
        name: 'valid_sharpe',
        type: 'value' as const,
        scale: true,
        nameLocation: 'end' as const,
        nameTextStyle: { fontSize: 11, color: '#1677ff', fontWeight: 'bold' as const },
        axisLabel: { fontSize: 9, color: '#1677ff' },
      },
    ],
    parallel: {
      left: 60,
      right: 80,
      top: 50,
      bottom: 60,
      parallelAxisDefault: {
        type: 'value' as const,
        nameTextStyle: { fontSize: 11 },
      },
    },
    visualMap: {
      type: 'continuous' as const,
      min: Number.isFinite(sharpeMin) ? sharpeMin : 0,
      max: Number.isFinite(sharpeMax) ? sharpeMax : 1,
      dimension: PARAM_AXES.length,
      inRange: { color: ['#ff4d4f', '#faad14', '#52c41a'] },
      calculable: true,
      orient: 'vertical' as const,
      right: 5,
      top: 'middle' as const,
      itemWidth: 12,
      textStyle: { fontSize: 10 },
    },
    series: [
      {
        type: 'parallel' as const,
        lineStyle: { width: 1, opacity: 0.5 },
        data,
      },
    ],
    tooltip: {
      trigger: 'item' as const,
      formatter: (p: { dataIndex: number }) => {
        const t = completed[p.dataIndex]
        if (!t) return ''
        return (
          `trial #${t.trial_number}<br/>` +
          `valid_sharpe: ${t.valid_sharpe?.toFixed(4) ?? '—'}<br/>` +
          PARAM_AXES.map((ax) => {
            const v = (t.params || {})[ax.key]
            return `${ax.label}: ${typeof v === 'number' ? v.toFixed(4) : v ?? '—'}`
          }).join('<br/>')
        )
      },
    },
  }

  if (completed.length === 0) {
    return <Empty description="无 completed trial" />
  }

  return (
    <div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
        每条线 = 1 trial；颜色按 valid_sharpe（红=低，绿=高）；可在轴上拖动 brush 框选区间过滤
      </Text>
      <ReactECharts option={option} style={{ height: 480 }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 参数重要性柱状图
// ---------------------------------------------------------------------------

export const ParamImportanceChart: React.FC<{
  result: ParamImportanceResult | undefined
  loading: boolean
}> = ({ result, loading }) => {
  if (loading) return <Empty description="加载 fANOVA 计算结果中…" />
  if (!result) return <Empty description="无数据" />
  if (result.error) {
    return <Alert type="warning" message="无法计算参数重要性" description={result.error} showIcon />
  }
  if (result.importances.length === 0) {
    return <Empty description="无 importance 数据" />
  }

  // 显示时反转：让最重要的在顶部
  const reversed = [...result.importances].reverse()
  const option = {
    grid: { left: 130, right: 40, top: 20, bottom: 30 },
    xAxis: {
      type: 'value',
      name: 'importance',
      max: Math.max(...result.importances.map((r) => r.importance)) * 1.1,
    },
    yAxis: {
      type: 'category',
      data: reversed.map((r) => r.param),
      axisLabel: { fontSize: 11, color: '#333' },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ value: number; name: string }>) =>
        params
          .map(
            (p) =>
              `${p.name}: <b>${p.value.toFixed(4)}</b>（占总贡献 ${(
                (p.value /
                  reversed.reduce((s, r) => s + r.importance, 0)) *
                100
              ).toFixed(1)}%）`,
          )
          .join('<br/>'),
    },
    series: [
      {
        type: 'bar' as const,
        data: reversed.map((r, i) => ({
          value: r.importance,
          itemStyle: {
            color:
              i === reversed.length - 1
                ? '#52c41a'
                : i === reversed.length - 2
                  ? '#1677ff'
                  : '#69b1ff',
          },
        })),
        label: {
          show: true,
          position: 'right' as const,
          formatter: (p: { value: number }) => p.value.toFixed(3),
          fontSize: 10,
        },
      },
    ],
  }

  return (
    <div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
        Optuna {result.evaluator === 'fanova' ? 'fANOVA' : 'Mean Decrease Impurity'} 算法 · 基于 {result.n_completed_trials} 个完成 trial · 数值越高 = 该参数对 valid_sharpe 影响越大
      </Text>
      <ReactECharts option={option} style={{ height: Math.max(280, reversed.length * 36 + 80) }} />
    </div>
  )
}
