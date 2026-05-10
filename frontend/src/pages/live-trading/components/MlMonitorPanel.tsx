/**
 * Phase 3.4 — ML 监控面板, 挂在 LiveTradingStrategyDetailPage 的 Tab2.
 *
 * 内容:
 *   1. 顶部 KPI: 最新一日 IC / RankIC / PSI_mean / N_predictions / ICIR / PSI 告警
 *   2. IC / RankIC 时序图 (echarts line)
 *   3. PSI_mean 时序图 + 阈值线 0.25
 *   4. 预测分数直方图 (最新一日)
 *   5. PSI_by_feature top-10 柱图
 *
 * 数据来源:
 *   - /api/live-trading/ml/{nodeId}/{name}/metrics/history  (~30 天)
 *   - /api/live-trading/ml/{nodeId}/{name}/metrics/rolling  (ICIR + 告警)
 *   - /api/live-trading/ml/{nodeId}/{name}/prediction/latest/summary (histogram)
 */

import React, { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Card, Col, Empty, Row, Spin, Statistic, Typography } from 'antd'
import { mlMonitoringService } from '@/services/mlMonitoringService'
import type {
  HistogramBin,
  MetricSnapshot,
  PsiByFeature,
  RollingSummary,
} from '@/services/mlMonitoringService'
import ChartContainer from '@/components/responsive/ChartContainer'
import BacktestDiffPanel from './BacktestDiffPanel'
import PredictionHistoryPanel from './PredictionHistoryPanel'
import HistoricalPositionsCard from './HistoricalPositionsCard'
import {
  ML_MONITOR_FALLBACK_REFRESH_MS,
  ML_MONITOR_STALE_MS,
  liveFallbackInterval,
  liveTradingQueryKeys,
} from '../liveTradingRefresh'

const { Text } = Typography

interface Props {
  nodeId: string
  engine: string
  strategyName: string
  gatewayName?: string
  eventsConnected: boolean
}

function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** 算非 null 数组的均值；空或全 null 返回 null */
function _mean(values: Array<number | null>): number | null {
  const xs = values.filter((v): v is number => Number.isFinite(v as number))
  if (xs.length === 0) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * IC / RankIC / PSI_mean 时序图 —— 样式对齐 ReportPage 的 ICChart：
 *  - 柱状图按值符号着色（>=0 绿 / <0 红）
 *  - markLine: 均值（虚线）+ 零线（实线）+ 可选阈值
 *  - dataZoom inside（与 Report 一致）
 *  - axis chrome 留空，由 ChartContainer 的 applyEChartsThemeChrome 注入主题色
 */
function buildTimeseriesOption(
  history: MetricSnapshot[],
  field: 'ic' | 'rank_ic' | 'psi_mean',
  threshold?: number,
) {
  const dates = history.map((h) => h.trade_date)
  // ReportPage 用 0 替代 null（这样图上有连续柱状），与之一致
  const values = history.map((h) => (h[field] == null ? 0 : (h[field] as number)))
  const meanValue = _mean(values)

  const markLineData: Array<Record<string, unknown>> = [
    { yAxis: 0, name: '零线', lineStyle: { color: '#d9d9d9', type: 'solid' } },
  ]
  if (meanValue != null) {
    markLineData.push({
      yAxis: Number(meanValue.toFixed(4)),
      name: '均值',
      lineStyle: { color: '#8c8c8c', type: 'dashed' },
    })
  }
  if (threshold !== undefined) {
    markLineData.push({
      yAxis: threshold,
      name: `阈值 ${threshold}`,
      lineStyle: { color: '#ff4d4f', type: 'dashed' },
    })
  }

  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#e8e8e8',
      textStyle: { color: '#374151' },
    },
    grid: { left: 60, right: 30, top: 20, bottom: 30 },
    xAxis: {
      type: 'category',
      data: dates,
      axisLabel: { color: '#9ca3af', fontSize: 9 },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: '#9ca3af' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    series: [
      {
        type: 'bar',
        data: values,
        itemStyle: (params: { value: number }) => ({
          color: params.value >= 0 ? '#52c41a' : '#ff4d4f',
          borderRadius: [1, 1, 0, 0],
        }),
        markLine: {
          symbol: 'none',
          data: markLineData,
          label: { formatter: '{c}', color: '#6b7280' },
        },
      },
    ],
    dataZoom: [{ type: 'inside', start: 0, end: 100 }],
  }
}

/**
 * 预测分数直方图 —— 样式对齐 ReportPage 的 PredictionHistogram：
 *  - 单色蓝 (#1677ff) 圆角柱
 *  - tooltip 详细到 bin 边界 + count + prob
 */
