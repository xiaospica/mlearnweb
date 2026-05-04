import React from 'react'
import { Tooltip, Typography } from 'antd'

const { Text } = Typography

export interface GlobalKpiStripProps {
  liveCount: number
  simCount: number
  offlineCount: number
  scheduleAlerts: number
  totalEquity: number | null
  nodeOnline: number
  nodeTotal: number
}

function fmtMoney(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '-'
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

/** 顶部 40px 横条：5 个 KPI 数字。给运维一眼看清整体盘口。 */
const GlobalKpiStrip: React.FC<GlobalKpiStripProps> = ({
  liveCount,
  simCount,
  offlineCount,
  scheduleAlerts,
  totalEquity,
  nodeOnline,
  nodeTotal,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        height: 40,
        padding: '0 12px',
        background: 'var(--ap-panel)',
        border: '1px solid var(--ap-border)',
        borderRadius: 6,
        fontFamily: 'var(--ap-font-mono)',
      }}
    >
      <Kpi label="节点" value={`${nodeOnline}/${nodeTotal}`} color="var(--ap-text)" />
      <Sep />
      <Kpi label="实盘" value={liveCount} color="var(--ap-danger)" />
      <Sep />
      <Kpi label="模拟" value={simCount} color="var(--ap-success)" />
      <Sep />
      {offlineCount > 0 && (
        <>
          <Kpi label="离线" value={offlineCount} color="var(--ap-text-dim)" />
          <Sep />
        </>
      )}
      <Kpi
        label="调度异常"
        value={scheduleAlerts}
        color={scheduleAlerts > 0 ? 'var(--ap-danger)' : 'var(--ap-text-muted)'}
        emphasize={scheduleAlerts > 0}
        tooltip={scheduleAlerts > 0 ? `${scheduleAlerts} 个策略上次推理失败` : '无'}
      />
      <span style={{ flex: 1 }} />
      <div style={{ textAlign: 'right' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>总权益</Text>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--ap-info)',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.2,
          }}
        >
          {fmtMoney(totalEquity)}
        </div>
      </div>
    </div>
  )
}

interface KpiProps {
  label: string
  value: number | string
  color: string
  emphasize?: boolean
  tooltip?: React.ReactNode
}

const Kpi: React.FC<KpiProps> = ({ label, value, color, emphasize, tooltip }) => {
  const inner = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, padding: '0 12px' }}>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {label}
      </Text>
      <span
        style={{
          fontSize: emphasize ? 18 : 16,
          fontWeight: 700,
          color,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.2,
        }}
      >
        {value}
      </span>
    </div>
  )
  return tooltip ? <Tooltip title={tooltip}>{inner}</Tooltip> : inner
}

const Sep: React.FC = () => (
  <span
    style={{
      width: 1,
      height: 16,
      background: 'var(--ap-border)',
    }}
  />
)

export default GlobalKpiStrip
