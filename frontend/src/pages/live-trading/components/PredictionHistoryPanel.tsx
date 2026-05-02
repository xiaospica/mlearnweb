/**
 * 历史预测回溯 — 日期选择 + 双 Tab (TopK / 全部预测).
 * 挂在 MlMonitorPanel 的最底部.
 *
 * Tab 设计:
 *   - TopK: 当日 topk 表 + summary (n_symbols / pred_mean / pred_std / model_run_id)
 *   - 全部预测: 该日股票池全量预测, 支持点击 pred 表头排序, 带股票名
 *
 * 其他行为:
 *   - 两个 Tab 各自独立 query, 切 Tab 时按需加载 ("全部预测" 懒加载)
 *   - stale-while-error: RPC / 业务失败时保留上次成功数据, 顶部黄色 Alert 提示,
 *     不清空表格. 切换日期时 lastGood 重置.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  Alert,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Spin,
  Statistic,
  Table,
  Tabs,
  Typography,
} from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import type { ColumnsType } from 'antd/es/table'
import { mlMonitoringService } from '@/services/mlMonitoringService'
import type {
  AllPredictionEntry,
  PredictionSummary,
  TopkEntry,
} from '@/services/mlMonitoringService'

const { Text } = Typography

interface Props {
  nodeId: string
  strategyName: string
  historyDates: string[]  // trade_dates 在时序里可用的(升序),用于 DatePicker 可选范围
}

const topkColumns: ColumnsType<TopkEntry> = [
  {
    title: '合约',
    key: 'instrument',
    width: 200,
    render: (_: unknown, r: TopkEntry) => (
      <span>
        {r.name && <span style={{ marginRight: 6, color: 'var(--ap-text)' }}>{r.name}</span>}
        <span style={{ color: 'var(--ap-text-muted)', fontSize: 12 }}>{r.instrument}</span>
      </span>
    ),
  },
  { title: '排名', dataIndex: 'rank', key: 'rank', width: 64, align: 'center', render: (v: number | null) => (v == null ? '—' : `#${v}`) },
  {
    title: '预测分数',
    dataIndex: 'score',
    key: 'score',
    width: 120,
    align: 'right',
    render: (v: number | null | undefined) =>
      v === null || v === undefined ? '—' : v.toFixed(4),
  },
  {
    title: '权重',
    dataIndex: 'weight',
    key: 'weight',
    width: 100,
    align: 'right',
    render: (v: number | null | undefined) =>
      v === null || v === undefined ? '—' : `${(v * 100).toFixed(2)}%`,
  },
]

const allColumns: ColumnsType<AllPredictionEntry> = [
  {
    title: '合约',
    key: 'instrument',
    width: 200,
    render: (_: unknown, r: AllPredictionEntry) => (
      <span>
        {r.name && <span style={{ marginRight: 6, color: 'var(--ap-text)' }}>{r.name}</span>}
        <span style={{ color: 'var(--ap-text-muted)', fontSize: 12 }}>{r.instrument}</span>
      </span>
    ),
  },
  {
    title: '排名',
    dataIndex: 'rank',
    key: 'rank',
    width: 64,
    align: 'center',
    sorter: (a, b) => a.rank - b.rank,
    render: (v: number | null) => (v == null ? '—' : `#${v}`),
  },
  {
    title: '预测分数',
    dataIndex: 'score',
    key: 'score',
    width: 140,
    align: 'right',
    defaultSortOrder: 'descend',
    sorter: (a, b) => (a.score ?? -Infinity) - (b.score ?? -Infinity),
    render: (v: number | null) => (v === null ? '—' : v.toFixed(4)),
  },
]

function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

const PredictionHistoryPanel: React.FC<Props> = ({ nodeId, strategyName, historyDates }) => {
  // Default to most recent date in history
  const latestDate = historyDates.length > 0 ? historyDates[historyDates.length - 1] : null
  const [selected, setSelected] = useState<Dayjs | null>(latestDate ? dayjs(latestDate) : null)
  const [activeTab, setActiveTab] = useState<'topk' | 'all'>('topk')

  const yyyymmdd = selected ? selected.format('YYYYMMDD') : null

  // --- TopK summary query (现有 endpoint, SQLite) ---
  const topkQuery = useQuery({
    queryKey: ['ml-prediction-by-date', nodeId, strategyName, yyyymmdd],
    queryFn: () =>
      mlMonitoringService.predictionByDate(nodeId, strategyName, yyyymmdd as string),
    enabled: !!yyyymmdd,
    staleTime: 60000,
    retry: 1,
    placeholderData: keepPreviousData,
  })

  // --- 全部预测 query (新 endpoint, 懒加载: Tab 激活才拉) ---
  const allQuery = useQuery({
    queryKey: ['ml-prediction-all', nodeId, strategyName, yyyymmdd],
    queryFn: () =>
      mlMonitoringService.predictionAllByDate(nodeId, strategyName, yyyymmdd as string),
    enabled: !!yyyymmdd && activeTab === 'all',
    staleTime: 60000,
    retry: 1,
    placeholderData: keepPreviousData,
  })

  // 切换日期时清空 stale 缓存, 避免跨日期串数据
  const lastGoodSummary = useRef<PredictionSummary | null>(null)
  const lastGoodAll = useRef<AllPredictionEntry[] | null>(null)
  useEffect(() => {
    lastGoodSummary.current = null
    lastGoodAll.current = null
  }, [yyyymmdd])
  useEffect(() => {
    if (topkQuery.data?.success && topkQuery.data.data) {
      lastGoodSummary.current = topkQuery.data.data
    }
  }, [topkQuery.data])
  useEffect(() => {
    if (allQuery.data?.success && allQuery.data.data) {
      lastGoodAll.current = allQuery.data.data
    }
  }, [allQuery.data])

  const availableDatesSet = useMemo(() => new Set(historyDates), [historyDates])

  // ---- TopK tab 内容 ----
  const topkCurrent = topkQuery.data?.success ? topkQuery.data.data : null
  const topkStale = topkCurrent ?? lastGoodSummary.current
  const topkBusinessWarning =
    topkQuery.data && !topkQuery.data.success
      ? (topkQuery.data.warning || topkQuery.data.message)
      : null
  const topkShowStale =
    (topkQuery.isError || !!topkBusinessWarning) && !!lastGoodSummary.current && !topkCurrent

  const renderTopkTab = () => {
    if (!yyyymmdd) return <Empty description="请选择一个历史日期" />
    if (topkQuery.isLoading && !topkStale) {
      return (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      )
    }
    if (!topkStale) {
      return (
        <Empty
          description={
            topkBusinessWarning || '当日无预测记录'
          }
        />
      )
    }
    return (
      <div>
        {topkShowStale && (
          <Alert
            type="warning"
            showIcon
            closable
            style={{ marginBottom: 12 }}
            message={
              topkQuery.isError
                ? `节点暂时异常, 显示上次缓存 (${topkStale.trade_date || yyyymmdd}). ${topkQuery.error instanceof Error ? topkQuery.error.message : ''}`
                : `${topkBusinessWarning} — 显示上次缓存`
            }
          />
        )}
        <Row gutter={16} style={{ marginBottom: 12 }}>
          <Col xs={12} sm={6}>
            <Statistic title="样本数" value={topkStale.n_symbols ?? 0} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="pred_mean" value={fmtNum(topkStale.pred_mean)} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="pred_std" value={fmtNum(topkStale.pred_std)} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic
              title="模型版本"
              value={topkStale.model_run_id?.slice(0, 8) || '—'}
            />
          </Col>
        </Row>
        <Text type="secondary" style={{ fontSize: 12 }}>
          trade_date: {topkStale.trade_date || yyyymmdd} · status: {topkStale.status || '—'}
        </Text>
        <div style={{ marginTop: 12 }}>
          {topkStale.topk && topkStale.topk.length > 0 ? (
            <Table<TopkEntry>
              size="small"
              rowKey={(r) => `${r.rank}-${r.instrument}`}
              dataSource={topkStale.topk as TopkEntry[]}
              columns={topkColumns}
              pagination={false}
            />
          ) : (
            <Empty description="当日无 TopK 数据" />
          )}
        </div>
      </div>
    )
  }

  // ---- 全部预测 tab 内容 ----
  const allCurrent =
    allQuery.data && allQuery.data.success ? (allQuery.data.data ?? []) : null
  const allStale = allCurrent ?? lastGoodAll.current
  const allBusinessWarning =
    allQuery.data && !allQuery.data.success
      ? (allQuery.data.warning || allQuery.data.message)
      : null
  const allShowStale =
    (allQuery.isError || !!allBusinessWarning) && !!lastGoodAll.current && !allCurrent

  const renderAllTab = () => {
    if (!yyyymmdd) return <Empty description="请选择一个历史日期" />
    if (allQuery.isLoading && !allStale) {
      return (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      )
    }
    if (!allStale || allStale.length === 0) {
      return (
        <Empty
          description={
            allBusinessWarning || '当日无全量预测 (predictions.parquet 未生成)'
          }
        />
      )
    }
    return (
      <div>
        {allShowStale && (
          <Alert
            type="warning"
            showIcon
            closable
            style={{ marginBottom: 12 }}
            message={
              allQuery.isError
                ? `节点暂时异常, 显示上次缓存. ${allQuery.error instanceof Error ? allQuery.error.message : ''}`
                : `${allBusinessWarning} — 显示上次缓存`
            }
          />
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          trade_date: {yyyymmdd} · 共 {allStale.length} 条 (点击"预测分数"列可切换排序)
        </Text>
        <div style={{ marginTop: 12 }}>
          <Table<AllPredictionEntry>
            size="small"
            rowKey={(r) => `${r.rank}-${r.instrument}`}
            dataSource={allStale}
            columns={allColumns}
            pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: ['20', '50', '100', '300'] }}
            scroll={{ y: 400 }}
          />
        </div>
      </div>
    )
  }

  return (
    <Card
      title={<span>历史预测回溯</span>}
      style={{ marginTop: 12 }}
      extra={
        <DatePicker
          value={selected}
          onChange={(d) => setSelected(d)}
          format="YYYY-MM-DD"
          disabledDate={(d) =>
            !availableDatesSet.has(d.format('YYYY-MM-DD'))
          }
          placeholder="选择历史日期"
          allowClear={false}
        />
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'topk' | 'all')}
        items={[
          { key: 'topk', label: 'TopK', children: renderTopkTab() },
          { key: 'all', label: '全部预测', children: renderAllTab() },
        ]}
      />
    </Card>
  )
}

export default PredictionHistoryPanel
