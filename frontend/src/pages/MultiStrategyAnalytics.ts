/**
 * 多策略组合分析工具集
 *
 * 三大功能：
 * 1. computeRiskContributions      — 风险贡献分解（每策略对组合年化波动率的贡献占比）
 * 2. computeMaxSharpeWeights        — 最大夏普权重（解析解 + 长仓裁剪 + 归一）
 * 3. computeMinVarianceWeights      — 最小方差权重（同上思路）
 * 4. computeDrawdownAttribution     — 回撤归因（组合 DD 区间内各策略损益贡献）
 *
 * 所有计算基于策略 cumulative_return → 反推 daily_return，对齐到日期并集，
 * 缺数据日填 0 对组合不做贡献。
 */

import { cumToDaily } from './PortfolioCombo'

const TRADING_DAYS_PER_YEAR = 252

export interface StrategyInput {
  id: number | string
  name: string
  dates: string[]
  cumulative: Array<number | null | undefined>
}

interface AlignedReturns {
  /** 对齐后的日期 */
  dates: string[]
  /** strategies × dates 二维矩阵；缺数据填 0（不贡献组合收益） */
  matrix: number[][]
  ids: Array<number | string>
  names: string[]
}

const alignDailyReturns = (strategies: StrategyInput[]): AlignedReturns => {
  const allDates = Array.from(new Set(strategies.flatMap((s) => s.dates))).sort()
  const matrix: number[][] = []
  for (const s of strategies) {
    const daily = cumToDaily(s.cumulative)
    const m = new Map<string, number>()
    s.dates.forEach((d, i) => {
      const v = daily[i]
      if (typeof v === 'number' && Number.isFinite(v)) m.set(d, v)
    })
    matrix.push(allDates.map((d) => m.get(d) ?? 0))
  }
  return {
    dates: allDates,
    matrix,
    ids: strategies.map((s) => s.id),
    names: strategies.map((s) => s.name),
  }
}

/** 矢量均值 */
const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length)

/** 样本标准差（与 pandas Series.std() 等价，ddof=1） */
const stdSample = (xs: number[]): number => {
  const n = xs.length
  if (n < 2) return 0
  const mu = mean(xs)
  let ss = 0
  for (const v of xs) ss += (v - mu) * (v - mu)
  return Math.sqrt(ss / (n - 1))
}

/** 协方差矩阵（无偏估计 N-1） */
const covMatrix = (returns: number[][]): number[][] => {
  const n = returns.length
  const T = returns[0]?.length ?? 0
  if (n === 0 || T < 2) return []
  const mus = returns.map((r) => mean(r))
  const cov: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0
      for (let t = 0; t < T; t++) {
        s += (returns[i][t] - mus[i]) * (returns[j][t] - mus[j])
      }
      const c = s / (T - 1)
      cov[i][j] = c
      cov[j][i] = c
    }
  }
  return cov
}

/** 矩阵向量乘 Σw */
const matVec = (M: number[][], v: number[]): number[] => {
  const n = M.length
  const r: number[] = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) r[i] += M[i][j] * v[j]
  }
  return r
}

const dot = (a: number[], b: number[]): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Gauss-Jordan 求逆（小矩阵 N≤10 没问题） */
const invertMatrix = (M: number[][]): number[][] | null => {
  const n = M.length
  // 增广矩阵 [M | I]
  const a: number[][] = M.map((row, i) => [...row, ...new Array(n).fill(0).map((_, j) => (i === j ? 1 : 0))])
  for (let i = 0; i < n; i++) {
    // 找主元
    let pivot = i
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(a[k][i]) > Math.abs(a[pivot][i])) pivot = k
    }
    if (Math.abs(a[pivot][i]) < 1e-12) return null // 奇异
    if (pivot !== i) [a[i], a[pivot]] = [a[pivot], a[i]]
    const piv = a[i][i]
    for (let j = 0; j < 2 * n; j++) a[i][j] /= piv
    for (let k = 0; k < n; k++) {
      if (k === i) continue
      const factor = a[k][i]
      for (let j = 0; j < 2 * n; j++) a[k][j] -= factor * a[i][j]
    }
  }
  return a.map((row) => row.slice(n))
}

