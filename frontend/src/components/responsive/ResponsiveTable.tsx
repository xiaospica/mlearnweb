/**
 * AlphaPilot 响应式表格
 *
 * 桌面/平板：标准 AntD <Table>，列的 `priority` 翻译为 AntD 内置 responsive 数组
 * 移动 (<md)：渲染卡片列表，每行 → 一张 Card，列按 `mobileRole` 分配位置：
 *   - title    →  卡片大标题（一张卡只取第一个 title 列）
 *   - subtitle →  标题下方小字
 *   - badge    →  标题右侧小徽标横排
 *   - metric   →  双列 label/value 网格（核心数据）
 *   - hidden   →  默认折叠，「更多字段」展开后用 Descriptions 列出
 *   - 未声明的列：在卡片上**不显示**（只在桌面 Table 出现）
 *
 * 「无信息丢失」承诺：把次要列声明为 mobileRole='hidden'（而不是省略），
 * 移动端用户仍可一键展开看到全部字段。
 *
 * 注意：移动端卡片视图按 dataSource 顺序展示。若调用方使用 AntD Table 的客户端
 * 分页，要么改为服务端分页（dataSource 已是当前页），要么自行预切片。
 * pagination prop 在移动端只控制底部 Pagination 控件，不切 dataSource。
 */

import { useMemo, type Key, type ReactNode } from 'react'
import { Card, Collapse, Descriptions, Empty, Pagination, Skeleton, Table } from 'antd'
import type { ColumnType, TableProps } from 'antd/es/table'
import type { Breakpoint } from 'antd/es/_util/responsiveObserver'
import { useIsMobile } from '@/hooks/useBreakpoint'

export type ResponsivePriority = 'always' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl'
export type MobileRole = 'title' | 'subtitle' | 'badge' | 'metric' | 'hidden'

export interface ResponsiveColumn<T> extends ColumnType<T> {
  /** 该列从哪个断点起开始渲染（桌面）。'always' = 始终；'md' = ≥md。默认 'always'。
   *  作用于 AntD Table 的 responsive prop，仅影响 ≥md 桌面/平板视图。 */
  priority?: ResponsivePriority
  /** 该列在移动卡片视图中扮演的角色。未声明 = 仅桌面显示，卡片视图忽略。 */
  mobileRole?: MobileRole
  /** 移动卡片视图独立渲染（不影响桌面 render）。未提供则回退 col.render → raw value。 */
  mobileRender?: (value: unknown, record: T, index: number) => ReactNode
}

export interface ResponsiveTableProps<T extends object> {
  rowKey: keyof T | ((row: T) => Key)
  dataSource: T[]
  columns: ResponsiveColumn<T>[]
  loading?: boolean
  pagination?: TableProps<T>['pagination']
  size?: 'small' | 'middle' | 'large'
  /** 桌面端横向滚动阈值（透传给 AntD Table 的 scroll.x） */
  scrollX?: number | string | true
  /** 行/卡片点击 */
  onRowClick?: (row: T, index: number) => void
  /** 卡片底部操作按钮组（仅移动端生效；事件已 stopPropagation 防触发 onRowClick） */
  cardActions?: (row: T, index: number) => ReactNode
  /** 空数据描述 */
  emptyText?: ReactNode
  /** 移动端是否渲染「更多字段」折叠（默认 true，仅当存在 hidden 列时生效） */
  showMobileExtras?: boolean
}

const BP_ORDER: Breakpoint[] = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl']

const priorityToResponsive = (p?: ResponsivePriority): Breakpoint[] | undefined => {
  if (!p || p === 'always') return undefined
  const start = BP_ORDER.indexOf(p as Breakpoint)
  return start === -1 ? undefined : BP_ORDER.slice(start)
}

const getValue = <T,>(col: ColumnType<T>, row: T): unknown => {
  const di = col.dataIndex as unknown
  if (di == null) return undefined
  if (Array.isArray(di)) {
    return (di as Array<string | number>).reduce<unknown>(
      (acc, k) => (acc == null ? acc : (acc as Record<string | number, unknown>)[k]),
      row,
    )
  }
  return (row as Record<string, unknown>)[di as string]
}

const renderCell = <T,>(col: ResponsiveColumn<T>, row: T, idx: number): ReactNode => {
  const v = getValue(col, row)
  if (col.mobileRender) return col.mobileRender(v, row, idx)
  if (col.render) return col.render(v as never, row, idx) as ReactNode
  return v as ReactNode
}

const resolveRowKey = <T extends object>(rk: ResponsiveTableProps<T>['rowKey'], row: T): Key => {
  if (typeof rk === 'function') return rk(row)
  return (row as Record<string, unknown>)[rk as string] as Key
}

const colKey = <T,>(col: ResponsiveColumn<T>, fallback: number): Key =>
  (col.key as Key) ?? (col.dataIndex as Key) ?? fallback

