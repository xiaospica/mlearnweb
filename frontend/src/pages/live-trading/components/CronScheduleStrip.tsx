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

  // trigger / buy_sell 都缺失 → 退化分支：
  // 1) 有 last_status / last_run_date / replay_status 任一 → 渲染单行紧凑 chip（仍能看到调度健康度）
  // 2) 完全没数据 → 空占位 28px（保持卡片高度稳定）
  if (triggerMin == null && buySellMin == null) {
    const hasAnySignal =
      lastStatus != null || lastRunDate != null || replayStatus != null || lastError != null
    if (!hasAnySignal) {
      return <div style={{ height: 44 }} aria-hidden />
    }
    const isRunning = replayStatus === 'running'
    const dotColor = offline
      ? 'var(--ap-text-dim)'
      : isRunning
        ? 'var(--ap-info)'
        : lastStatus
          ? STATUS_COLOR[lastStatus]
          : 'var(--ap-text-dim)'
    const dotLabel = isRunning ? '⟳' : lastStatus ? STATUS_LABEL[lastStatus] : '○'
    return (
      <div
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px',
          fontSize: 12,
          color: 'var(--ap-text-muted)',
          fontFamily: 'var(--ap-font-mono)',
          // 与主 strip 同款融合方案：transparent + 顶部 1px 分隔
          background:
            lastStatus === 'failed'
              ? 'color-mix(in srgb, var(--ap-danger) 10%, transparent)'
              : 'transparent',
          borderTop: '1px solid color-mix(in srgb, var(--ap-text) 8%, transparent)',
        }}
      >
        <span
          style={{ color: dotColor, fontSize: 13, animation: isRunning ? 'cron-strip-spin 1s linear infinite' : undefined, display: 'inline-block' }}
        >
          {dotLabel}
        </span>
        <span style={{ color: 'var(--ap-text)' }}>
          {isRunning ? '运行中' : lastStatus ? `上次 ${lastStatus}` : '尚未运行'}
        </span>
        {lastRunDate && <span>· {lastRunDate}</span>}
        {lastDurationMs != null && <span>· {lastDurationMs}ms</span>}
        {!offline && lastStatus === 'failed' && lastError && (
          <Tooltip
            title={
              <div style={{ maxWidth: 360, whiteSpace: 'pre-wrap', fontFamily: 'var(--ap-font-mono)', fontSize: 11 }}>
                {lastError}
              </div>
            }
            placement="topRight"
          >
            <span style={{ marginLeft: 'auto', color: 'var(--ap-danger)', cursor: 'help' }}>⚠</span>
          </Tooltip>
        )}
        <Tooltip title="该策略 parameters 未暴露 trigger_time / buy_sell_time，无法绘制日内时间轴。请升级 vnpy 端或在 strategy setting 里设置该字段。">
          <span style={{ marginLeft: 'auto', color: 'var(--ap-text-dim)', fontSize: 10, cursor: 'help' }}>无 cron</span>
        </Tooltip>
      </div>
    )
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

  // 右侧 next 文本占位宽度（放大后给到 88px，和 marker 定位区间联动）
  const rightReserve = 88
  // 已过部分填充宽度的百分比（baseline 上"今天进度条"的视觉锚点）
  const progressStart = Math.min(...triggerMinutes) / 1440
  const progressEnd = Math.min(nowPct, 1)
  const showProgress = !offline && progressEnd > progressStart

  return (
    <div
      style={{
        position: 'relative',
        height: 44,
        // 与卡片表面融合：默认 transparent + 顶部 1px 分隔线；失败态用半透明红 tint
        // 不再用独立 panel-muted bg（视觉上像挖洞），保持"卡片底部信息区"的连续感
        background:
          lastStatus === 'failed'
            ? 'color-mix(in srgb, var(--ap-danger) 10%, transparent)'
            : 'transparent',
        borderTop: '1px solid color-mix(in srgb, var(--ap-text) 8%, transparent)',
        borderRadius: 0,
        padding: '0 6px',
      }}
    >
      {/* baseline 轨道 — 3px 高 + --ap-text-dim 色，与卡片表面 (panel-elevated) 形成
       *   足够亮度差: dark #666 vs #2c2c2c, light #9ca3af vs #fff，扫读距离明显加大。 */}
      <div
        style={{
          position: 'absolute',
          top: 24,
          left: 6,
          right: rightReserve,
          height: 3,
          background: 'var(--ap-text-dim)',
          borderRadius: 1.5,
        }}
      />

      {/* 已过当日"进度填充" — 从首个 cron 时点延伸到 now，配合更亮的 baseline
       *   提到 60% info 蓝，仍然清晰可辨已过 vs 未过。 */}
      {showProgress && (
        <div
          style={{
            position: 'absolute',
            top: 24,
            left: `calc(6px + (100% - ${rightReserve + 6}px) * ${progressStart})`,
            width: `calc((100% - ${rightReserve + 6}px) * ${progressEnd - progressStart})`,
            height: 3,
            background: 'color-mix(in srgb, var(--ap-info) 60%, transparent)',
            borderRadius: 1.5,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* trigger 标记 */}
      {triggerPct != null && (
        <Marker
          pct={triggerPct}
          rightReserve={rightReserve}
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
          rightReserve={rightReserve}
          label={buySellTime ?? ''}
          color="var(--ap-accent, #a855f7)"
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

      {/* 当前时间标识：缩短的 2px 实线 + 底端大三角（向上指）
       *   line 只覆盖 baseline 上下两侧 (y=20→42)，约 22px 高，比之前 36px 短一半；
       *   完全避开时间标签区 (y=4→17)，刷新一眼就能看到 09:26/21:00 不被压住。 */}
      {!offline && (
        <div
          style={{
            position: 'absolute',
            top: 20,
            bottom: 2,
            left: `calc(6px + (100% - ${rightReserve + 6}px) * ${nowPct})`,
            transform: 'translateX(-1px)',
            pointerEvents: 'none',
            zIndex: 3,
          }}
          aria-label={`now ${now.format('HH:mm:ss')}`}
        >
          {/* 2px 实线主体 — 短款，只覆盖 baseline 区域上下各一段 */}
          <div
            style={{
              width: 2,
              height: '100%',
              background: 'var(--ap-danger)',
            }}
          />
          {/* 底端三角向上指 — 12×7 实色，line 末端的视觉锚点 */}
          <div
            style={{
              position: 'absolute',
              bottom: -3,
              left: -5,
              width: 0,
              height: 0,
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderBottom: '7px solid var(--ap-danger)',
            }}
          />
        </div>
      )}

      {/* 右侧紧凑信息块：next 倒计时 / 影子标识 / 离线 */}
      <div
        style={{
          position: 'absolute',
          right: 6,
          top: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-end',
          fontFamily: 'var(--ap-font-mono)',
          gap: 2,
          width: rightReserve - 8,
        }}
      >
        {offline ? (
          <span style={{ fontSize: 11, color: 'var(--ap-text-dim)' }}>离线</span>
        ) : isShadow ? (
          <Tooltip title="影子策略：复用上游 selections.parquet，不跑推理">
            <span style={{ fontSize: 11, color: 'var(--ap-info)', cursor: 'help' }}>↪ reuse</span>
          </Tooltip>
        ) : (
          <>
            <span style={{ fontSize: 9, color: 'var(--ap-text-dim)', lineHeight: 1, letterSpacing: 0.4 }}>NEXT</span>
            <Tooltip title={`下一次 cron 触发：${formatCountdown(nextMs)}`}>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--ap-text)',
                  cursor: 'help',
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1.1,
                }}
              >
                {formatCountdown(nextMs)}
              </span>
            </Tooltip>
          </>
        )}
      </div>

      {/* 失败态左上角错误胶囊（替代之前右上角 ⚠ icon — 同区被 NEXT 占了） */}
      {!offline && lastStatus === 'failed' && lastError && (
        <Tooltip
          title={
            <div style={{ maxWidth: 360, whiteSpace: 'pre-wrap', fontFamily: 'var(--ap-font-mono)', fontSize: 11 }}>
              {lastError}
            </div>
          }
          placement="top"
        >
          <span
            style={{
              position: 'absolute',
              left: 6,
              top: 4,
              fontSize: 10,
              color: 'var(--ap-danger)',
              background: 'color-mix(in srgb, var(--ap-danger) 18%, transparent)',
              padding: '1px 6px',
              borderRadius: 8,
              cursor: 'help',
              fontWeight: 600,
              zIndex: 3,
            }}
          >
            ⚠ 错误
          </span>
        </Tooltip>
      )}
    </div>
  )
}

interface MarkerProps {
  pct: number
  rightReserve: number
  label: string
  color: string
  stateDot: { color: string; label: string; pulse?: boolean } | null
  tooltip: React.ReactNode
  isShadow?: boolean
  missed?: boolean
}

const Marker: React.FC<MarkerProps> = ({ pct, rightReserve, label, color, stateDot, tooltip, isShadow, missed }) => {
  // 与 baseline 对齐：左 6px → 右 (rightReserve+6)px 的有效区间
  const positionLeft = `calc(6px + (100% - ${rightReserve + 6}px) * ${pct})`
  return (
    <Tooltip title={tooltip}>
      <div
        style={{
          position: 'absolute',
          left: positionLeft,
          top: 0,
          bottom: 0,
          transform: 'translateX(-50%)',
          width: 36,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          paddingTop: 4,
          cursor: 'help',
          zIndex: 1,
        }}
      >
        {/* 上方时间标签 — 11px 加粗等粉号，比之前 9px 提升对比度 */}
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            lineHeight: '13px',
            color: 'var(--ap-text)',
            fontFamily: 'var(--ap-font-mono)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {label}
        </span>
        {/* 中心圆点 — 9px 实心 + 2px 边；外圈 halo 用 ring shadow 让圆点从 baseline 上"浮"出来 */}
        <span
          style={{
            width: 9,
            height: 9,
            marginTop: 4,
            borderRadius: '50%',
            background: isShadow ? 'var(--ap-panel-elevated)' : color,
            border: `2px solid ${color}`,
            // halo: 外圈 2px 与卡片 surface 接近的色 — 视觉上把圆点从 baseline 上分出来
            boxShadow: missed
              ? `0 0 0 3px color-mix(in srgb, ${color} 35%, transparent)`
              : `0 0 0 2px var(--ap-panel-elevated)`,
            animation: missed ? 'cron-strip-pulse 1.5s ease-in-out infinite' : undefined,
            flexShrink: 0,
          }}
        />
        {/* 下方状态点（仅 trigger）— 12px 字号，加粗 */}
        {stateDot && (
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              lineHeight: 1,
              color: stateDot.color,
              marginTop: 3,
              animation: stateDot.pulse ? 'cron-strip-spin 1s linear infinite' : undefined,
              display: 'inline-block',
              fontFamily: 'var(--ap-font-mono)',
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
