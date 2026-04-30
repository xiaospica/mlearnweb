/**
 * 策略组合编辑器：在 TrainingComparePage 的累计收益图表上方使用。
 *
 * 用户为每个对照策略输入权重（0-100%），生成一条额外的"组合累积收益"曲线
 * 显示在 OverlayTimeSeriesChart 上。支持新增多个组合同时显示。
 */

import { Button, InputNumber, Space, Tag, Tooltip, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { TrainingCompareRecord } from '@/types'
import {
  PORTFOLIO_COLORS,
  type PortfolioCombo,
  makeDefaultCombo,
} from './PortfolioCombo'

const { Text } = Typography

interface Props {
  records: TrainingCompareRecord[]
  combos: PortfolioCombo[]
  onChange: (next: PortfolioCombo[]) => void
}

const PortfolioComboBuilder: React.FC<Props> = ({ records, combos, onChange }) => {
  if (records.length < 2) return null

  const handleAdd = () => {
    onChange([...combos, makeDefaultCombo(records, combos.length)])
  }

  const handleDelete = (key: string) => {
    onChange(combos.filter((c) => c.key !== key))
  }

  const updateCombo = (key: string, patch: Partial<PortfolioCombo>) => {
    onChange(combos.map((c) => (c.key === key ? { ...c, ...patch } : c)))
  }

  return (
    <div
      style={{
        marginBottom: 12,
        padding: 12,
        background: 'var(--ap-panel-muted)',
        border: '1px solid var(--ap-border-muted)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Space size={8}>
          <Text strong style={{ fontSize: 13 }}>
            策略组合
          </Text>
          <Tooltip title="按权重模拟多策略组合的累积收益（每日再平衡，不计交易成本）">
            <Text type="secondary" style={{ fontSize: 11 }}>
              ⓘ 加权再平衡模拟
            </Text>
          </Tooltip>
        </Space>
        <Button
          type="dashed"
          size="small"
          icon={<PlusOutlined />}
          onClick={handleAdd}
          disabled={combos.length >= PORTFOLIO_COLORS.length}
        >
          添加组合
        </Button>
      </div>

      {combos.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          暂无组合。点击「添加组合」按权重模拟多策略组合的累积收益。
        </Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {combos.map((combo) => {
            const total = records.reduce(
              (s, r) => s + (combo.weights[r.id] || 0) * 100,
              0,
            )
            const totalPct = Math.round(total * 100) / 100
            const balanced = Math.abs(totalPct - 100) < 0.01
            return (
              <div
                key={combo.key}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 8,
                  padding: 8,
                  background: 'var(--ap-panel)',
                  border: '1px solid var(--ap-border-muted)',
                  borderRadius: 6,
                }}
              >
                <Tag color={combo.color} style={{ marginInlineEnd: 0 }}>
                  {combo.name}
                </Tag>
                {records.map((r) => {
                  const weight = (combo.weights[r.id] || 0) * 100
                  return (
                    <Space key={r.id} size={4} align="center">
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {r.name || `#${r.id}`}
                      </Text>
                      <InputNumber
                        size="small"
                        value={Number(weight.toFixed(2))}
                        min={0}
                        max={100}
                        step={5}
                        precision={2}
                        addonAfter="%"
                        style={{ width: 110 }}
                        onChange={(v) => {
                          const nv = typeof v === 'number' ? v : 0
                          updateCombo(combo.key, {
                            weights: { ...combo.weights, [r.id]: nv / 100 },
                          })
                        }}
                      />
                    </Space>
                  )
                })}
                <Text
                  style={{
                    fontFamily: "'SF Mono', 'Consolas', monospace",
                    fontSize: 12,
                    color: balanced ? 'var(--ap-success)' : 'var(--ap-warning)',
                    minWidth: 70,
                  }}
                >
                  Σ {totalPct.toFixed(2)}%
                </Text>
                <Button
                  type="text"
                  danger
                  size="small"
                  icon={<DeleteOutlined />}
                  onClick={() => handleDelete(combo.key)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default PortfolioComboBuilder
