import React from 'react'
import { Card, Tooltip, Typography } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
import type { SourceLabel, StrategyMode, StrategySummary } from '@/types/liveTrading'
import MiniEquityChart from './MiniEquityChart'
import StrategyActions from './StrategyActions'
import CronScheduleStrip from './CronScheduleStrip'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

const { Text } = Typography

const SOURCE_LABEL_TEXT: Record<SourceLabel, string> = {
  strategy_pnl: '策略PnL',
  position_sum_pnl: '持仓浮盈',
  account_equity: '账户权益',
  unavailable: '无数据',
}

const SOURCE_LABEL_HELP: Record<SourceLabel, string> = {
  strategy_pnl: '从策略 variables 中的 PnL 字段直接读取',
  position_sum_pnl: '按 vt_symbol 聚合匹配持仓的浮动盈亏',
  account_equity: '账户总权益，多策略共享时为近似值',
  unavailable: '当前没有可用数据',
}

function fmtValue(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-'
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function valueColor(v: number | null | undefined, label: SourceLabel | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'var(--ap-text-muted)'
  if (label === 'account_equity') return 'var(--ap-info)'
  if (v > 0) return 'var(--ap-market-up)'
  if (v < 0) return 'var(--ap-market-down)'
  return 'var(--ap-text)'
}

/** mode 视觉编码三层叠加：颜色 + tinted bg + 大写徽章。 */
function modeStyle(mode: StrategyMode | null, offline: boolean) {
  if (offline) {
    return {
      color: 'var(--ap-text-dim)',
      label: 'OFF',
      tint: 'transparent',
      title: '节点离线 / 策略已停运',
    }
  }
  if (mode === 'live') {
    return {
      color: 'var(--ap-danger)',
      label: 'LIVE',
      tint: 'color-mix(in srgb, var(--ap-danger) 4%, var(--ap-panel))',
      title: '实盘',
    }
  }
  return {
    color: 'var(--ap-success)',
    label: 'SIM',
    tint: 'color-mix(in srgb, var(--ap-success) 4%, var(--ap-panel))',
    title: '模拟',
  }
}

/** state pill 用形状编码（不再单纯靠颜色），避免与 mode 红绿冲突。 */
function stateShape(item: StrategySummary, offline: boolean): { shape: string; text: string; color: string } {
  if (offline) return { shape: '⚠', text: '节点离线', color: 'var(--ap-text-dim)' }
  if (item.running) return { shape: '●', text: '运行中', color: 'var(--ap-info)' }
  if (item.inited) return { shape: '◐', text: '已初始化', color: 'var(--ap-warning)' }
  return { shape: '○', text: '未初始化', color: 'var(--ap-text-muted)' }
}

export interface StrategyCardV2Props {
  item: StrategySummary
  detailHref: string
  /** 上游策略：有几个下游影子（buildDownstreamCountMap 算出来传进来）。 */
  downstreamCount?: number
  /** 点击同节点上游策略名时，由父组件触发滚动 + 高亮。 */
  onJumpToParent?: (parentName: string) => void
}

const StrategyCardV2: React.FC<StrategyCardV2Props> = ({
  item,
  detailHref,
  downstreamCount = 0,
  onJumpToParent,
}) => {
  const offline = Boolean(item.node_offline)
  const ms = modeStyle(item.mode, offline)
  const ss = stateShape(item, offline)
  const sourceLabel = (item.source_label || 'unavailable') as SourceLabel

  // leading 6px 色条饱和度由 state 调
  const leadOpacity = offline ? 0.4 : item.running ? 1 : item.inited ? 0.6 : 0.3

  return (
    <Card
      hoverable
      style={{
        position: 'relative',
        cursor: 'pointer',
        background: ms.tint,
        overflow: 'hidden',
        // leading 6px 色条用 box-shadow inset 实现，不占内边距
        boxShadow: `inset 6px 0 0 0 color-mix(in srgb, ${ms.color} ${Math.round(leadOpacity * 100)}%, transparent)`,
      }}
      styles={{ body: { padding: '14px 16px 14px 18px' } }}
      data-strategy-name={item.strategy_name}
    >
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minHeight: 24 }}>
        <Tooltip title={item.gateway_name ? `${ms.title} · gateway: ${item.gateway_name}` : ms.title}>
          <span
            style={{
              display: 'inline-block',
              padding: '1px 6px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.4,
              color: '#fff',
              background: ms.color,
              borderRadius: 3,
              flexShrink: 0,
              fontFamily: 'var(--ap-font-mono)',
            }}
          >
            {ms.label}
          </span>
        </Tooltip>

        <Link
          to={detailHref}
          onClick={(e) => e.stopPropagation()}
          style={{
            color: 'var(--ap-text)',
            fontSize: 15,
            fontWeight: 600,
            textDecoration: 'none',
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={item.strategy_name}
        >
          {item.strategy_name}
        </Link>

        {/* downstream badge：上游策略，有 N 个下游影子 */}
        {downstreamCount > 0 && (
          <Tooltip title={`${downstreamCount} 个影子策略复用本策略的 selections`}>
            <span
              style={{
                fontSize: 10,
                color: 'var(--ap-text-muted)',
                cursor: 'help',
                fontFamily: 'var(--ap-font-mono)',
                flexShrink: 0,
              }}
            >
              🔗{downstreamCount}
            </span>
          </Tooltip>
        )}

        <Tooltip title={ss.text}>
          <span
            style={{
              fontSize: 12,
              color: ss.color,
              fontFamily: 'var(--ap-font-mono)',
              flexShrink: 0,
              minWidth: 14,
              textAlign: 'center',
            }}
          >
            {ss.shape}
          </span>
        </Tooltip>
      </div>

      {/* Meta row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginTop: 4,
          fontSize: 11,
          color: 'var(--ap-text-muted)',
          fontFamily: 'var(--ap-font-mono)',
          minHeight: 16,
        }}
      >
        {item.class_name && <span>{item.class_name}</span>}
        {item.vt_symbol && (
          <>
            <span>·</span>
            <span>{item.vt_symbol}</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {item.signal_source_strategy && (
          <Tooltip title={`复用上游 ${item.signal_source_strategy} 的 selections.parquet（NTFS hardlink）`}>
            <span
              onClick={(e) => {
                e.stopPropagation()
                onJumpToParent?.(item.signal_source_strategy ?? '')
              }}
              style={{
                cursor: 'pointer',
                color: 'var(--ap-info)',
                fontSize: 10,
              }}
            >
              ↪ from {item.signal_source_strategy}
            </span>
          </Tooltip>
        )}
        {item.author && !item.signal_source_strategy && <span>· @{item.author}</span>}
      </div>

      {/* Equity block */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginTop: 12,
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {SOURCE_LABEL_TEXT[sourceLabel]}{' '}
            <Tooltip title={SOURCE_LABEL_HELP[sourceLabel]}>
              <InfoCircleOutlined style={{ fontSize: 10 }} />
            </Tooltip>
          </Text>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: valueColor(item.strategy_value, sourceLabel),
              fontFamily: 'var(--ap-font-mono)',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1.2,
            }}
          >
            {fmtValue(item.strategy_value)}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            持仓 {item.positions_count}
          </Text>
          <div style={{ fontSize: 11, color: 'var(--ap-text-muted)' }}>
            {item.last_update_ts ? dayjs(item.last_update_ts).fromNow() : '-'}
          </div>
        </div>
      </div>

      {/* Mini chart */}
      <div style={{ marginTop: 10, height: 40 }}>
        <MiniEquityChart points={item.mini_curve} height={40} />
      </div>

      {/* Cron schedule strip — 关键新区块 */}
      <div style={{ marginTop: 8 }}>
        <CronScheduleStrip
          triggerTime={item.trigger_time}
          buySellTime={item.buy_sell_time}
          lastRunDate={item.last_run_date}
          lastStatus={item.last_status}
          lastError={item.last_error}
          lastDurationMs={item.last_duration_ms}
          replayStatus={item.replay_status}
          isShadow={Boolean(item.signal_source_strategy)}
          offline={offline}
        />
      </div>

      {/* Action row */}
      {!offline && (
        <div style={{ marginTop: 8 }}>
          <StrategyActions
            nodeId={item.node_id}
            engine={item.engine}
            name={item.strategy_name}
            capabilities={item.capabilities}
            inited={item.inited}
            trading={item.trading}
            compact
          />
        </div>
      )}

      {/* offline 状态附加角标 */}
      {offline && item.offline_reason && (
        <div style={{ marginTop: 6, fontSize: 10, color: 'var(--ap-text-dim)', fontStyle: 'italic' }}>
          {item.offline_reason}
        </div>
      )}
    </Card>
  )
}

export default React.memo(StrategyCardV2, (prev, next) => {
  const a = prev.item
  const b = next.item
  return (
    a.node_id === b.node_id &&
    a.engine === b.engine &&
    a.strategy_name === b.strategy_name &&
    a.last_update_ts === b.last_update_ts &&
    a.strategy_value === b.strategy_value &&
    a.running === b.running &&
    a.inited === b.inited &&
    a.last_status === b.last_status &&
    a.replay_status === b.replay_status &&
    a.node_offline === b.node_offline &&
    a.last_run_date === b.last_run_date &&
    a.positions_count === b.positions_count &&
    prev.downstreamCount === next.downstreamCount &&
    prev.detailHref === next.detailHref
  )
})
