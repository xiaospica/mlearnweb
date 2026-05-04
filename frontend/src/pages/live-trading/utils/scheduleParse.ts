import dayjs, { Dayjs } from 'dayjs'

const TIME_RE = /^(\d{1,2}):(\d{2})$/

/** 解析 "HH:MM" 字符串到当日的分钟数（0-1440）。无效输入返 null。 */
export function parseTimeOfDay(s: string | null | undefined): number | null {
  if (!s) return null
  const m = TIME_RE.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
  return h * 60 + mm
}

/** "HH:MM" 当前时间在一天中的位置，返回 0-1，给 strip 横向定位用。 */
export function timeOfDayPercent(minuteOfDay: number): number {
  if (!Number.isFinite(minuteOfDay)) return 0
  return Math.max(0, Math.min(1, minuteOfDay / 1440))
}

/**
 * 给定 cron 时间数组（已解析为分钟数），算「下一次触发」距离 now 的毫秒数。
 *
 * - 如果今天还有未触发的时点 → 返回今天最近那个的差值
 * - 如果今天都过了 → 返回明天最早那个的差值（自动跨日）
 * - 时点列表为空 → 返回 null
 */
export function nextRunInMs(
  triggerMinutes: number[],
  now: Dayjs = dayjs(),
): number | null {
  if (triggerMinutes.length === 0) return null
  const nowMin = now.hour() * 60 + now.minute() + now.second() / 60
  const futureToday = triggerMinutes
    .filter((m) => m > nowMin)
    .sort((a, b) => a - b)
  if (futureToday.length > 0) {
    const target = now.startOf('day').add(futureToday[0], 'minute')
    return target.diff(now)
  }
  // 跨日：明天最早一个
  const tomorrowFirst = [...triggerMinutes].sort((a, b) => a - b)[0]
  const target = now.startOf('day').add(1, 'day').add(tomorrowFirst, 'minute')
  return target.diff(now)
}

/** 把毫秒差转换成「12h 34m」/「34m 12s」/「12s」之类紧凑展示文案。 */
export function formatCountdown(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** dayjs() 当前时间在 0-1440 分钟坐标轴的百分比位置（0-1），strip 红线定位用。 */
export function nowPercentOfDay(now: Dayjs = dayjs()): number {
  const minute = now.hour() * 60 + now.minute() + now.second() / 60
  return timeOfDayPercent(minute)
}

/**
 * 是否「今天的 trigger 已过 30 分钟但 last_run_date 仍是更早的日期」——表示推理没跑成功。
 * 用于 cron strip 闪烁报警。
 */
export function isMissedTrigger(
  triggerTime: string | null | undefined,
  lastRunDate: string | null | undefined,
  now: Dayjs = dayjs(),
): boolean {
  const tMin = parseTimeOfDay(triggerTime)
  if (tMin == null) return false
  const nowMin = now.hour() * 60 + now.minute()
  if (nowMin < tMin + 30) return false
  const todayStr = now.format('YYYY-MM-DD')
  return !lastRunDate || lastRunDate < todayStr
}