function buildHistogramOption(bins: HistogramBin[]) {
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#e8e8e8',
      textStyle: { color: '#374151' },
      formatter: (arr: Array<{ dataIndex: number }>) => {
        const idx = arr[0].dataIndex
        const b = bins[idx]
        return `bin ${b.bin_id}<br/>[${fmtNum(b.edge_lo, 3)}, ${fmtNum(b.edge_hi, 3)})<br/>count: ${b.count}<br/>prob: ${fmtNum(b.probability, 4)}`
      },
    },
    grid: { left: 60, right: 30, top: 20, bottom: 30 },
    xAxis: {
      type: 'category',
      data: bins.map((b) => fmtNum(b.edge_lo, 2)),
      axisLabel: { color: '#9ca3af', fontSize: 9 },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#9ca3af' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    series: [
      {
        name: '频次',
        type: 'bar',
        data: bins.map((b) => b.probability),
        itemStyle: { color: '#1677ff', borderRadius: [2, 2, 0, 0] },
      },
    ],
  }
}

/**
 * PSI top-10 特征条形图 —— 横向 bar，主题色橙黄（对齐 Report 中的强调色 #fa8c16）
 */
function buildTopPsiFeaturesOption(psiByFeature: PsiByFeature | null) {
  if (!psiByFeature) return null
  const entries = Object.entries(psiByFeature)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  if (entries.length === 0) return null
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#e8e8e8',
      textStyle: { color: '#374151' },
    },
    grid: { left: 130, right: 30, top: 20, bottom: 30 },
    xAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: '#9ca3af' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    yAxis: {
      type: 'category',
      data: entries.map(([k]) => k).reverse(),
      axisLabel: { color: '#9ca3af', fontSize: 10 },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
    },
    series: [
      {
        type: 'bar',
        data: entries.map(([, v]) => v).reverse(),
        itemStyle: { color: '#fa8c16', borderRadius: [0, 2, 2, 0] },
      },
    ],
  }
}

