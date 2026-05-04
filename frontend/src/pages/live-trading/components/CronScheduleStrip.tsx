import React, { useMemo } from 'react'
import { Tooltip } from 'antd'
import dayjs from 'dayjs'
import { useNowMs } from '../hooks/useNowMs'
import {
  formatCountdown,
  isMissedTrigger,
  nextRunInMs,
  nowPercentOfDay,
  parseTimeOfDay,
  timeOfDayPercent,
} from '../utils/scheduleParse'
import type { LastStatus, ReplayStatus } from '@/types/liveTrading'

export interface CronScheduleStripProps {
  triggerTime?: string | null  // "21:00" 日频推理时点
  buySellTime?: string | null  // "09:26" T+1 下单时点
  lastRunDate?: string | null  // YYYY-MM-DD
  lastStatus?: LastStatus | null
  lastError?: string | null
  lastDurationMs?: number | null
  replayStatus?: ReplayStatus | null
  /** 影子策略 trigger 圆点改空心：自己不跑推理 */
  isShadow?: boolean
  /** 离线状态下整 strip 置灰 */
  offline?: boolean
}

const STATUS_COLOR: Record<LastStatus, string> = {
  ok: 'var(--ap-success)',
  failed: 'var(--ap-danger)',
  empty: 'var(--ap-warning)',
}

const STATUS_LABEL: Record<LastStatus, string> = {
  ok: '✓',
  failed: '✗',
  empty: '⊝',
}

/**
 * 28px 全宽水平时间轴 strip，0:00 → 24:00 横向比例。
 *
 * 视觉元素：
 *   - 1px 灰 baseline 居中
 *   - trigger_time 蓝实心圆 + 上方时间 + 下方状态点（绿/红/黄/灰）
 *   - buy_sell_time 紫实心圆
 *   - 当前时间红色 vertical line（每秒由 NowMsContext 重渲染）
 *   - 右下倒计时 next: 12h 34m
 *   - last_status='failed' 时整 strip 浅红 bg
 *   - 影子策略 trigger 改空心圆 + ↪ reuse
 *
 * trigger_time / buy_sell_time 都为空时整条不渲染（保留 props 让父组件占位逻辑统一）。
 */
