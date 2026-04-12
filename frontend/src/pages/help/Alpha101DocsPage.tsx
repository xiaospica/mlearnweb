import React, { useState } from 'react'
import { Card, Typography, Table, Tag, Input, Space, Spin, Empty, Alert } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { factorDocService } from '@/services/factorDocService'

const { Title, Text } = Typography

const Alpha101DocsPage: React.FC = () => {
  const [searchText, setSearchText] = useState('')
  const [activeCategory, setActiveCategory] = useState('all')

  const { data, isLoading, error } = useQuery({
    queryKey: ['alpha101-docs'],
    queryFn: () => factorDocService.getAlpha101Docs(),
    staleTime: 30 * 60 * 1000,
  })

  const factors = data?.data?.factors || []
  const baseFunctions = data?.data?.base_functions || []

  const categories = [...new Set(factors.map(f => f.category))].filter(Boolean)

  const filteredFactors = factors.filter(factor => {
    const matchSearch = !searchText || 
      factor.name.toLowerCase().includes(searchText.toLowerCase()) ||
      factor.expression.toLowerCase().includes(searchText.toLowerCase()) ||
      factor.description.toLowerCase().includes(searchText.toLowerCase())
    const matchCategory = activeCategory === 'all' || factor.category === activeCategory
    return matchSearch && matchCategory
  })

  const columns = [
    {
      title: '因子名称',
      dataIndex: 'name',
      key: 'name',
      width: 100,
      render: (name: string) => <Text code strong>{name.toUpperCase()}</Text>,
    },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 80,
      render: (category: string) => <Tag color="green">{category}</Tag>,
    },
    {
      title: '表达式',
      dataIndex: 'expression',
      key: 'expression',
      width: 400,
      render: (expr: string) => (
        <Text code style={{ fontSize: 11, wordBreak: 'break-all' }}>
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
      width: 250,
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
      <Title level={4}>Alpha101 因子文档</Title>
      <Alert 
        message="WorldQuant 101因子" 
        description="Alpha101 是 WorldQuant 公开的101个量化因子，涵盖了动量、反转、量价等多种策略逻辑。这些因子基于高频数据构建，适用于日内交易策略。"
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Card>
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

        {categories.length > 0 && (
          <Space style={{ marginBottom: 16 }}>
            <Tag 
              color={activeCategory === 'all' ? 'green' : 'default'}
              style={{ cursor: 'pointer' }}
              onClick={() => setActiveCategory('all')}
            >
              全部
            </Tag>
            {categories.map(cat => (
              <Tag 
                key={cat}
                color={activeCategory === cat ? 'green' : 'default'}
                style={{ cursor: 'pointer' }}
                onClick={() => setActiveCategory(cat)}
              >
                {cat} ({factors.filter(f => f.category === cat).length})
              </Tag>
            ))}
          </Space>
        )}

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
          Alpha101 因子使用以下基础函数构建，这些函数用于处理时间序列数据和计算统计指标。
        </Text>
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>
        ) : (
          <Table
            dataSource={baseFunctions}
            columns={baseFunctionColumns}
            rowKey="name"
            pagination={false}
            size="small"
            scroll={{ x: 700 }}
          />
        )}
      </Card>
    </div>
  )
}

export default Alpha101DocsPage