// ----------------------------------------------------------
// 1. 风险贡献分解
// ----------------------------------------------------------

export interface RiskContribution {
  strategyId: number | string
  strategyName: string
  /** 用户输入的权重 0..1 */
  weight: number
  /** 该策略对组合方差的边际贡献 = w_i * (Σw)_i */
  marginalRisk: number
  /** 占组合总风险（标准差）的百分比 0..1 */
  riskShare: number
  /** 该策略本身的年化波动率 */
  annualVolatility: number
}

export interface PortfolioRisk {
  contributions: RiskContribution[]
  /** 组合年化波动率 */
  portfolioVolatility: number
}

/**
 * 给定策略 + 权重，分解每策略对组合风险（方差/波动率）的贡献。
 *
 * 数学：
 *   σ_p² = w' Σ w
 *   边际方差贡献 RC_i = w_i * (Σw)_i  →  Σ RC_i = σ_p²
 *   风险占比 = RC_i / σ_p²            →  Σ riskShare = 1
 *
 * "weight 大但 riskShare 也很大" → 该策略主导组合风险
 * "weight 小但 riskShare 不小" → 该策略风险偏高，应警惕
 */
export const computeRiskContributions = (
  strategies: StrategyInput[],
  weights: Record<string | number, number>,
): PortfolioRisk | null => {
  if (strategies.length === 0) return null
  const aligned = alignDailyReturns(strategies)
  const n = aligned.matrix.length
  if (n === 0) return null

  const cov = covMatrix(aligned.matrix)
  if (cov.length === 0) return null

  const wVec = aligned.ids.map((id) => weights[id] ?? 0)
  const wSum = wVec.reduce((s, v) => s + v, 0)
  // 归一化（容忍 ≠ 100%）
  const wNorm = wSum > 0 ? wVec.map((v) => v / wSum) : wVec

  const sigW = matVec(cov, wNorm)
  const variance = dot(wNorm, sigW)
  const sigma = Math.sqrt(Math.max(0, variance))
  if (sigma === 0) return null

  const contributions: RiskContribution[] = aligned.ids.map((id, i) => {
    const marginal = wNorm[i] * sigW[i]
    const ownVar = cov[i][i]
    return {
      strategyId: id,
      strategyName: aligned.names[i],
      weight: wNorm[i],
      marginalRisk: marginal,
      riskShare: variance > 0 ? marginal / variance : 0,
      annualVolatility: Math.sqrt(Math.max(0, ownVar) * TRADING_DAYS_PER_YEAR),
    }
  })

  return {
    contributions,
    portfolioVolatility: sigma * Math.sqrt(TRADING_DAYS_PER_YEAR),
  }
}

// ----------------------------------------------------------
// 2. 最大夏普 / 最小方差权重
// ----------------------------------------------------------

export interface OptimizedWeights {
  /** 归一化后的权重 sum=1，所有 ≥0（已裁剪长仓） */
  weights: Record<string | number, number>
  /** 组合年化收益 */
  expectedAnnualReturn: number
  /** 组合年化波动率 */
  expectedAnnualVolatility: number
  /** 年化夏普（无风险利率假设 0） */
  expectedSharpe: number
  /** 是否裁剪了负权重（无约束最优解含空头时为 true） */
  clipped: boolean
}

const buildOptimizedFromWeights = (
  aligned: AlignedReturns,
  cov: number[][],
  weightsArr: number[],
  clipped: boolean,
): OptimizedWeights => {
  const meanReturns = aligned.matrix.map((r) => mean(r))
  const expectedDailyReturn = dot(weightsArr, meanReturns)
  const sigW = matVec(cov, weightsArr)
  const variance = dot(weightsArr, sigW)
  const sigma = Math.sqrt(Math.max(0, variance))

  const weights: Record<string | number, number> = {}
  aligned.ids.forEach((id, i) => {
    weights[id] = weightsArr[i]
  })

  const annRet = expectedDailyReturn * TRADING_DAYS_PER_YEAR
  const annVol = sigma * Math.sqrt(TRADING_DAYS_PER_YEAR)

  return {
    weights,
    expectedAnnualReturn: annRet,
    expectedAnnualVolatility: annVol,
    expectedSharpe: annVol > 0 ? annRet / annVol : 0,
    clipped,
  }
}