const CronScheduleStrip: React.FC<CronScheduleStripProps> = ({
  triggerTime,
  buySellTime,
  lastRunDate,
  lastStatus,
  lastError,
  lastDurationMs,
  replayStatus,
  isShadow,
  offline,
}) => {
  const nowMs = useNowMs()
  const now = useMemo(() => dayjs(nowMs), [nowMs])

  const triggerMin = parseTimeOfDay(triggerTime)
  const buySellMin = parseTimeOfDay(buySellTime)

  // strip 整片不渲染的早返回（父组件保留 28px 占位防止卡片高度跳动）
  if (triggerMin == null && buySellMin == null) {
    return <div style={{ height: 28 }} aria-hidden />
  }

  // 关键时间百分比定位
  const nowPct = nowPercentOfDay(now)
  const triggerPct = triggerMin != null ? timeOfDayPercent(triggerMin) : null
  const buySellPct = buySellMin != null ? timeOfDayPercent(buySellMin) : null

  const triggerMinutes = [triggerMin, buySellMin].filter((v): v is number => v != null)
  const nextMs = nextRunInMs(triggerMinutes, now)

  const isRunning = replayStatus === 'running'
  const isMissed = isMissedTrigger(triggerTime, lastRunDate, now) && !isRunning

  // strip 背景色
  const stripBg = offline
    ? 'transparent'
    : lastStatus === 'failed'
      ? 'color-mix(in srgb, var(--ap-danger) 8%, transparent)'
      : 'transparent'

  // 状态点颜色：running 蓝色脉冲 / failed 红 / ok 绿 / empty 黄 / 未跑 灰
  const stateDotColor = (() => {
    if (offline) return 'var(--ap-text-dim)'
    if (isRunning) return 'var(--ap-info)'
    if (lastStatus) return STATUS_COLOR[lastStatus]
    return 'var(--ap-text-dim)'
  })()

  const stateDotLabel = (() => {
    if (isRunning) return '⟳'
    if (lastStatus) return STATUS_LABEL[lastStatus]
    return '○'
  })()

  return (
    <div
      style={{
        position: 'relative',
        height: 28,
        background: stripBg,
        borderRadius: 3,
        padding: '0 4px',
      }}
    >
      {/* baseline */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: 4,
          right: 80,  // 留出右侧 next 文案空间
          height: 1,
          background: 'var(--ap-border-muted, var(--ap-border))',
          transform: 'translateY(-0.5px)',
        }}
      />

      {/* trigger 标记 */}
      {triggerPct != null && (
        <Marker
          pct={triggerPct}
          label={triggerTime ?? ''}
          color="var(--ap-info)"
          isShadow={isShadow}
          stateDot={isShadow ? null : { color: stateDotColor, label: stateDotLabel, pulse: isRunning }}
          tooltip={
            <TriggerTooltip
              kind="trigger"
              time={triggerTime ?? ''}
              lastRunDate={lastRunDate}
              lastStatus={lastStatus}
              lastDurationMs={lastDurationMs}
              lastError={lastError}
              replayStatus={replayStatus}
              isShadow={isShadow}
            />
          }
          missed={isMissed}
        />
      )}

      {/* buy_sell 标记 */}
      {buySellPct != null && (
        <Marker
          pct={buySellPct}
          label={buySellTime ?? ''}
          color="var(--ap-purple, #a855f7)"
          stateDot={null}
          tooltip={
            <TriggerTooltip
              kind="buy_sell"
              time={buySellTime ?? ''}
              lastRunDate={lastRunDate}
              lastStatus={lastStatus}
              lastDurationMs={lastDurationMs}
              lastError={lastError}
              replayStatus={replayStatus}
            />
          }
        />
      )}

      {/* 当前时间红色竖线（离线时不绘）。定位区间与 marker 对齐：左 4px 右 80px。 */}
      {!offline && (
        <div
          style={{
            position: 'absolute',
            top: 4,
            bottom: 4,
            left: `calc(4px + (100% - 84px) * ${nowPct})`,
            width: 1,
            background: 'var(--ap-danger)',
            transform: 'translateX(-0.5px)',
            pointerEvents: 'none',
            zIndex: 1,
          }}
          aria-label={`now ${now.format('HH:mm:ss')}`}
        />
      )}

      {/* 右下倒计时 / 影子标识 / 离线 */}
      <div
        style={{
          position: 'absolute',
          right: 4,
          bottom: 1,
          fontSize: 9,
          color: offline ? 'var(--ap-text-dim)' : 'var(--ap-text-muted)',
          fontFamily: 'var(--ap-font-mono)',
          lineHeight: '12px',
          maxWidth: 80,
          textAlign: 'right',
        }}
      >
        {offline ? (
          '离线'
        ) : isShadow ? (
          <Tooltip title="影子策略：复用上游 selections.parquet，不跑推理">
            <span>↪ reuse</span>
          </Tooltip>
        ) : (
          <Tooltip title={`下次触发 ${formatCountdown(nextMs)}`}>
            <span>next: {formatCountdown(nextMs)}</span>
          </Tooltip>
        )}
      </div>

      {/* 失败态右上角 ⚠ icon */}
      {!offline && lastStatus === 'failed' && lastError && (
        <Tooltip
          title={
            <div style={{ maxWidth: 360, whiteSpace: 'pre-wrap', fontFamily: 'var(--ap-font-mono)', fontSize: 11 }}>
              {lastError}
            </div>
          }
          placement="topRight"
        >
          <span
            style={{
              position: 'absolute',
              right: 4,
              top: 1,
              fontSize: 11,
              color: 'var(--ap-danger)',
              cursor: 'help',
            }}
          >
            ⚠
          </span>
        </Tooltip>
      )}
    </div>
  )
}

