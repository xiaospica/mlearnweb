import type { EquityPoint, SourceLabel } from '@/types/liveTrading'

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function calcCumulativeReturn(
  points: EquityPoint[] | null | undefined,
  currentValue: number | null | undefined,
  sourceLabel: SourceLabel | null | undefined,
): number | null {
  const label = sourceLabel || 'unavailable'
  if (label !== 'account_equity' && label !== 'replay_settle') return null

  const current = finiteNumber(currentValue)
  if (current === null) return null

  for (const point of points || []) {
    const base = finiteNumber(point.strategy_value ?? point.account_equity)
    if (base !== null && base > 0) return current / base - 1
  }
  return null
}

export function fmtPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(2)}%`
}

export function percentColor(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'var(--ap-text-muted)'
  }
  if (value > 0) return 'var(--ap-market-up)'
  if (value < 0) return 'var(--ap-market-down)'
  return 'var(--ap-text-muted)'
}