const MlMonitorPanel: React.FC<Props> = ({ nodeId, engine, strategyName, gatewayName, eventsConnected }) => {
  // 180 日窗口覆盖实盘积累和 backfill 测试数据. ICIR window 维持 30 日
  // (与原 Phase 3 设计一致). Refetch 60s 匹配 ml_snapshot_loop 节奏.
  const history = useQuery({
    queryKey: liveTradingQueryKeys.mlMetricsHistory(nodeId, strategyName),
    queryFn: () => mlMonitoringService.metricsHistory(nodeId, strategyName, 180),
    refetchInterval: liveFallbackInterval(eventsConnected, ML_MONITOR_FALLBACK_REFRESH_MS),
    staleTime: ML_MONITOR_STALE_MS,
  })

  const rolling = useQuery({
    queryKey: liveTradingQueryKeys.mlMetricsRolling(nodeId, strategyName),
    queryFn: () => mlMonitoringService.metricsRolling(nodeId, strategyName, 30),
    refetchInterval: liveFallbackInterval(eventsConnected, ML_MONITOR_FALLBACK_REFRESH_MS),
    staleTime: ML_MONITOR_STALE_MS,
  })

  const latestPrediction = useQuery({
    queryKey: liveTradingQueryKeys.mlPredictionLatest(nodeId, strategyName),
    queryFn: () => mlMonitoringService.predictionLatestSummary(nodeId, strategyName),
    refetchInterval: liveFallbackInterval(eventsConnected, ML_MONITOR_FALLBACK_REFRESH_MS),
    staleTime: ML_MONITOR_STALE_MS,
    retry: 1,
  })

  const historyData: MetricSnapshot[] = history.data?.success ? history.data.data || [] : []
  const rollingData: RollingSummary | null = rolling.data?.success ? rolling.data.data : null
  const predictionData = latestPrediction.data?.success ? latestPrediction.data.data : null

  // KPI 用"最近一个 IC 非空"的 trade_date — IC 需要 forward 11d label 才能算,
  // 最新几天 (4 月底到当日) IC 仍是 None 等待回填。直接拿 historyData 最后一行
  // 会让"最新 IC" 显示空白。fallback 到含值的那行更直观。
  const latestMetric: MetricSnapshot | null = (() => {
    if (!historyData.length) return null
    for (let i = historyData.length - 1; i >= 0; i--) {
      if (historyData[i].ic !== null && historyData[i].ic !== undefined) {
        return historyData[i]
      }
    }
    return historyData[historyData.length - 1]
  })()

  const icOption = useMemo(
    () => buildTimeseriesOption(historyData, 'ic'),
    [historyData],
  )
  const rankIcOption = useMemo(
    () => buildTimeseriesOption(historyData, 'rank_ic'),
    [historyData],
  )
  const psiOption = useMemo(
    () => buildTimeseriesOption(historyData, 'psi_mean', 0.25),
    [historyData],
  )
  const histOption = useMemo(() => {
    if (!predictionData?.score_histogram?.length) return null
    return buildHistogramOption(predictionData.score_histogram)
  }, [predictionData])
  const topPsiOption = useMemo(
    () => buildTopPsiFeaturesOption(latestMetric?.psi_by_feature || null),
    [latestMetric],
  )

  if (history.isLoading || rolling.isLoading) {
    return (
      <Card>
        <Spin tip="加载 ML 监控数据..." />
      </Card>
    )
  }

  if (historyData.length === 0) {
    return (
      <Card>
        <Empty description="暂无 ML 监控数据 (ml_snapshot_loop 未拉取到, 或策略未跑过推理)" />
      </Card>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* KPI 行 */}
      <Card size="small">
        <Row gutter={16}>
          <Col xs={12} sm={6} lg={4}>
            <Statistic title="最新 IC" value={fmtNum(latestMetric?.ic)} />
          </Col>
          <Col xs={12} sm={6} lg={4}>
            <Statistic title="Rank IC" value={fmtNum(latestMetric?.rank_ic)} />
          </Col>
          <Col xs={12} sm={6} lg={4}>
            <Statistic title="PSI mean" value={fmtNum(latestMetric?.psi_mean, 3)} />
          </Col>
          <Col xs={12} sm={6} lg={4}>
            <Statistic title="预测样本数" value={latestMetric?.n_predictions ?? 0} />
          </Col>
          <Col xs={12} sm={6} lg={4}>
            <Statistic
              title="30 日 ICIR"
              value={fmtNum(rollingData?.icir_30d?.icir, 3)}
            />
          </Col>
          <Col xs={12} sm={6} lg={4}>
            <Statistic
              title="模型版本"
              value={latestMetric?.model_run_id?.slice(0, 8) || '—'}
            />
          </Col>
        </Row>
        <div style={{ marginTop: 8 }}>
          <Text type="secondary">
            最新 trade_date: {latestMetric?.trade_date || '—'} · status:{' '}
            {latestMetric?.status || '—'}
          </Text>
        </div>
      </Card>

      {/* PSI 告警 */}
      {rollingData?.psi_alert?.triggered && (
        <Alert
          type="warning"
          showIcon
          message={`PSI 告警: 连续 ${rollingData.psi_alert.max_streak_days} 日 PSI_mean > ${rollingData.psi_alert.threshold}`}
          description={`首次触发日期: ${rollingData.psi_alert.first_alert_date || '—'}. 建议评估特征漂移, 考虑重训.`}
        />
      )}

      {/* IC 衰减告警 */}
      {rollingData?.ic_decay?.triggered && (
        <Alert
          type="error"
          showIcon
          message={`IC 衰减告警: ${rollingData.ic_decay.reason}`}
          description={
            `近期 ${rollingData.ic_decay.n_recent} 日 vs 前期 ${rollingData.ic_decay.n_prior} 日. ` +
            `衰减比例 ${rollingData.ic_decay.decay_ratio !== null ? (rollingData.ic_decay.decay_ratio * 100).toFixed(1) + '%' : '—'}. ` +
            `建议评估模型可用性, 必要时重训.`
          }
        />
      )}

      {/* 时序图 */}
      <Row gutter={12}>
        <Col xs={24} lg={8}>
          <Card size="small" title="IC 时序">
            <ChartContainer library="echarts" option={icOption} height={260} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="Rank IC 时序">
            <ChartContainer library="echarts" option={rankIcOption} height={260} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="PSI_mean 时序">
            <ChartContainer library="echarts" option={psiOption} height={260} />
          </Card>
        </Col>
      </Row>

      {/* 直方图 + top PSI */}
      <Row gutter={12}>
        <Col xs={24} lg={12}>
          <Card size="small" title="预测分数直方图（最新）">
            {histOption ? (
              <ChartContainer library="echarts" option={histOption} height={280} />
            ) : (
              <Empty description="暂无最新直方图数据" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="PSI top-10 特征">
            {topPsiOption ? (
              <ChartContainer library="echarts" option={topPsiOption} height={280} />
            ) : (
              <Empty description="暂无 PSI 特征详情" />
            )}
          </Card>
        </Col>
      </Row>

      <PredictionHistoryPanel
        nodeId={nodeId}
        strategyName={strategyName}
        historyDates={historyData.map((m) => m.trade_date || '').filter(Boolean)}
      />

      <HistoricalPositionsCard
        nodeId={nodeId}
        engine={engine}
        strategyName={strategyName}
        gatewayName={gatewayName}
        historyDates={historyData.map((m) => m.trade_date || '').filter(Boolean)}
      />

      <BacktestDiffPanel nodeId={nodeId} strategyName={strategyName} />
    </div>
  )
}

export default MlMonitorPanel