/**
 * 最大夏普权重（无约束解析解 + 长仓裁剪）。
 *
 * 解析解：w* ∝ Σ⁻¹ μ
 * 实际：解 w*，将负权重 clip 到 0，重新归一化（次优但实用）
 */
export const computeMaxSharpeWeights = (
  strategies: StrategyInput[],
): OptimizedWeights | null => {
  if (strategies.length < 2) return null
  const aligned = alignDailyReturns(strategies)
  const n = aligned.matrix.length
  if (n === 0) return null

  const cov = covMatrix(aligned.matrix)
  const covInv = invertMatrix(cov)
  if (!covInv) return null

  const meanReturns = aligned.matrix.map((r) => mean(r))
  const raw = matVec(covInv, meanReturns)
  const rawSum = raw.reduce((s, v) => s + v, 0)
  if (rawSum === 0) return null

  const unconstrained = raw.map((v) => v / rawSum)
  const hasNeg = unconstrained.some((v) => v < 0)
  // 长仓裁剪：负权重置 0，再按非零项归一
  const clipped = unconstrained.map((v) => Math.max(0, v))
  const clippedSum = clipped.reduce((s, v) => s + v, 0)
  if (clippedSum === 0) return null
  const final = clipped.map((v) => v / clippedSum)

  return buildOptimizedFromWeights(aligned, cov, final, hasNeg)
}

/**
 * 最小方差权重（无约束解析解 + 长仓裁剪）。
 *
 * 解析解：w* ∝ Σ⁻¹ 1
 */
export const computeMinVarianceWeights = (
  strategies: StrategyInput[],
): OptimizedWeights | null => {
  if (strategies.length < 2) return null
  const aligned = alignDailyReturns(strategies)
  const n = aligned.matrix.length
  if (n === 0) return null

  const cov = covMatrix(aligned.matrix)
  const covInv = invertMatrix(cov)
  if (!covInv) return null

  const ones = new Array(n).fill(1)
  const raw = matVec(covInv, ones)
  const rawSum = raw.reduce((s, v) => s + v, 0)
  if (rawSum === 0) return null

  const unconstrained = raw.map((v) => v / rawSum)
  const hasNeg = unconstrained.some((v) => v < 0)
  const clipped = unconstrained.map((v) => Math.max(0, v))
  const clippedSum = clipped.reduce((s, v) => s + v, 0)
  if (clippedSum === 0) return null
  const final = clipped.map((v) => v / clippedSum)

  return buildOptimizedFromWeights(aligned, cov, final, hasNeg)
}

// ----------------------------------------------------------
// 3. 回撤归因
// ----------------------------------------------------------

export interface DrawdownPeriod {
  startDate: string
  troughDate: string
  endDate: string
  durationDays: number
  /** 负数，组合在该区间的累积收益 */
  drawdown: number
  /** 各策略在该区间的损益贡献（按权重加权后的累积日收益和），求和 ≈ drawdown */
  perStrategyContribution: Array<{ id: number | string; name: string; contribution: number }>
}

/**
 * 计算组合的 top-N 回撤区间，并归因到每个策略。
 *
 * 算法：
 * 1. 反推每策略 daily return → 加权 → 组合 daily return
 * 2. 累积到 cum return；找 peak → trough → recovery 区间
 * 3. 每策略在该区间的"贡献" = sum(w_i * r_i_t) over t in window
 */