interface MarkerProps {
  pct: number
  label: string
  color: string
  stateDot: { color: string; label: string; pulse?: boolean } | null
  tooltip: React.ReactNode
  isShadow?: boolean
  missed?: boolean
}

const Marker: React.FC<MarkerProps> = ({ pct, label, color, stateDot, tooltip, isShadow, missed }) => {
  // 与 baseline 对齐：左 4px 右 80px 的有效区间
  const positionLeft = `calc(4px + (100% - 84px) * ${pct})`
  return (
    <Tooltip title={tooltip}>
      <div
        style={{
          position: 'absolute',
          left: positionLeft,
          top: 0,
          bottom: 0,
          transform: 'translateX(-50%)',
          width: 24,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'help',
        }}
      >
        {/* 上方时间标签 */}
        <span
          style={{
            fontSize: 9,
            lineHeight: '10px',
            color: 'var(--ap-text-muted)',
            fontFamily: 'var(--ap-font-mono)',
            marginBottom: 1,
          }}
        >
          {label}
        </span>
        {/* 中心圆点：影子策略 trigger 改空心 */}
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: isShadow ? 'transparent' : color,
            border: `1.5px solid ${color}`,
            boxShadow: missed ? `0 0 0 2px color-mix(in srgb, ${color} 40%, transparent)` : 'none',
            animation: missed ? 'cron-strip-pulse 1.5s ease-in-out infinite' : undefined,
          }}
        />
        {/* 下方状态点 */}
        {stateDot && (
          <span
            style={{
              fontSize: 9,
              lineHeight: '10px',
              color: stateDot.color,
              marginTop: 1,
              animation: stateDot.pulse ? 'cron-strip-spin 1s linear infinite' : undefined,
              display: 'inline-block',
            }}
          >
            {stateDot.label}
          </span>
        )}
      </div>
    </Tooltip>
  )
}

interface TriggerTooltipProps {
  kind: 'trigger' | 'buy_sell'
  time: string
  lastRunDate?: string | null
  lastStatus?: LastStatus | null
  lastDurationMs?: number | null
  lastError?: string | null
  replayStatus?: ReplayStatus | null
  isShadow?: boolean
}

const TriggerTooltip: React.FC<TriggerTooltipProps> = ({
  kind, time, lastRunDate, lastStatus, lastDurationMs, lastError, replayStatus, isShadow,
}) => {
  const title = kind === 'trigger' ? '日频推理 + persist' : 'T+1 复盘下单'
  const isRunning = replayStatus === 'running'
  return (
    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ fontWeight: 600 }}>{title} · {time}</div>
      {isShadow && kind === 'trigger' && (
        <div style={{ color: 'var(--ap-text-muted)' }}>影子策略：不跑推理，复用上游</div>
      )}
      {isRunning ? (
        <div>状态：<span style={{ color: 'var(--ap-info)' }}>运行中</span></div>
      ) : lastStatus ? (
        <>
          <div>
            上次运行：{lastRunDate ?? '—'} · <span style={{ color: STATUS_COLOR[lastStatus] }}>{lastStatus}</span>
            {lastDurationMs != null && <> · {lastDurationMs}ms</>}
          </div>
          {lastError && (
            <div style={{ color: 'var(--ap-danger)', whiteSpace: 'pre-wrap', maxWidth: 320 }}>
              {lastError}
            </div>
          )}
        </>
      ) : (
        <div style={{ color: 'var(--ap-text-muted)' }}>尚未运行</div>
      )}
    </div>
  )
}

export default React.memo(CronScheduleStrip)

// CSS keyframes 注入（只注一次）：失败态 marker 闪烁 + replay running 自旋
if (typeof document !== 'undefined' && !document.getElementById('cron-strip-keyframes')) {
  const style = document.createElement('style')
  style.id = 'cron-strip-keyframes'
  style.textContent = `
    @keyframes cron-strip-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }
    @keyframes cron-strip-spin { 100% { transform: rotate(360deg) } }
  `
  document.head.appendChild(style)
}
