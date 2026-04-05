declare module 'react-plotly.js' {
  import { Component } from 'react'
  import { PlotParams } from 'plotly.js'

  export interface PlotProps extends Partial<PlotParams> {
    data: Array<Record<string, unknown>>
    layout?: Record<string, unknown>
    config?: Record<string, unknown>
    frames?: Array<Record<string, unknown>>
    style?: React.CSSProperties
    className?: string
    useResizeHandler?: boolean
    onInitialized?: (figure: Readonly<PlotParams>, graphDiv: Readonly<HTMLElement>) => void
    onUpdate?: (figure: Readonly<PlotParams>, graphDiv: Readonly<HTMLElement>) => void
    onPurge?: (figure: Readonly<PlotParams>, graphDiv: Readonly<HTMLElement>) => void
    onError?: (error: Readonly<Error>) => void
  }

  export default class Plot extends Component<PlotProps> {}
}
