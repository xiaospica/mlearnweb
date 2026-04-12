import React, { useState } from 'react'
import { Card, Typography, Table, Tag, Input, Space, Tabs, Spin, Empty, Alert } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { factorDocService } from '@/services/factorDocService'
import type { BaseFunction } from '@/services/factorDocService'

const { Title, Text } = Typography

const Alpha158DocsPage: React.FC = () => {
  const [searchText, setSearchText] = useState('')
  const [activeCategory, setActiveCategory] = useState('all')

  const { data, isLoading, error } = useQuery({
    queryKey: ['alpha158-docs'],
    queryFn: () => factorDocService.getAlpha158Docs(),
    staleTime: 30 * 60 * 1000,
  })

  const factors = data?.data?.factors || []
  const categories = data?.data?.categories || {}
  const baseFunctions = data?.data?.base_functions || []

  const filteredFactors = factors.filter(factor => {
    const matchSearch = !searchText || 
      factor.name.toLowerCase().includes(searchText.toLowerCase()) ||
      factor.expression.toLowerCase().includes(searchText.toLowerCase()) ||
      factor.description.toLowerCase().includes(searchText.toLowerCase())
    const matchCategory = activeCategory === 'all' || factor.category === activeCategory
    return matchSearch && matchCategory
  })

  const categoryList = Object.keys(categories)

  const columns = [
    {
      title: '因子名称',
      dataIndex: 'name',
      key: 'name',
      width: 120,
      render: (name: string) => <Text code strong>{name}</Text>,
    },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 100,
      render: (category: string) => <Tag color="blue">{category}</Tag>,
    },
    {
      title: '表达式',
      dataIndex: 'expression',
      key: 'expression',
      width: 300,
      render: (expr: string) => (
        <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {expr}
        </Text>
      ),
    },
    {
      title: '说明',
      dataIndex: 'description',
      key: 'description',
      render: (desc: string) => <Text style={{ fontSize: 12 }}>{desc}</Text>,
    },
  ]

  const baseFunctionColumns = [
    {
      title: '函数名',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (name: string) => <Text code strong>{name}</Text>,
    },
    {
      title: '语法',
      dataIndex: 'syntax',
      key: 'syntax',
      width: 200,
      render: (syntax: string) => (
        <Text code style={{ fontSize: 12 }}>{syntax}</Text>
      ),
    },
    {
      title: '说明',
      dataIndex: 'description',
      key: 'description',
      render: (desc: string) => <Text style={{ fontSize: 12 }}>{desc}</Text>,
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Title level={4}>Alpha158 因子文档</Title>
      <Alert 
        message="QLib Alpha158 因子库" 
        description="Alpha158 是 QLib 内置的158个量化因子，包含 K线形态、价格、动量、趋势、波动、位置、时间、量价、统计、成交量等类别。这些因子经过优化，适用于日频交易策略。"
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Card style={{ marginTop: 16 }}>
        <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
          <Input
            placeholder="搜索因子名称、表达式或说明..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            style={{ width: 300 }}
            allowClear
          />
          <Text type="secondary">
            共 {factors.length} 个因子，当前显示 {filteredFactors.length} 个
          </Text>
        </Space>

        <Tabs
          activeKey={activeCategory}
          onChange={setActiveCategory}
          items={[
            { key: 'all', label: '全部' },
            ...categoryList.map(cat => ({
              key: cat,
              label: (
                <span>
                  {cat}
                  <Text type="secondary" style={{ marginLeft: 4, fontSize: 11 }}>
                    ({factors.filter(f => f.category === cat).length})
                  </Text>
                </span>
              ),
            })),
          ]}
        />

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : error ? (
          <Empty description="加载因子文档失败" />
        ) : (
          <Table
            dataSource={filteredFactors}
            columns={columns}
            rowKey="name"
            pagination={{ pageSize: 20, showSizeChanger: true, showQuickJumper: true }}
            size="small"
            scroll={{ x: 900 }}
          />
        )}
      </Card>

      <Card style={{ marginTop: 16 }} title="基础函数说明">
        <Text type="secondary" style={{ marginBottom: 16, display: 'block' }}>
          Alpha158 因子使用以下基础函数构建，这些函数是 QLib 表达式引擎的核心组成部分。
        </Text>
        <Table
          dataSource={baseFunctions}
          columns={baseFunctionColumns}
          rowKey="name"
          pagination={false}
          size="small"
          scroll={{ x: 700 }}
        />
      </Card>
    </div>
  )
}

export default Alpha158DocsPage
