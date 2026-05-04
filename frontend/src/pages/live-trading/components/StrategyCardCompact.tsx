import React from 'react'
import { Tooltip } from 'antd'
import { Link } from 'react-router-dom'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
import type { LastStatus, SourceLabel, StrategyMode, StrategySummary } from '@/types/liveTrading'
import StrategyActions from './StrategyActions'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

const STATUS_GLYPH: Record<LastStatus, { glyph: string; color: string; title: string }> = {
  ok: { glyph: '✓', color: 'var(--ap-success)', title: '上次运行 ok' },
  failed: { glyph: '✗', color: 'var(--ap-danger)', title: '上次运行 failed' },
  empty: { glyph: '⊝', color: 'var(--ap-warning)', title: '上次运行 empty' },
}

function modeBg(mode: StrategyMode | null, offline: boolean): string {
  if (offline) return 'transparent'
  if (mode === 'live') return 'color-mix(in srgb, var(--ap-danger) 4%, var(--ap-panel))'
  return 'color-mix(in srgb, var(--ap-success) 4%, var(--ap-panel))'
}

function modeColor(mode: StrategyMode | null, offline: boolean): string {
  if (offline) return 'var(--ap-text-dim)'
  if (mode === 'live') return 'var(--ap-danger)'
  return 'var(--ap-success)'
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

export interface StrategyCardCompactProps {
  item: StrategySummary
  detailHref: string
}

/**
 * 64px 行式卡片，密度模式：策略数 > 20 自动启用。
 * 保留：mode 徽章 / strategy_name / state / equity / last_status icon / 操作按钮
 * 移除：mini chart / cron strip / meta / source label tooltip
 */
const StrategyCardCompact: React.FC<StrategyCardCompactProps> = ({ item, detailHref }) => {
  const offline = Boolean(item.node_offline)
  const sourceLabel = (item.source_label || 'unavailable') as SourceLabel
  const status = item.last_status ? STATUS_GLYPH[item.last_status] : null

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto auto auto',
        alignItems: 'center',
        gap: 12,
        height: 56,
        padding: '0 16px 0 14px',
        borderRadius: 8,
        border: '1px solid var(--ap-border)',
        background: modeBg(item.mode, offline),
        boxShadow: `inset 4px 0 0 0 ${modeColor(item.mode, offline)}`,
      }}
    >
      {/* mode 徽章 */}
      <span
        style={{
          padding: '1px 6px',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.4,
          color: '#fff',
          background: modeColor(item.mode, offline),
          borderRadius: 3,
          fontFamily: 'var(--ap-font-mono)',
        }}
      >
        {offline ? 'OFF' : item.mode === 'live' ? 'LIVE' : 'SIM'}
      </span>

      {/* 策略名 + class · vt_symbol */}
      <Link
        to={detailHref}
        onClick={(e) => e.stopPropagation()}
        style={{ color: 'var(--ap-text)', textDecoration: 'none', minWidth: 0 }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.strategy_name}
          {item.signal_source_strategy && (
            <span style={{ color: 'var(--ap-info)', fontSize: 11, marginLeft: 8 }}>
              ↪ {item.signal_source_strategy}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--ap-text-muted)',
            fontFamily: 'var(--ap-font-mono)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.class_name ?? ''}
          {item.vt_symbol ? ` · ${item.vt_symbol}` : ''}
        </div>
      </Link>

      {/* last status icon */}
      <Tooltip title={status?.title ?? '尚未运行'}>
        <span
          style={{
            fontSize: 14,
            color: status?.color ?? 'var(--ap-text-dim)',
            width: 20,
            textAlign: 'center',
            cursor: 'help',
            fontFamily: 'var(--ap-font-mono)',
          }}
        >
          {status?.glyph ?? '○'}
        </span>
      </Tooltip>

      {/* equity 数值 */}
      <div style={{ textAlign: 'right', minWidth: 110 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: valueColor(item.strategy_value, sourceLabel),
            fontFamily: 'var(--ap-font-mono)',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.2,
          }}
        >
          {fmtValue(item.strategy_value)}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--ap-text-muted)',
            fontFamily: 'var(--ap-font-mono)',
          }}
        >
          {item.positions_count}仓 · {item.last_update_ts ? dayjs(item.last_update_ts).fromNow() : '-'}
        </div>
      </div>

      {/* 操作按钮 */}
      {!offline ? (
        <div onClick={(e) => e.stopPropagation()}>
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
      ) : (
        <span style={{ width: 1 }} />
      )}
    </div>
  )
}

export default React.memo(StrategyCardCompact)