function ResponsiveTable<T extends object>(props: ResponsiveTableProps<T>) {
  const {
    rowKey,
    dataSource,
    columns,
    loading,
    pagination,
    size = 'middle',
    scrollX,
    onRowClick,
    cardActions,
    emptyText,
    showMobileExtras = true,
  } = props
  const isMobile = useIsMobile()

  // 桌面 / 平板：把自定义字段从 column 中剥离，priority → responsive
  const desktopColumns = useMemo<ColumnType<T>[]>(
    () =>
      columns.map((c) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { priority, mobileRole, mobileRender, ...rest } = c
        const responsive = priorityToResponsive(priority)
        return responsive ? { ...rest, responsive } : rest
      }),
    [columns],
  )

  if (!isMobile) {
    return (
      <Table<T>
        rowKey={rowKey as TableProps<T>['rowKey']}
        dataSource={dataSource}
        columns={desktopColumns}
        loading={loading}
        pagination={pagination}
        size={size}
        scroll={scrollX ? { x: scrollX } : undefined}
        onRow={
          onRowClick
            ? (record, index) => ({
                onClick: () => onRowClick(record, index ?? 0),
                style: { cursor: 'pointer' },
              })
            : undefined
        }
        locale={emptyText ? { emptyText } : undefined}
      />
    )
  }

  // ============ 移动端卡片视图 ============
  const titleCol = columns.find((c) => c.mobileRole === 'title')
  const subtitleCol = columns.find((c) => c.mobileRole === 'subtitle')
  const badgeCols = columns.filter((c) => c.mobileRole === 'badge')
  const metricCols = columns.filter((c) => c.mobileRole === 'metric')
  const hiddenCols = columns.filter((c) => c.mobileRole === 'hidden')

  if (loading) {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} size="small" style={{ background: 'var(--ap-panel)' }}>
            <Skeleton active paragraph={{ rows: 2 }} />
          </Card>
        ))}
      </div>
    )
  }

  if (dataSource.length === 0) {
    return <Empty description={emptyText ?? '暂无数据'} style={{ padding: '32px 0' }} />
  }

  // pagination 控件渲染条件
  const showPagination =
    pagination != null && pagination !== false && typeof pagination === 'object' && pagination.total != null

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {dataSource.map((row, idx) => {
        const key = resolveRowKey<T>(rowKey, row)
        const cardClickable = !!onRowClick
        return (
          <Card
            key={key}
            size="small"
            onClick={cardClickable ? () => onRowClick!(row, idx) : undefined}
            style={{
              cursor: cardClickable ? 'pointer' : 'default',
              background: 'var(--ap-panel)',
              border: '1px solid var(--ap-border)',
            }}
            styles={{ body: { padding: 12 } }}
          >
            {/* 标题 + 徽标行 */}
            {(titleCol || badgeCols.length > 0) && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 8,
                  marginBottom: subtitleCol ? 4 : metricCols.length ? 8 : 0,
                }}
              >
                {titleCol && (
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: 'var(--ap-text)',
                      minWidth: 0,
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {renderCell(titleCol, row, idx)}
                  </div>
                )}
                {badgeCols.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flexShrink: 0 }}>
                    {badgeCols.map((c, i) => (
                      <span key={colKey(c, i)}>{renderCell(c, row, idx)}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 副标题 */}
            {subtitleCol && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--ap-text-muted)',
                  marginBottom: metricCols.length ? 8 : 0,
                }}
              >
                {renderCell(subtitleCol, row, idx)}
              </div>
            )}

            {/* metric 双列网格 */}
            {metricCols.length > 0 && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: '8px 16px',
                  marginBottom: hiddenCols.length || cardActions ? 8 : 0,
                }}
              >
                {metricCols.map((c, i) => (
                  <div key={colKey(c, i)} style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: 'var(--ap-text-muted)', marginBottom: 2 }}>
                      {c.title as ReactNode}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: 'var(--ap-text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {renderCell(c, row, idx)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 「更多字段」展开 */}
            {showMobileExtras && hiddenCols.length > 0 && (
              <Collapse
                ghost
                size="small"
                style={{ marginBottom: cardActions ? 4 : 0 }}
                items={[
                  {
                    key: 'extras',
                    label: (
                      <span style={{ fontSize: 12, color: 'var(--ap-text-muted)' }}>更多字段</span>
                    ),
                    children: (
                      <Descriptions size="small" column={1} colon>
                        {hiddenCols.map((c, i) => (
                          <Descriptions.Item
                            key={colKey(c, i)}
                            label={c.title as ReactNode}
                          >
                            {renderCell(c, row, idx)}
                          </Descriptions.Item>
                        ))}
                      </Descriptions>
                    ),
                  },
                ]}
              />
            )}

            {/* 卡片底部操作按钮（阻止冒泡到 onRowClick） */}
            {cardActions && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 8,
                  marginTop: 8,
                  borderTop: '1px solid var(--ap-border-muted)',
                  paddingTop: 8,
                }}
              >
                {cardActions(row, idx)}
              </div>
            )}
          </Card>
        )
      })}

      {showPagination && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <Pagination
            simple
            size="small"
            current={pagination.current ?? 1}
            pageSize={pagination.pageSize ?? 10}
            total={pagination.total}
            onChange={(page, pageSize) => {
              pagination.onChange?.(page, pageSize)
            }}
          />
        </div>
      )}
    </div>
  )
}

export default ResponsiveTable