export const computeDrawdownAttribution = (
  strategies: StrategyInput[],
  weights: Record<string | number, number>,
  topN: number = 5,
): DrawdownPeriod[] => {
  if (strategies.length === 0) return []
  const aligned = alignDailyReturns(strategies)
  const n = aligned.matrix.length
  const T = aligned.dates.length
  if (n === 0 || T === 0) return []

  // 归一化权重
  const wVec = aligned.ids.map((id) => weights[id] ?? 0)
  const wSum = wVec.reduce((s, v) => s + v, 0)
  const wNorm = wSum > 0 ? wVec.map((v) => v / wSum) : wVec

  // 组合每日收益
  const portDaily: number[] = new Array(T).fill(0)
  for (let t = 0; t < T; t++) {
    let s = 0
    for (let i = 0; i < n; i++) s += wNorm[i] * aligned.matrix[i][t]
    portDaily[t] = s
  }
  // 组合累积净值
  const portCum: number[] = new Array(T)
  let acc = 1
  for (let t = 0; t < T; t++) {
    acc *= 1 + portDaily[t]
    portCum[t] = acc
  }

  // 识别 DD 区间：peak → trough → recovery
  const periods: DrawdownPeriod[] = []
  let peak = portCum[0]
  let peakIdx = 0
  let inDD = false
  let troughIdx = 0
  let troughValue = portCum[0]

  const closePeriod = (recoveryIdx: number) => {
    if (!inDD) return
    const dd = troughValue / peak - 1
    if (dd >= -1e-6) return
    // 各策略在 [peakIdx+1, recoveryIdx] 的贡献
    const contribs = aligned.ids.map((id, i) => {
      let c = 0
      for (let t = peakIdx + 1; t <= recoveryIdx; t++) c += wNorm[i] * aligned.matrix[i][t]
      return { id, name: aligned.names[i], contribution: c }
    })
    periods.push({
      startDate: aligned.dates[peakIdx],
      troughDate: aligned.dates[troughIdx],
      endDate: aligned.dates[recoveryIdx],
      durationDays: recoveryIdx - peakIdx,
      drawdown: dd,
      perStrategyContribution: contribs,
    })
    inDD = false
  }

  for (let t = 1; t < T; t++) {
    const v = portCum[t]
    if (v > peak) {
      // 创新高 → 关闭当前 DD（如果在 DD 中）
      if (inDD) closePeriod(t - 1)
      peak = v
      peakIdx = t
      inDD = false
      continue
    }
    // 没创新高
    if (!inDD && v < peak) {
      inDD = true
      troughIdx = t
      troughValue = v
    } else if (inDD) {
      if (v < troughValue) {
        troughIdx = t
        troughValue = v
      }
    }
  }
  // 末尾仍在 DD：用最后一日收尾
  if (inDD) closePeriod(T - 1)

  // 按 |drawdown| 降序，取 topN
  return periods.sort((a, b) => a.drawdown - b.drawdown).slice(0, topN)
}

// ----------------------------------------------------------
// 4. 组合关键指标（与后端 _compute_merged_metrics 严格对齐）
// ----------------------------------------------------------

export interface PortfolioMetrics {
  /** 累积收益: cum[-1] = product(1+r) - 1 */
  totalReturn: number
  /** 年化收益（单利，与后端一致）: mean(r) * 252 */
  annualizedReturn: number
  /** 年化波动率: std(r, ddof=1) * sqrt(252) */
  annualVolatility: number
  /** Sharpe (rf=0): mean / std * sqrt(252) — std=0 返回 null */
  sharpe: number | null
  /** Sortino: mean / std_downside * sqrt(252) — 无下跌哨兵 std=0.0001 */
  sortino: number
  /** Calmar: mean*252 / |max_dd| — max_dd=0 返回 null */
  calmar: number | null
  /** 最大回撤（负数） */
  maxDrawdown: number
  /** 胜率：count(r>0) / 全天数（与后端 .mean() 等价） */
  winRate: number
  /** 单日最大盈利 */
  maxSingleDayGain: number
  /** 单日最大亏损 */
  maxSingleDayLoss: number
  /** 有效样本天数（reset 组合曲线的总天数） */
  totalTradingDays: number
}

