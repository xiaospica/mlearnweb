/**
 * 回测-实盘差异 (解读 A) — 对齐训练侧 MLflow pred.pkl 与 live predictions.
 *
 * 用户需在面板里填训练 run artifacts 路径 (mlflow_run_dir), 默认尝试
 * 从策略 parameters.bundle_dir 推导上一层 MLflow run dir.
 */
import React, { useState } from 'react'
import { Alert, Button, Card, Col, Empty, Input, Row, Spin, Statistic, Typography } from 'antd'
import ReactECharts from 'echarts-for-react'
import { useMutation } from '@tanstack/react-query'
import { mlMonitoringService } from '@/services/mlMonitoringService'
import type { BacktestDiff } from '@/services/mlMonitoringService'

const { Text } = Typography

interface Props {
  nodeId: string
  strategyName: string
  defaultMlflowRunDir?: string
}

function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

const BacktestDiffPanel: React.FC<Props> = ({ nodeId, strategyName, defaultMlflowRunDir }) => {
  const [mlflowRunDir, setMlflowRunDir] = useState(defaultMlflowRunDir || '')
  const [liveRoot, setLiveRoot] = useState('')
  const [result, setResult] = useState<BacktestDiff | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      const resp = await mlMonitoringService.backtestDiff(
        nodeId,
        strategyName,
        mlflowRunDir,
        liveRoot || undefined,
        30,
      )
      if (!resp.success) {
        setWarning(resp.warning || resp.message || '请求失败')
        setResult(null)
      } else {
        setWarning(null)
        setResult(resp.data as BacktestDiff)
      }
      return resp
    },
  })

  const perDate = result?.per_date || []

  const option = perDate.length > 0 ? {
    title: { text: 'Per-date Live vs Backtest Correlation', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: perDate.map((d) => d.trade_date),
      axisLabel: { rotate: 45, fontSize: 10 },
    },
    yAxis: [
      { type: 'value', name: 'corr', min: -1, max: 1, scale: true },
      { type: 'value', name: 'mean_abs_diff', scale: true, splitLine: { show: false } },
    ],
    grid: { left: 55, right: 55, top: 40, bottom: 70 },
    legend: { bottom: 0, data: ['corr', 'mean_abs_diff'] },
    series: [
      {
        name: 'corr',
        type: 'line',
        data: perDate.map((d) => d.corr),
        smooth: true,
        showSymbol: perDate.length <= 60,
        lineStyle: { width: 2 },
        yAxisIndex: 0,
      },
      {
        name: 'mean_abs_diff',
        type: 'line',
        data: perDate.map((d) => d.mean_abs_diff),
        smooth: true,
        showSymbol: perDate.length <= 60,
        lineStyle: { width: 1, color: '#FAAD14' },
        yAxisIndex: 1,
      },
    ],
  } : null

  return (
    <Card title="回测 vs 实盘 一致性" style={{ marginTop: 12 }}>
      <Row gutter={8} style={{ marginBottom: 12 }}>
        <Col flex="auto">
          <Input
            placeholder="MLflow run artifacts dir (含 pred.pkl), 如 F:\Quant\code\qlib_strategy_dev\mlruns\374089520733232109\ab2711178313491f9900b5695b47fa98\artifacts"
            value={mlflowRunDir}
            onChange={(e) => setMlflowRunDir(e.target.value)}
          />
        </Col>
        <Col flex="auto">
          <Input
            placeholder="live 推理 output_root (留空用后端 settings.ml_live_output_root)"
            value={liveRoot}
            onChange={(e) => setLiveRoot(e.target.value)}
          />
        </Col>
        <Col>
          <Button
            type="primary"
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
            disabled={!mlflowRunDir}
          >
            运行对比
          </Button>
        </Col>
      </Row>

      {warning && <Alert type="warning" showIcon message={warning} style={{ marginBottom: 12 }} />}

      {mutation.isPending ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : !result ? (
        <Empty description="填写路径并点击 '运行对比' 查看每日一致性" />
      ) : !result.available ? (
        <Alert type="info" showIcon message={result.reason || '无可用数据'} />
      ) : (
        <div>
          <Row gutter={16} style={{ marginBottom: 12 }}>
            <Col xs={12} sm={6}>
              <Statistic title="对比日期数" value={result.n_dates_in_overlap ?? 0} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic title="平均相关性" value={fmtNum(result.corr_mean, 4)} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="日期覆盖率"
                value={result.coverage_ratio !== undefined
                  ? `${(result.coverage_ratio * 100).toFixed(1)}%`
                  : '—'}
              />
            </Col>
            <Col xs={24} sm={6}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                backtest: {result.backtest_source?.split(/[\\/]/).slice(-3).join('/') || '—'}
              </Text>
            </Col>
          </Row>
          {option && <ReactECharts option={option} style={{ height: 300 }} />}
        </div>
      )}
    </Card>
  )
}

export default BacktestDiffPanel
