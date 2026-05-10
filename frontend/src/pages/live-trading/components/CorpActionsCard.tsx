/**
 * 企业行为（除权除息）告警卡片 — 检测当前持仓股票最近 N 日的除权事件。
 *
 * 数据流：取当前策略持仓的 vt_symbols 列表 → 调 /api/live-trading/corp-actions
 * → 后端读 daily_merged_*.parquet 比较 pct_chg 与原始 close 涨跌幅，差距大于
 * 阈值即视为除权日。
 *
 * 用途：除权日 pre_close ≠ 上一交易日 close，前端持仓单价可能"跳变"，但本系统
 * 撮合柜台用 pct_chg 累乘 mark price 已经把价格连续性保住。本卡片是信息增强，
 * 让用户知道哪些天发生了除权（避免对单价跳变疑惑）。
 */
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Empty, Spin, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import liveTradingService from '@/services/liveTradingService'
import type { CorpActionEvent } from '@/types/liveTrading'
import {
  CORP_ACTIONS_REFRESH_MS,
  CORP_ACTIONS_STALE_MS,
  liveTradingQueryKeys,
} from '../liveTradingRefresh'

const { Text } = Typography

interface Props {
  vtSymbols: string[]
  /** 向前回溯天数。默认 30。 */
  days?: number
}

const columns: ColumnsType<CorpActionEvent> = [
  {
    title: '日期',
    dataIndex: 'trade_date',
    key: 'trade_date',
    width: 110,
  },
  {
    title: '代码',
    dataIndex: 'vt_symbol',
    key: 'vt_symbol',
    width: 130,
  },
  {
    title: '名称',
    dataIndex: 'name',
    key: 'name',
    width: 110,
    render: (v: string) => v || '—',
  },
  {
    title: '复权涨跌幅',
    dataIndex: 'pct_chg',
    key: 'pct_chg',
    width: 110,
    align: 'right',
    render: (v: number) => (
      <Text style={{ color: v >= 0 ? '#cf1322' : '#3f8600' }}>
        {v >= 0 ? '+' : ''}{v.toFixed(2)}%
      </Text>
    ),
  },
  {
    title: '原始涨跌幅',
    dataIndex: 'raw_change_pct',
    key: 'raw_change_pct',
    width: 110,
    align: 'right',
    render: (v: number) => (
      <Tooltip title="基于昨日 close 与今日 close 的原始涨跌幅，未除权调整">
        <Text type="secondary">{v >= 0 ? '+' : ''}{v.toFixed(2)}%</Text>
      </Tooltip>
    ),
  },
  {
    title: '差异',
    dataIndex: 'magnitude_pct',
    key: 'magnitude_pct',
    width: 90,
    align: 'right',
    render: (v: number) => {
      const color = v > 5 ? 'red' : v > 1 ? 'orange' : 'default'
      return <Tag color={color}>{v.toFixed(2)}%</Tag>
    },
  },
  {
    title: '除权前',
    dataIndex: 'pre_close',
    key: 'pre_close',
    width: 90,
    align: 'right',
    render: (_v: number, r: CorpActionEvent) => (
      <Tooltip title={`今日 pre_close=${r.pre_close} 即除权后参考价；昨日 close 实际更高/更低，差额对应分红/送股`}>
        <Text>{r.pre_close.toFixed(2)}</Text>
      </Tooltip>
    ),
  },
  {
    title: '今日收盘',
    dataIndex: 'close',
    key: 'close',
    width: 90,
    align: 'right',
    render: (v: number) => v.toFixed(2),
  },
]

const CorpActionsCard: React.FC<Props> = ({ vtSymbols, days = 30 }) => {
  const sortedKey = [...vtSymbols].sort().join(',')
  const { data, isLoading } = useQuery({
    queryKey: liveTradingQueryKeys.corpActions(sortedKey, days),
    queryFn: () => liveTradingService.listCorpActions(vtSymbols, days),
    refetchInterval: CORP_ACTIONS_REFRESH_MS,
    staleTime: CORP_ACTIONS_STALE_MS,
    retry: 1,
    enabled: vtSymbols.length > 0,
  })

  const events = (data?.success ? data.data : []) || []

  if (vtSymbols.length === 0) {
    return null
  }

  return (
    <Card
      title={
        <div>
          企业行为告警
          <Text type="secondary" style={{ marginLeft: 12, fontSize: 12, fontWeight: 'normal' }}>
            最近 {days} 日持仓股票的除权除息事件
          </Text>
        </div>
      }
      style={{ marginTop: 16 }}
      styles={{ body: { padding: 0 } }}
    >
      {data && !data.success && data.warning ? (
        <Empty description={data.warning} style={{ padding: 24 }} />
      ) : isLoading && events.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin size="small" />
        </div>
      ) : events.length === 0 ? (
        <Empty
          description={`最近 ${days} 日内无除权事件`}
          style={{ padding: 24 }}
        />
      ) : (
        <Table<CorpActionEvent>
          size="small"
          rowKey={(r) => `${r.trade_date}-${r.vt_symbol}`}
          dataSource={events}
          columns={columns}
          pagination={false}
        />
      )}
    </Card>
  )
}

export default CorpActionsCard
