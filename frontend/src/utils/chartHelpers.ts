export interface AlignedTickRange {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  interval: number
}

function niceNum(range: number, round: boolean): number {
  if (range <= 0 || !Number.isFinite(range)) return 1
  const exponent = Math.floor(Math.log10(range))
  const fraction = range / Math.pow(10, exponent)
  let niceFraction: number
  if (round) {
    if (fraction < 1.5) niceFraction = 1
    else if (fraction < 3) niceFraction = 2
    else if (fraction < 7) niceFraction = 5
    else niceFraction = 10
  } else {
    if (fraction <= 1) niceFraction = 1
    else if (fraction <= 2) niceFraction = 2
    else if (fraction <= 5) niceFraction = 5
    else niceFraction = 10
  }
  return niceFraction * Math.pow(10, exponent)
}

function niceBounds(min: number, max: number, interval: number): { min: number; max: number } {
  const niceMin = Math.floor(min / interval) * interval
  const niceMax = Math.ceil(max / interval) * interval
  return { min: niceMin, max: niceMax }
}

function finiteExtent(values: number[]): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
    return [min - pad, max + pad]
  }
  return [min, max]
}

function nanoToDateString(ns: number): string {
  try {
    const ms = ns / 1e6
    const date = new Date(ms)
    if (isNaN(date.getTime())) return String(ns)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  } catch {
    return String(ns)
  }
}

function isNanoTimestamp(value: unknown): boolean {
  if (typeof value !== 'number') return false
  return value > 1e15 && value < 2e18
}

export function fixPlotlyFigureXAxis(fig: any): any {
  if (!fig || !fig.data) return fig
  const hasHistogram = fig.data.some((trace: any) => trace?.type === 'histogram')
  const fixedData = fig.data.map((trace: any) => {
    if (!trace) return trace
    const fixedTrace = { ...trace }
    if (trace.type === 'histogram') return fixedTrace
    if (trace.x && Array.isArray(trace.x)) {
      const sampleValue = trace.x.find((v: any) => v !== null && v !== undefined)
      if (isNanoTimestamp(sampleValue)) {
        fixedTrace.x = trace.x.map((v: any) =>
          v !== null && v !== undefined ? nanoToDateString(v) : v,
        )
      } else {
        const hasDateLikeValues = trace.x.some(
          (v: any) =>
            typeof v === 'string' && (v.includes('-') || v.includes('/') || /^\d{4}/.test(v)),
        )
        if (!hasDateLikeValues && trace.text && Array.isArray(trace.text) && trace.text.length > 0) {
          const textSample = trace.text[0]
          if (typeof textSample === 'string' && (textSample.includes('-') || /^\d{4}/.test(textSample))) {
            fixedTrace.x = trace.text
          }
        }
      }
    }
    return fixedTrace
  })
  const fixedLayout: any = { ...fig.layout }
  if (!hasHistogram) {
    const axisKeys = ['xaxis', 'xaxis2', 'xaxis3', 'xaxis4']
    for (const key of axisKeys) {
      if (key === 'xaxis' || fixedLayout[key]) {
        fixedLayout[key] = {
          ...(fixedLayout[key] || {}),
          type: 'category',
          tickangle: -45,
          tickfont: { size: 10 },
        }
      }
    }
  }
  return { ...fig, data: fixedData, layout: fixedLayout }
}

export function computeAlignedTicks(
  xValues: number[],
  yValues: number[],
  tickCount = 6,
): AlignedTickRange {
  const [xMinRaw, xMaxRaw] = finiteExtent(xValues)
  const [yMinRaw, yMaxRaw] = finiteExtent(yValues)
  const xSpan = xMaxRaw - xMinRaw
  const ySpan = yMaxRaw - yMinRaw
  const biggerSpan = Math.max(xSpan, ySpan)
  const interval = niceNum(niceNum(biggerSpan, false) / (tickCount - 1), true)
  const xBounds = niceBounds(xMinRaw, xMaxRaw, interval)
  const yBounds = niceBounds(yMinRaw, yMaxRaw, interval)
  return {
    xMin: xBounds.min,
    xMax: xBounds.max,
    yMin: yBounds.min,
    yMax: yBounds.max,
    interval,
  }
}

/**
 * 等比刻度：x/y 使用完全相同的 range 与 interval。
 * 配合正方形容器可实现"x 的 0.2 和 y 的 0.2 视觉长度一致"。
 */
export function computeSquareTicks(
  xValues: number[],
  yValues: number[],
  tickCount = 6,
): AlignedTickRange {
  const [xMin, xMax] = finiteExtent(xValues)
  const [yMin, yMax] = finiteExtent(yValues)
  const min = Math.min(xMin, yMin)
  const max = Math.max(xMax, yMax)
  const span = Math.max(max - min, 1e-9)
  const interval = niceNum(niceNum(span, false) / (tickCount - 1), true)
  const bounds = niceBounds(min, max, interval)
  return {
    xMin: bounds.min,
    xMax: bounds.max,
    yMin: bounds.min,
    yMax: bounds.max,
    interval,
  }
}

/**
 * 等像素比例刻度：给定 plot 绘图区像素宽高，扩展较紧的轴 range，
 * 使 x 和 y 的"每单位像素数"相等 —— 即 0.1 的 x 长度 = 0.1 的 y 长度，
 * 但 x/y 的总 range 可以不同（容器无需正方形）。
 */
export function computeEqualScaleTicks(
  xValues: number[],
  yValues: number[],
  plotWidth: number,
  plotHeight: number,
  tickCount = 6,
): AlignedTickRange {
  const [xMinRaw, xMaxRaw] = finiteExtent(xValues)
  const [yMinRaw, yMaxRaw] = finiteExtent(yValues)
  let dx = Math.max(xMaxRaw - xMinRaw, 1e-9)
  let dy = Math.max(yMaxRaw - yMinRaw, 1e-9)
  const safeW = Math.max(plotWidth, 1)
  const safeH = Math.max(plotHeight, 1)
  const pxPerUnitX = safeW / dx
  const pxPerUnitY = safeH / dy
  let xMinAdj = xMinRaw
  let xMaxAdj = xMaxRaw
  let yMinAdj = yMinRaw
  let yMaxAdj = yMaxRaw
  if (pxPerUnitX > pxPerUnitY) {
    // x 方向更紧（单位密度高），扩展 x 使两轴密度一致
    const newDx = (safeW * dy) / safeH
    const pad = (newDx - dx) / 2
    xMinAdj -= pad
    xMaxAdj += pad
    dx = newDx
  } else if (pxPerUnitY > pxPerUnitX) {
    const newDy = (safeH * dx) / safeW
    const pad = (newDy - dy) / 2
    yMinAdj -= pad
    yMaxAdj += pad
    dy = newDy
  }
  // 选同一 interval：按扩展后跨度大者取 nice
  const biggerSpan = Math.max(dx, dy)
  const interval = niceNum(niceNum(biggerSpan, false) / (tickCount - 1), true)
  const xBounds = niceBounds(xMinAdj, xMaxAdj, interval)
  const yBounds = niceBounds(yMinAdj, yMaxAdj, interval)
  return {
    xMin: xBounds.min,
    xMax: xBounds.max,
    yMin: yBounds.min,
    yMax: yBounds.max,
    interval,
  }
}
