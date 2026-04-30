/**
 * 策略组合（多策略加权）累积收益计算
 *
 * 输入：N 条策略的累积收益曲线（dates + cumulative return）
 * 输出：组合的累积收益曲线（每日再平衡假设）
 *
 * 算法：
 * 1. 每条策略：cum_t → daily_t = (1+cum_t)/(1+cum_{t-1}) - 1（首日 = cum_0）
 * 2. 取所有策略日期并集；按日期对齐
 * 3. 每日：把当日有数据的策略的权重重新归一化，加权求和 = 组合当日收益
 * 4. 累计 product(1 + port_r) - 1
 *
 * 边界：
 * - 权重总和不必精确 = 100%，函数内部归一化
 * - 某策略缺当日数据 → 剔除该策略，剩余权重按比例放大
 * - 全部策略缺数据 → 当日组合收益 = 0（曲线平移）
 */

export interface StrategySeries {
  /** 策略 id */
  id: number | string
  dates: string[]
  /** 累积收益（小数，如 0.5 = 50%） */
  cumulative: Array<number | null | undefined>
}

export interface PortfolioCombo {
  /** 唯一 key */
  key: string
  /** 显示名 */
  name: string
  /** 权重：strategy id → 0..1 之间的数（不必精确 sum=1，函数会归一化） */
  weights: Record<string | number, number>
  /** 曲线颜色 */
  color: string
}

const cumToDaily = (cum: Array<number | null | undefined>): Array<number | null> => {
  if (cum.length === 0) return []
  const out: Array<number | null> = []
  let prev: number | null = null
  for (let i = 0; i < cum.length; i++) {
    const v = cum[i]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      out.push(null)
      continue
    }
    if (prev === null) {
      // 首个有效点：daily = cum 本身（约等于第一日的相对收益）
      out.push(v)
    } else {
      const r = (1 + v) / (1 + prev) - 1
      out.push(Number.isFinite(r) ? r : null)
    }
    prev = v
  }
  return out
}

/**
 * 计算多策略加权组合的累积收益曲线。
 *
 * @param strategies 各策略的日期 + 累积收益
 * @param weights {strategy_id: weight}，会内部归一化
 * @returns dates 并集 + 组合累积收益数组（与 dates 等长，缺数据日 = null）
 */
export const computePortfolioCumulative = (
  strategies: StrategySeries[],
  weights: Record<string | number, number>,
): { dates: string[]; cumulative: Array<number | null> } => {
  if (strategies.length === 0) return { dates: [], cumulative: [] }

  // 把每条策略转为 (date → daily) map
  const dailyMaps = strategies.map((s) => {
    const daily = cumToDaily(s.cumulative)
    const m = new Map<string, number | null>()
    s.dates.forEach((d, i) => m.set(d, daily[i] ?? null))
    return { id: s.id, m }
  })

  // 日期并集
  const dateSet = new Set<string>()
  strategies.forEach((s) => s.dates.forEach((d) => dateSet.add(d)))
  const dates = Array.from(dateSet).sort()

  const out: Array<number | null> = []
  let cumProduct = 1 // (1+r1)*(1+r2)*...
  for (const d of dates) {
    // 收集当日有数据的策略 + 其权重
    const samples: Array<{ w: number; r: number }> = []
    for (const sm of dailyMaps) {
      const w = weights[sm.id]
      if (!Number.isFinite(w) || (w as number) <= 0) continue
      const r = sm.m.get(d)
      if (typeof r !== 'number' || !Number.isFinite(r)) continue
      samples.push({ w: w as number, r })
    }
    if (samples.length === 0) {
      // 无任何策略当日有数据，组合收益 0（曲线平移）
      out.push(cumProduct - 1)
      continue
    }
    // 归一化当日权重
    const wSum = samples.reduce((s, x) => s + x.w, 0)
    const portR = samples.reduce((s, x) => s + (x.w / wSum) * x.r, 0)
    cumProduct *= 1 + portR
    out.push(cumProduct - 1)
  }

  return { dates, cumulative: out }
}

/** 默认组合调色板（避开对照色 PALETTE = [蓝/紫/橙]） */
export const PORTFOLIO_COLORS = ['#13c2c2', '#eb2f96', '#fa8c16', '#a0d911', '#2f54eb']

export const makeDefaultCombo = (
  records: Array<{ id: number | string; name?: string }>,
  index: number,
): PortfolioCombo => {
  const equalWeight = records.length > 0 ? 1 / records.length : 0
  const weights: Record<string | number, number> = {}
  records.forEach((r) => {
    weights[r.id] = equalWeight
  })
  return {
    key: `combo-${Date.now()}-${index}`,
    name: `组合 ${index + 1}`,
    weights,
    color: PORTFOLIO_COLORS[index % PORTFOLIO_COLORS.length],
  }
}