/**
 * 给定权重，计算组合的关键指标。
 *
 * **严格对齐后端 `_compute_merged_metrics`（mlearnweb/backend/app/routers/training_records.py:513）**
 * 公式参考：
 *  - annualized_return = mean(daily) * 252  (单利)
 *  - sharpe = mean / std(ddof=1) * sqrt(252)
 *  - sortino = mean / std_downside(ddof=1) * sqrt(252)，无下跌时 std 哨兵=0.0001
 *  - max_drawdown = min((cum - cummax) / cummax)，cum 用 NAV 起点 1
 *  - calmar = mean*252 / |max_dd|
 *  - win_rate = count(daily > 0) / len(daily)
 *
 * 数据流复用 computePortfolioCumulative 的对齐 + 权重归一化逻辑（同口径）。
 */
export const computePortfolioMetrics = (
  strategies: StrategyInput[],
  weights: Record<string | number, number>,
): PortfolioMetrics | null => {
  if (strategies.length === 0) return null

  // 对齐 + 反推日收益
  const dailyMaps = strategies.map((s) => {
    const daily = cumToDaily(s.cumulative)
    const m = new Map<string, number | null>()
    s.dates.forEach((d, i) => m.set(d, daily[i] ?? null))
    return { id: s.id, m }
  })

  const allDates = Array.from(new Set(strategies.flatMap((s) => s.dates))).sort()
  const portDaily: number[] = []
  const portNav: number[] = []
  let nav = 1

  for (const d of allDates) {
    // 当日有数据的策略 + 权重
    const samples: Array<{ w: number; r: number }> = []
    for (const sm of dailyMaps) {
      const w = weights[sm.id]
      if (!Number.isFinite(w) || (w as number) <= 0) continue
      const r = sm.m.get(d)
      if (typeof r !== 'number' || !Number.isFinite(r)) continue
      samples.push({ w: w as number, r })
    }
    let portR = 0
    if (samples.length > 0) {
      const wSum = samples.reduce((s, x) => s + x.w, 0)
      portR = samples.reduce((s, x) => s + (x.w / wSum) * x.r, 0)
    }
    portDaily.push(portR)
    nav *= 1 + portR
    portNav.push(nav)
  }

  if (portDaily.length === 0) return null

  // total_return = cum[-1]/cum[0] - 1 (NAV 起点 = 1 → 等价于 nav[-1] - 1 = product(1+r) - 1)
  const totalReturn = portNav[portNav.length - 1] - 1

  // mean / std (与 pandas dropna().mean() / std(ddof=1) 等价；这里 portDaily 已是连续 finite)
  const meanR = mean(portDaily)
  const stdR = stdSample(portDaily)

  // max drawdown: min((nav - cummax) / cummax)
  let runningMax = portNav[0]
  let maxDD = 0
  for (const v of portNav) {
    if (v > runningMax) runningMax = v
    const dd = runningMax > 0 ? (v - runningMax) / runningMax : 0
    if (dd < maxDD) maxDD = dd
  }

  // sortino: 下跌方差仅用 r<0 子集（与后端一致）；无下跌时 std 哨兵 0.0001
  const downside = portDaily.filter((r) => r < 0)
  const downsideStd = downside.length > 0 ? stdSample(downside) : 0.0001
  const sortino = (meanR / downsideStd) * Math.sqrt(TRADING_DAYS_PER_YEAR)

  const annualizedReturn = meanR * TRADING_DAYS_PER_YEAR
  const annualVol = stdR * Math.sqrt(TRADING_DAYS_PER_YEAR)
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(TRADING_DAYS_PER_YEAR) : null
  const calmar = Math.abs(maxDD) > 0 ? annualizedReturn / Math.abs(maxDD) : null

  return {
    totalReturn,
    annualizedReturn,
    annualVolatility: annualVol,
    sharpe,
    sortino,
    calmar,
    maxDrawdown: maxDD,
    winRate: portDaily.filter((r) => r > 0).length / portDaily.length,
    maxSingleDayGain: Math.max(...portDaily),
    maxSingleDayLoss: Math.min(...portDaily),
    totalTradingDays: portDaily.length,
  }
}
