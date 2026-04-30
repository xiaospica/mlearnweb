import React, { useState } from 'react'
import { Card, Typography, Tag, Input, Space, Empty, Alert } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { factorDocService } from '@/services/factorDocService'
import PageContainer from '@/components/layout/PageContainer'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'

const { Text } = Typography

interface Alpha191Factor {
  name: string
  category: string
  expression: string
  description: string
}

interface BaseFunction {
  name: string
  syntax: string
  description: string
}

const Alpha191DocsPage: React.FC = () => {
  const [searchText, setSearchText] = useState('')
  const [activeCategory, setActiveCategory] = useState('all')

  const { data, isLoading, error } = useQuery({
    queryKey: ['alpha191-docs'],
    queryFn: () => factorDocService.getAlpha191Docs(),
    staleTime: 30 * 60 * 1000,
  })

  const factors = data?.data?.factors || []
  const baseFunctions = data?.data?.base_functions || []

  const categories = [...new Set(factors.map((f) => f.category))].filter(Boolean)

  const filteredFactors = factors.filter((factor) => {
    const matchSearch =
      !searchText ||
      factor.name.toLowerCase().includes(searchText.toLowerCase()) ||
      factor.expression.toLowerCase().includes(searchText.toLowerCase()) ||
      factor.description.toLowerCase().includes(searchText.toLowerCase())
    const matchCategory = activeCategory === 'all' || factor.category === activeCategory
    return matchSearch && matchCategory
  })

  const columns: ResponsiveColumn<Alpha191Factor>[] = [
    {
      title: '因子名称',
      dataIndex: 'name',
      key: 'name',
      width: 100,
      mobileRole: 'title',
      render: (name: string) => <Text code strong>{name.toUpperCase()}</Text>,
    },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 80,
      mobileRole: 'badge',
      render: (category: string) => <Tag color="purple">{category}</Tag>,
    },
    {
      title: '表达式',
      dataIndex: 'expression',
      key: 'expression',
      width: 400,
      mobileRole: 'subtitle',
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
      mobileRole: 'hidden',
      render: (desc: string) => <Text style={{ fontSize: 12 }}>{desc}</Text>,
    },
  ]

  const baseFunctionColumns: ResponsiveColumn<BaseFunction>[] = [
    {
      title: '函数名',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      mobileRole: 'title',
      render: (name: string) => <Text code strong>{name}</Text>,
    },
    {
      title: '语法',
      dataIndex: 'syntax',
      key: 'syntax',
      width: 250,
      mobileRole: 'subtitle',
      render: (syntax: string) => (
        <Text code style={{ fontSize: 12 }}>
          {syntax}
        </Text>
      ),
    },
    {
      title: '说明',
      dataIndex: 'description',
      key: 'description',
      mobileRole: 'hidden',
      render: (desc: string) => <Text style={{ fontSize: 12 }}>{desc}</Text>,
    },
  ]

  return (
    <PageContainer
      title="Alpha191 因子文档"
      subtitle={`国泰君安公开 191 个量化因子 · 共 ${factors.length} 个，当前显示 ${filteredFactors.length} 个`}
      actions={
        <Input
          placeholder="搜索因子名称、表达式或说明..."
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{ width: 280 }}
          allowClear
        />
      }
    >
      <Alert
        message="国泰君安191因子"
        description="Alpha191 是国泰君安证券公开的191个量化因子，涵盖了动量、反转、流动性、波动性等多种策略逻辑。这些因子基于日频数据构建，适用于中低频交易策略。"
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Card>
        {categories.length > 0 && (
          <Space style={{ marginBottom: 16 }} wrap>
            <Tag
              color={activeCategory === 'all' ? 'purple' : 'default'}
              style={{ cursor: 'pointer' }}
              onClick={() => setActiveCategory('all')}
            >
              全部
            </Tag>
            {categories.map((cat) => (
              <Tag
                key={cat}
                color={activeCategory === cat ? 'purple' : 'default'}
                style={{ cursor: 'pointer' }}
                onClick={() => setActiveCategory(cat)}
              >
                {cat} ({factors.filter((f) => f.category === cat).length})
              </Tag>
            ))}
          </Space>
        )}

        {error ? (
          <Empty description="加载因子文档失败" />
        ) : (
          <ResponsiveTable<Alpha191Factor>
            dataSource={filteredFactors}
            columns={columns}
            rowKey="name"
            loading={isLoading}
            pagination={{ pageSize: 20, showSizeChanger: true, showQuickJumper: true }}
            size="small"
            scrollX={900}
          />
        )}
      </Card>

      <Card style={{ marginTop: 16 }} title="基础函数说明">
        <Text type="secondary" style={{ marginBottom: 16, display: 'block' }}>
          Alpha191 因子使用以下基础函数构建，这些函数用于处理时间序列数据和计算统计指标。
        </Text>
        <ResponsiveTable<BaseFunction>
          dataSource={baseFunctions}
          columns={baseFunctionColumns}
          rowKey="name"
          loading={isLoading}
          pagination={false}
          size="small"
          scrollX={700}
        />
      </Card>
    </PageContainer>
  )
}

export default Alpha191DocsPage
