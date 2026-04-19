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
import ReactECharts from 'echarts-for-react'
import { Alert, Card, Col, Empty, Row, Spin, Statistic, Typography } from 'antd'
import { mlMonitoringService } from '@/services/mlMonitoringService'
import type {
  HistogramBin,
  MetricSnapshot,
  PsiByFeature,
  RollingSummary,
} from '@/services/mlMonitoringService'

const { Text } = Typography

interface Props {
  nodeId: string
  strategyName: string
}

function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

function buildTimeseriesOption(
  history: MetricSnapshot[],
  field: 'ic' | 'rank_ic' | 'psi_mean',
  title: string,
  threshold?: number,
) {
  const dates = history.map((h) => h.trade_date)
  const values = history.map((h) => h[field] ?? null)
  const series: Array<Record<string, unknown>> = [
    {
      name: title,
      type: 'line',
      data: values,
      smooth: true,
      showSymbol: values.length <= 60,
      lineStyle: { width: 2 },
    },
  ]
  if (threshold !== undefined) {
    series.push({
      name: `阈值 ${threshold}`,
      type: 'line',
      data: dates.map(() => threshold),
      lineStyle: { width: 1, type: 'dashed', color: '#ff4d4f' },
      showSymbol: false,
    })
  }
  return {
    title: { text: title, left: 'center', textStyle: { fontSize: 13 } },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
    yAxis: { type: 'value', scale: true },
    grid: { left: 50, right: 20, top: 40, bottom: 60 },
    series,
  }
}

function buildHistogramOption(bins: HistogramBin[], title: string) {
  return {
    title: { text: title, left: 'center', textStyle: { fontSize: 13 } },
    tooltip: {
      trigger: 'axis',
      formatter: (arr: Array<{ dataIndex: number; value: number }>) => {
        const idx = arr[0].dataIndex
        const b = bins[idx]
        return `bin ${b.bin_id}<br/>[${fmtNum(b.edge_lo, 3)}, ${fmtNum(b.edge_hi, 3)})<br/>count: ${b.count}<br/>prob: ${fmtNum(b.probability, 4)}`
      },
    },
    xAxis: {
      type: 'category',
      data: bins.map((b) => fmtNum(b.edge_lo, 2)),
      axisLabel: { fontSize: 10 },
    },
    yAxis: { type: 'value', name: 'probability' },
    grid: { left: 50, right: 20, top: 40, bottom: 50 },
    series: [
      {
        type: 'bar',
        data: bins.map((b) => b.probability),
        itemStyle: { color: '#5B8FF9' },
      },
    ],
  }
}

function buildTopPsiFeaturesOption(psiByFeature: PsiByFeature | null) {
  if (!psiByFeature) return null
  const entries = Object.entries(psiByFeature)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  if (entries.length === 0) return null
  return {
    title: { text: '当前 PSI top-10 特征', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'value', scale: true },
    yAxis: { type: 'category', data: entries.map(([k]) => k).reverse(), axisLabel: { fontSize: 10 } },
    grid: { left: 120, right: 30, top: 40, bottom: 30 },
    series: [
      {
        type: 'bar',
        data: entries.map(([, v]) => v).reverse(),
        itemStyle: { color: '#F6BD16' },
      },
    ],
  }
}

const MlMonitorPanel: React.FC<Props> = ({ nodeId, strategyName }) => {
  // Refetch interval: 60s to match ml_snapshot_loop cadence (no point polling faster)
  const history = useQuery({
    queryKey: ['ml-metrics-history', nodeId, strategyName],
    queryFn: () => mlMonitoringService.metricsHistory(nodeId, strategyName, 30),
    refetchInterval: 60000,
    staleTime: 30000,
  })

  const rolling = useQuery({
    queryKey: ['ml-metrics-rolling', nodeId, strategyName],
    queryFn: () => mlMonitoringService.metricsRolling(nodeId, strategyName, 30),
    refetchInterval: 60000,
    staleTime: 30000,
  })

  const latestPrediction = useQuery({
    queryKey: ['ml-prediction-latest', nodeId, strategyName],
    queryFn: () => mlMonitoringService.predictionLatestSummary(nodeId, strategyName),
    refetchInterval: 60000,
    staleTime: 30000,
    retry: 1,
  })

  const historyData: MetricSnapshot[] = history.data?.success ? history.data.data || [] : []
  const rollingData: RollingSummary | null = rolling.data?.success ? rolling.data.data : null
  const predictionData = latestPrediction.data?.success ? latestPrediction.data.data : null

  const latestMetric: MetricSnapshot | null =
    historyData.length > 0 ? historyData[historyData.length - 1] : null

  const icOption = useMemo(
    () => buildTimeseriesOption(historyData, 'ic', 'IC 时序'),
    [historyData],
  )
  const rankIcOption = useMemo(
    () => buildTimeseriesOption(historyData, 'rank_ic', 'Rank IC 时序'),
    [historyData],
  )
  const psiOption = useMemo(
    () => buildTimeseriesOption(historyData, 'psi_mean', 'PSI_mean 时序', 0.25),
    [historyData],
  )
  const histOption = useMemo(() => {
    if (!predictionData?.score_histogram?.length) return null
    return buildHistogramOption(predictionData.score_histogram, '预测分数直方图 (最新)')
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

      {/* 时序图 */}
      <Row gutter={12}>
        <Col xs={24} lg={8}>
          <Card size="small">
            <ReactECharts option={icOption} style={{ height: 260 }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small">
            <ReactECharts option={rankIcOption} style={{ height: 260 }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small">
            <ReactECharts option={psiOption} style={{ height: 260 }} />
          </Card>
        </Col>
      </Row>

      {/* 直方图 + top PSI */}
      <Row gutter={12}>
        <Col xs={24} lg={12}>
          <Card size="small">
            {histOption ? (
              <ReactECharts option={histOption} style={{ height: 280 }} />
            ) : (
              <Empty description="暂无最新直方图数据" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small">
            {topPsiOption ? (
              <ReactECharts option={topPsiOption} style={{ height: 280 }} />
            ) : (
              <Empty description="暂无 PSI 特征详情" />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default MlMonitorPanel
