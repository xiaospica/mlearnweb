import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Descriptions, Table, Tag, Button, Space, Typography, Spin, Empty, Row, Col, Statistic, Tooltip, Badge, Tabs } from 'antd'
import { ArrowLeftOutlined, InfoCircleOutlined, SettingOutlined, UnorderedListOutlined, FileSearchOutlined, MergeCellsOutlined, LineChartOutlined, CodeOutlined } from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { trainingService } from '@/services/trainingService'
import ReactECharts from 'echarts-for-react'

const { Title, Text, Paragraph } = Typography

const STATUS_MAP: Record<string, { color: string; label: string }> = {
  running: { color: '#faad14', label: '运行中' },
  completed: { color: '#52c41a', label: '已完成' },
  failed: { color: '#ff4d4f', label: '失败' },
}

const TrainingDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data: recordData, isLoading, isError } = useQuery({
    queryKey: ['training-record', id],
    queryFn: () => trainingService.get(Number(id)),
    enabled: !!id,
  })

  const { data: mergedReportData, isLoading: isMergedLoading } = useQuery({
    queryKey: ['merged-report', id],
    queryFn: () => trainingService.getMergedReport(Number(id)),
    enabled: !!id,
  })

  const { data: logData } = useQuery({
    queryKey: ['training-log', id],
    queryFn: () => trainingService.getLog(Number(id)),
    enabled: !!id,
  })

  const record = recordData?.data
  const runMappings = record?.run_mappings || []
  const mergedReport = mergedReportData?.data
  const logContent = logData?.data?.log_content || ''

  if (isLoading) {
    return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />
  }

  if (isError || !record) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Empty description="无法加载训练详情">
          <Button type="primary" onClick={() => navigate('/')}>返回首页</Button>
        </Empty>
      </div>
    )
  }

  const statusInfo = STATUS_MAP[record.status] || STATUS_MAP.completed
  const configSnapshot = record.config_snapshot as Record<string, unknown> | undefined

  const columns = [
    {
      title: '#',
      dataIndex: 'segment_label',
      key: 'segment_label',
      width: 90,
      render: (label: string) => <Text code style={{ color: '#1677ff', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 12 }}>{label}</Text>,
    },
    {
      title: 'Roll Index',
      dataIndex: 'rolling_index',
      key: 'rolling_index',
      width: 100,
      render: (idx: number | null) => idx != null ? `#${idx + 1}` : <Text type="secondary">-</Text>,
    },
    {
      title: 'Train 时间段',
      key: 'train_range',
      width: 180,
      render: (_: unknown, rec: any) => {
        if (!rec.train_start) return <Text type="secondary">-</Text>
        const start = dayjs(rec.train_start).format('YYYY-MM-DD')
        const end = rec.train_end ? dayjs(rec.train_end).format('YYYY-MM-DD') : '?'
        return <Text style={{ fontSize: 12 }}>{start} ~ {end}</Text>
      },
    },
    {
      title: 'Test 时间段',
      key: 'test_range',
      width: 160,
      render: (_: unknown, rec: any) => {
        if (!rec.test_start) return <Text type="secondary">-</Text>
        const start = dayjs(rec.test_start).format('YYYY-MM-DD')
        const end = rec.test_end ? dayjs(rec.test_end).format('YYYY-MM-DD') : '至今'
        return <Text style={{ fontSize: 12 }}>{start} ~ {end}</Text>
      },
    },
    {
      title: 'Run ID',
      dataIndex: 'run_id',
      key: 'run_id',
      width: 140,
      ellipsis: true,
      render: (rid: string) => (
        <Tooltip title={rid}>
          <Text code style={{ color: '#6b7280', fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11 }}>
            {rid.slice(0, 12)}...
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, rec: any) => (
        <Button
          type="link"
          size="small"
          style={{ color: '#1677ff', paddingLeft: 0 }}
          onClick={(e) => {
            e.stopPropagation()
            navigate(`/report/${record.experiment_id}/${rec.run_id}`)
          }}
        >
          查看报告
        </Button>
      ),
    },
  ]

  const tabItems = [
    {
      key: 'runs',
      label: <span><UnorderedListOutlined /> 子运行列表 ({runMappings.length})</span>,
      children: runMappings.length > 0 ? (
        <Table
          dataSource={runMappings}
          columns={columns}
          rowKey="run_id"
          pagination={false}
          size="middle"
        />
      ) : (
        <Empty description="暂无关联的运行记录" style={{ padding: 32 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            该训练可能尚未完成或未成功生成运行记录
          </Text>
        </Empty>
      ),
    },
  ]

  if (runMappings.length > 1) {
    tabItems.push({
      key: 'merged',
      label: <span><MergeCellsOutlined /> 合并报告</span>,
      children: isMergedLoading ? (
        <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
      ) : mergedReport?.merged_report?.available ? (
        <MergedReportPanel data={mergedReport} />
      ) : (
        <Empty description="无法加载合并报告数据" style={{ padding: 40 }} />
      ),
    })
  }

  tabItems.push({
    key: 'log',
    label: <span><CodeOutlined /> 训练日志</span>,
    children: (
      <Card size="small" style={{ background: '#1e1e1e', borderRadius: 8 }}>
        {logContent ? (
          <pre style={{
            margin: 0,
            padding: 16,
            color: '#d4d4d4',
            fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', Consolas, monospace",
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 600,
            overflow: 'auto',
            background: 'transparent',
          }}>
            {logContent}
          </pre>
        ) : (
          <Empty 
            description="暂无训练日志" 
            style={{ padding: 40 }}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        )}
      </Card>
    ),
  })

  return (
    <div>
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>
          返回
        </Button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Title level={3} style={{ color: '#1f2937', margin: 0 }}>{record.name}</Title>
          <Space size={12}>
            <Tag color={statusInfo.color} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11 }}>
              {statusInfo.label}
            </Tag>
            <Tag color={record.category === 'rolling' ? '#722ed1' : '#1677ff'} style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11 }}>
              {record.category === 'rolling' ? '滚动训练' : '单次训练'}
            </Tag>
            {record.duration_seconds && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                耗时: {(record.duration_seconds / 60).toFixed(1)}min
              </Text>
            )}
          </Space>
        </div>
      </div>

      <Row gutter={[20, 20]} style={{ marginBottom: 20 }}>
        <Col xs={24} lg={16}>
          <Card
            title={<><InfoCircleOutlined style={{ marginRight: 8, color: '#1677ff' }} />基本信息</>}
            size="small"
          >
            <Descriptions column={{ xxl: 3, xl: 2, lg: 2, md: 1 }} bordered size="small">
              <Descriptions.Item label="名称">{record.name}</Descriptions.Item>
              <Descriptions.Item label="类型">{record.category === 'rolling' ? '滚动训练' : '单次训练'}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={statusInfo.color}>{statusInfo.label}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="描述">{record.description || '-'}</Descriptions.Item>
              <Descriptions.Item label="关联运行数">
                <Badge count={runMappings.length} style={{ backgroundColor: '#1677ff' }} /> 个 Run
              </Descriptions.Item>
              <Descriptions.Item label="实验">
                <Text code style={{ cursor: 'pointer' }} onClick={() => navigate(`/experiments/${record.experiment_id}`)}>
                  {record.experiment_name || record.experiment_id}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {record.created_at ? dayjs(record.created_at).format('YYYY-MM-DD HH:mm:ss') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="完成时间">
                {record.completed_at ? dayjs(record.completed_at).format('YYYY-MM-DD HH:mm:ss') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="命令行">
                <Text copyable style={{ fontSize: 11, fontFamily: "'SF Mono', 'Consolas', monospace" }}>
                  {record.command_line || '-'}
                </Text>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card
            title={<><SettingOutlined style={{ marginRight: 8, color: '#fa8c16' }} />配置快照</>}
            size="small"
          >
            {configSnapshot ? (
              <div style={{ maxHeight: 280, overflow: 'auto' }}>
                {Object.entries(configSnapshot).map(([key, val]) => (
                  <div key={key} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
                    <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase' }}>{key}</Text>
                    <div style={{
                      fontSize: 12, color: '#374151', marginTop: 2,
                      fontFamily: typeof val === 'object' ? "'SF Mono', 'Consolas', monospace" : undefined,
                      wordBreak: 'break-all',
                    }}>
                      {typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description="无配置快照" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Tabs defaultActiveKey="runs" items={tabItems} />
      </Card>
    </div>
  )
}

const MergedReportPanel: React.FC<{ data: any }> = ({ data }) => {
  const { record_info, merged_report, merged_metrics, individual_runs, ic_analysis, monthly_returns, rolling_stats } = data

  const calcDrawdown = (cumReturns: number[]) => {
    if (!cumReturns || cumReturns.length === 0) return []
    const result: number[] = []
    let runningMax = cumReturns[0]
    for (const val of cumReturns) {
      runningMax = Math.max(runningMax, val)
      result.push((val - runningMax) / runningMax)
    }
    return result
  }

  const drawdown = merged_report?.cumulative_return ? calcDrawdown(merged_report.cumulative_return) : []

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card title="训练概览" size="small">
            <Descriptions column={{ xxl: 6, xl: 4, lg: 3, md: 2 }} bordered size="small">
              <Descriptions.Item label="总运行数">{record_info.total_runs} 个</Descriptions.Item>
              <Descriptions.Item label="成功加载"><span style={{ color: '#52c41a' }}>{record_info.successful_runs} 个</span></Descriptions.Item>
              <Descriptions.Item label="总交易日">{merged_metrics.total_trading_days} 天</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>

        <Col span={24}>
          <Card title="详细统计指标" size="small">
            <Descriptions column={{ xxl: 6, xl: 4, lg: 3, md: 2 }} bordered size="small">
              <Descriptions.Item label="总收益率">{(merged_metrics.total_return * 100).toFixed(2)}%</Descriptions.Item>
              <Descriptions.Item label="年化收益率">{(merged_metrics.annualized_return * 100).toFixed(2)}%</Descriptions.Item>
              <Descriptions.Item label="日均收益">{(merged_metrics.mean_daily_return * 100).toFixed(4)}%</Descriptions.Item>
              <Descriptions.Item label="日收益标准差">{(merged_metrics.std_daily_return * 100).toFixed(4)}%</Descriptions.Item>
              <Descriptions.Item label="最大回撤">{(merged_metrics.max_drawdown * 100).toFixed(2)}%</Descriptions.Item>
              <Descriptions.Item label="Sharpe比率">{merged_metrics.sharpe_ratio?.toFixed(3) || '-'}</Descriptions.Item>
              <Descriptions.Item label="Sortino比率">{merged_metrics.sortino_ratio?.toFixed(3) || '-'}</Descriptions.Item>
              <Descriptions.Item label="Calmar比率">{merged_metrics.calmar_ratio?.toFixed(3) || '-'}</Descriptions.Item>
              <Descriptions.Item label="胜率">{(merged_metrics.win_rate * 100).toFixed(1)}%</Descriptions.Item>
              <Descriptions.Item label="盈亏比">{merged_metrics.profit_loss_ratio?.toFixed(3) || '-'}</Descriptions.Item>
              <Descriptions.Item label="最大单日盈利">{(merged_metrics.max_single_day_gain * 100).toFixed(2)}%</Descriptions.Item>
              <Descriptions.Item label="最大单日亏损">{(merged_metrics.max_single_day_loss * 100).toFixed(2)}%</Descriptions.Item>
              {ic_analysis?.available && (
                <>
                  <Descriptions.Item label="IC均值">{ic_analysis.mean_ic?.toFixed(4) || '-'}</Descriptions.Item>
                  <Descriptions.Item label="IC标准差">{ic_analysis.std_ic?.toFixed(4) || '-'}</Descriptions.Item>
                  <Descriptions.Item label="ICIR">{ic_analysis.icir?.toFixed(3) || '-'}</Descriptions.Item>
                  <Descriptions.Item label="IC胜率">{ic_analysis.hit_rate != null ? `${(ic_analysis.hit_rate * 100).toFixed(1)}%` : '-'}</Descriptions.Item>
                </>
              )}
            </Descriptions>
          </Card>
        </Col>

        <Col span={24}>
          <Card title="合并累计收益曲线" size="small">
            <ReactECharts
              option={{
                tooltip: {
                  trigger: 'axis',
                  backgroundColor: '#fff',
                  borderColor: '#e8e8e8',
                  textStyle: { color: '#374151' },
                  formatter: (params: any) => {
                    if (!params || !params.length) return ''
                    const date = params[0].name
                    const lines = params.map((item: any) => `${item.marker} ${item.seriesName}: ${((item.value - 1) * 100).toFixed(2)}%`)
                    return `${date}<br/>${lines.join('<br/>')}`
                  },
                },
                legend: {
                  data: ['策略（合并）', ...(merged_report.benchmark_cum_return ? ['基准'] : [])],
                  textStyle: { color: '#6b7280' },
                  top: 0,
                },
                grid: { left: 70, right: 30, top: 40, bottom: 60 },
                xAxis: {
                  type: 'category',
                  data: merged_report.dates,
                  axisLabel: { color: '#9ca3af', fontSize: 9 },
                  axisLine: { lineStyle: { color: '#e5e7eb' } },
                },
                yAxis: {
                  type: 'value',
                  axisLabel: {
                    color: '#9ca3af',
                    formatter: (value: number) => `${((value - 1) * 100).toFixed(0)}%`,
                  },
                  splitLine: { lineStyle: { color: '#f0f0f0' } },
                },
                series: [
                  {
                    name: '策略（合并）',
                    type: 'line',
                    data: merged_report.cumulative_return,
                    lineStyle: { width: 2 },
                    itemStyle: { color: '#1677ff' },
                    areaStyle: {
                      color: {
                        type: 'linear',
                        x: 0, y: 0, x2: 0, y2: 1,
                        colorStops: [
                          { offset: 0, color: 'rgba(22,119,255,0.15)' },
                          { offset: 1, color: 'rgba(22,119,255,0)' },
                        ],
                      },
                    },
                    markLine: {
                      data: (merged_report.run_boundaries || []).map((boundary: any, idx: number) => ({
                        xAxis: boundary.start_date,
                        name: `Run #${idx + 1}`,
                        lineStyle: { color: '#fa8c16', type: 'dashed', width: 1 },
                        label: { show: false },
                      })),
                      symbol: 'none',
                      silent: true,
                    },
                  },
                  ...(merged_report.benchmark_cum_return
                    ? [{
                        name: '基准',
                        type: 'line' as const,
                        data: merged_report.benchmark_cum_return,
                        lineStyle: { width: 1.5, type: 'dashed' as const },
                        itemStyle: { color: '#8c8c8c' },
                      }]
                    : []),
                ],
                dataZoom: [
                  { type: 'slider', start: 0, end: 100, height: 20, bottom: 5, borderColor: '#e5e7eb', fillerColor: 'rgba(22,119,255,0.1)', handleStyle: { color: '#1677ff' } },
                  { type: 'inside', start: 0, end: 100 },
                ],
              }}
              style={{ height: 350 }}
            />
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title="回撤分析" size="small">
            <ReactECharts
              option={{
                tooltip: {
                  trigger: 'axis',
                  backgroundColor: '#fff',
                  borderColor: '#e8e8e8',
                  textStyle: { color: '#374151' },
                  formatter: (params: any) => {
                    if (!params || !params.length) return ''
                    return `${params[0].name}<br/>回撤: ${(params[0].value * 100).toFixed(2)}%`
                  },
                },
                grid: { left: 60, right: 30, top: 20, bottom: 60 },
                xAxis: {
                  type: 'category',
                  data: merged_report.dates,
                  axisLabel: { color: '#9ca3af', fontSize: 9 },
                  axisLine: { lineStyle: { color: '#e5e7eb' } },
                },
                yAxis: {
                  type: 'value',
                  axisLabel: {
                    color: '#9ca3af',
                    formatter: (value: number) => `${(value * 100).toFixed(0)}%`,
                  },
                  splitLine: { lineStyle: { color: '#f0f0f0' } },
                },
                series: [{
                  name: '回撤',
                  type: 'line',
                  data: drawdown,
                  lineStyle: { width: 1.5, color: '#ff4d4f' },
                  areaStyle: { color: 'rgba(255,77,79,0.1)' },
                }],
                dataZoom: [
                  { type: 'slider', start: 0, end: 100, height: 20, bottom: 5 },
                  { type: 'inside', start: 0, end: 100 },
                ],
              }}
              style={{ height: 280 }}
            />
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title="换手率" size="small">
            <ReactECharts
              option={{
                tooltip: {
                  trigger: 'axis',
                  backgroundColor: '#fff',
                  borderColor: '#e8e8e8',
                  textStyle: { color: '#374151' },
                  formatter: (params: any) => {
                    if (!params || !params.length) return ''
                    return `${params[0].name}<br/>换手率: ${(params[0].value * 100).toFixed(2)}%`
                  },
                },
                grid: { left: 60, right: 30, top: 20, bottom: 60 },
                xAxis: {
                  type: 'category',
                  data: merged_report.dates,
                  axisLabel: { color: '#9ca3af', fontSize: 9 },
                  axisLine: { lineStyle: { color: '#e5e7eb' } },
                },
                yAxis: {
                  type: 'value',
                  axisLabel: {
                    color: '#9ca3af',
                    formatter: (value: number) => `${(value * 100).toFixed(0)}%`,
                  },
                  splitLine: { lineStyle: { color: '#f0f0f0' } },
                },
                series: [{
                  name: '换手率',
                  type: 'bar',
                  data: merged_report.turnover || [],
                  itemStyle: { color: '#722ed1' },
                  barWidth: '60%',
                }],
                dataZoom: [
                  { type: 'slider', start: 0, end: 100, height: 20, bottom: 5 },
                  { type: 'inside', start: 0, end: 100 },
                ],
              }}
              style={{ height: 280 }}
            />
          </Card>
        </Col>

        {ic_analysis?.available && (
          <>
            <Col xs={24} lg={12}>
              <Card title="IC 时序分析" size="small">
                <ReactECharts
                  option={{
                    tooltip: {
                      trigger: 'axis',
                      backgroundColor: '#fff',
                      borderColor: '#e8e8e8',
                      textStyle: { color: '#374151' },
                    },
                    grid: { left: 60, right: 30, top: 20, bottom: 60 },
                    xAxis: {
                      type: 'category',
                      data: ic_analysis.dates,
                      axisLabel: { color: '#9ca3af', fontSize: 9 },
                      axisLine: { lineStyle: { color: '#e5e7eb' } },
                    },
                    yAxis: {
                      type: 'value',
                      axisLabel: { color: '#9ca3af', formatter: '{value}' },
                      splitLine: { lineStyle: { color: '#f0f0f0' } },
                    },
                    series: [{
                      name: 'IC',
                      type: 'bar',
                      data: ic_analysis.ic_values,
                      itemStyle: (params: any) => ({
                        color: params.value >= 0 ? '#52c41a' : '#ff4d4f',
                      }),
                    }],
                    dataZoom: [
                      { type: 'slider', start: 0, end: 100, height: 20, bottom: 5 },
                      { type: 'inside', start: 0, end: 100 },
                    ],
                  }}
                  style={{ height: 280 }}
                />
              </Card>
            </Col>

            <Col xs={24} lg={12}>
              <Card title="IC 分布直方图" size="small">
                <ReactECharts
                  option={{
                    tooltip: {
                      trigger: 'axis',
                      backgroundColor: '#fff',
                      borderColor: '#e8e8e8',
                      textStyle: { color: '#374151' },
                    },
                    grid: { left: 60, right: 30, top: 20, bottom: 30 },
                    xAxis: { type: 'value', axisLabel: { color: '#9ca3af' } },
                    yAxis: { type: 'value', axisLabel: { color: '#9ca3af' } },
                    series: [{
                      name: '频次',
                      type: 'bar',
                      data: (() => {
                        const icValues = ic_analysis.ic_values.filter((v: number) => v != null && !isNaN(v))
                        if (icValues.length === 0) return []
                        const min = Math.floor(Math.min(...icValues) * 100) / 100
                        const max = Math.ceil(Math.max(...icValues) * 100) / 100
                        const binSize = Math.max(0.01, (max - min) / 30)
                        const bins: number[] = new Array(30).fill(0)
                        icValues.forEach((v: number) => {
                          const idx = Math.min(Math.floor((v - min) / binSize), 29)
                          bins[idx]++
                        })
                        return bins.map((count, i) => [min + i * binSize + binSize / 2, count])
                      })(),
                      barWidth: '90%',
                      itemStyle: { color: '#1677ff' },
                    }],
                  }}
                  style={{ height: 280 }}
                />
              </Card>
            </Col>
          </>
        )}

        {monthly_returns?.available && (
          <>
            <Col xs={24} lg={12}>
              <Card title="月度收益直方图" size="small">
                <ReactECharts
                  option={{
                    tooltip: {
                      trigger: 'axis',
                      backgroundColor: '#fff',
                      borderColor: '#e8e8e8',
                      textStyle: { color: '#374151' },
                      formatter: (params: any) => {
                        if (!params || !params.length) return ''
                        return `${params[0].name}<br/>收益: ${(params[0].value * 100).toFixed(2)}%`
                      },
                    },
                    grid: { left: 60, right: 30, top: 20, bottom: 60 },
                    xAxis: {
                      type: 'category',
                      data: monthly_returns.histogram?.labels || [],
                      axisLabel: { color: '#9ca3af', fontSize: 9, rotate: 45 },
                      axisLine: { lineStyle: { color: '#e5e7eb' } },
                    },
                    yAxis: {
                      type: 'value',
                      axisLabel: {
                        color: '#9ca3af',
                        formatter: (value: number) => `${(value * 100).toFixed(0)}%`,
                      },
                      splitLine: { lineStyle: { color: '#f0f0f0' } },
                    },
                    series: [{
                      name: '月度收益',
                      type: 'bar',
                      data: monthly_returns.histogram?.values || [],
                      itemStyle: (params: any) => ({
                        color: params.value >= 0 ? '#52c41a' : '#ff4d4f',
                      }),
                    }],
                  }}
                  style={{ height: 280 }}
                />
              </Card>
            </Col>

            <Col xs={24} lg={12}>
              <Card title="月度收益热力图" size="small">
                <ReactECharts
                  option={{
                    tooltip: {
                      position: 'top',
                      backgroundColor: '#fff',
                      borderColor: '#e8e8e8',
                      textStyle: { color: '#374151' },
                      formatter: (params: any) => {
                        const month = monthly_returns.months?.[params.data[0]] || params.data[0]
                        const year = monthly_returns.years?.[params.data[1]] || params.data[1]
                        const value = params.data[2]
                        return `${year}年${month}<br/>收益: ${(value * 100).toFixed(2)}%`
                      },
                    },
                    grid: { left: 50, right: 20, top: 10, bottom: 30 },
                    xAxis: {
                      type: 'category',
                      data: monthly_returns.months || [],
                      axisLabel: { color: '#6b7280', fontSize: 10 },
                      axisLine: { lineStyle: { color: '#e5e7eb' } },
                      splitArea: { show: false },
                    },
                    yAxis: {
                      type: 'category',
                      data: monthly_returns.years || [],
                      axisLabel: { color: '#6b7280', fontSize: 10 },
                      axisLine: { lineStyle: { color: '#e5e7eb' } },
                      splitArea: { show: false },
                    },
                    visualMap: {
                      show: false,
                      min: -0.2,
                      max: 0.2,
                      inRange: {
                        color: ['#ff4d4f', '#fff5f5', '#f6ffed', '#52c41a'],
                      },
                    },
                    series: [{
                      name: '月度收益',
                      type: 'heatmap',
                      data: (monthly_returns.heatmap_data || []).map((d: any) => [d[1], d[0], d[2]]),
                      label: {
                        show: true,
                        formatter: (params: any) => `${(params.data[2] * 100).toFixed(1)}%`,
                        fontSize: 9,
                        color: '#374151',
                      },
                      itemStyle: {
                        borderColor: '#fff',
                        borderWidth: 1,
                      },
                    }],
                  }}
                  style={{ height: 280 }}
                />
              </Card>
            </Col>
          </>
        )}

        {rolling_stats?.available && (
          <Col span={24}>
            <Card title={`滚动统计 (窗口=${rolling_stats.window}天)`} size="small">
              <ReactECharts
                option={{
                  tooltip: {
                    trigger: 'axis',
                    backgroundColor: '#fff',
                    borderColor: '#e8e8e8',
                    textStyle: { color: '#374151' },
                  },
                  legend: {
                    data: ['滚动收益', '滚动波动率', '滚动夏普'],
                    textStyle: { color: '#6b7280' },
                    top: 0,
                  },
                  grid: { left: 70, right: 30, top: 40, bottom: 60 },
                  xAxis: {
                    type: 'category',
                    data: rolling_stats.dates,
                    axisLabel: { color: '#9ca3af', fontSize: 9 },
                    axisLine: { lineStyle: { color: '#e5e7eb' } },
                  },
                  yAxis: [
                    {
                      type: 'value',
                      name: '收益/波动率',
                      axisLabel: { color: '#9ca3af', formatter: '{value}' },
                      splitLine: { lineStyle: { color: '#f0f0f0' } },
                    },
                    {
                      type: 'value',
                      name: '夏普比率',
                      axisLabel: { color: '#9ca3af' },
                      splitLine: { show: false },
                    },
                  ],
                  series: [
                    {
                      name: '滚动收益',
                      type: 'line',
                      data: rolling_stats.rolling_return,
                      lineStyle: { width: 1.5 },
                      itemStyle: { color: '#1677ff' },
                    },
                    {
                      name: '滚动波动率',
                      type: 'line',
                      data: rolling_stats.rolling_volatility,
                      lineStyle: { width: 1.5 },
                      itemStyle: { color: '#fa8c16' },
                    },
                    {
                      name: '滚动夏普',
                      type: 'line',
                      yAxisIndex: 1,
                      data: rolling_stats.rolling_sharpe,
                      lineStyle: { width: 1.5 },
                      itemStyle: { color: '#722ed1' },
                    },
                  ],
                  dataZoom: [
                    { type: 'slider', start: 0, end: 100, height: 20, bottom: 5 },
                    { type: 'inside', start: 0, end: 100 },
                  ],
                }}
                style={{ height: 300 }}
              />
            </Card>
          </Col>
        )}

        <Col xs={24} lg={12}>
          <Card title="日收益率分布" size="small">
            <ReactECharts
              option={{
                tooltip: {
                  trigger: 'axis',
                  backgroundColor: '#fff',
                  borderColor: '#e8e8e8',
                  textStyle: { color: '#374151' },
                },
                grid: { left: 60, right: 30, top: 20, bottom: 30 },
                xAxis: { type: 'value', axisLabel: { color: '#9ca3af', formatter: '{value}%' } },
                yAxis: { type: 'value', axisLabel: { color: '#9ca3af' } },
                series: [{
                  name: '频次',
                  type: 'bar',
                  data: (() => {
                    const dailyReturns = merged_report.daily_return || []
                    if (dailyReturns.length === 0) return []
                    const min = Math.floor(Math.min(...dailyReturns) * 100)
                    const max = Math.ceil(Math.max(...dailyReturns) * 100)
                    const binSize = Math.max(1, Math.ceil((max - min) / 30))
                    const bins: number[] = new Array(30).fill(0)
                    dailyReturns.forEach((r: number) => {
                      const idx = Math.min(Math.floor((r * 100 - min) / binSize), 29)
                      bins[idx]++
                    })
                    return bins.map((count, i) => [min + i * binSize + binSize / 2, count])
                  })(),
                  barWidth: '90%',
                  itemStyle: (params: any) => ({
                    color: params.data[0] >= 0 ? '#52c41a' : '#ff4d4f',
                  }),
                }],
              }}
              style={{ height: 280 }}
            />
          </Card>
        </Col>

        <Col span={24}>
          <Card title={`各子运行详情 (${individual_runs.length})`} size="small">
            <Table
              dataSource={individual_runs}
              pagination={false}
              size="small"
              columns={[
                {
                  title: '#',
                  dataIndex: 'rolling_index',
                  key: 'rolling_index',
                  width: 80,
                  render: (idx: number | null) => idx != null ? `#${idx + 1}` : '-',
                },
                {
                  title: 'Run ID',
                  dataIndex: 'run_id',
                  key: 'run_id',
                  ellipsis: true,
                  render: (rid: string) => <Text code>{rid}</Text>,
                },
                {
                  title: '时间段',
                  dataIndex: 'test_range',
                  key: 'test_range',
                  render: (range: string) => <Text style={{ fontSize: 12 }}>{range}</Text>,
                },
                {
                  title: '数据点数',
                  dataIndex: 'data_points',
                  key: 'data_points',
                  align: 'right',
                  render: (points: number) => <Text strong>{points}</Text>,
                },
              ]}
              rowKey="run_id"
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default TrainingDetailPage
