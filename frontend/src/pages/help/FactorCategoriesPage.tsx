import React from 'react'
import { Card, Typography, Tag } from 'antd'
import PageContainer from '@/components/layout/PageContainer'
import ResponsiveTable, { type ResponsiveColumn } from '@/components/responsive/ResponsiveTable'

const { Text, Paragraph } = Typography

interface FactorCategory {
  name: string
  description: string
}

const FACTOR_CATEGORIES: FactorCategory[] = [
  {
    name: 'K线形态',
    description: '基于K线开盘价、收盘价、最高价、最低价计算的形态因子，反映价格走势特征',
  },
  {
    name: '价格',
    description: '基于价格数据计算的因子，包括收益率、价格位置等',
  },
  {
    name: '动量',
    description: '反映价格变动趋势和持续性的因子，用于捕捉趋势行情',
  },
  {
    name: '趋势',
    description: '判断价格趋势方向和强度的因子，用于识别市场走势',
  },
  {
    name: '波动',
    description: '衡量价格波动幅度和稳定性的因子，反映市场风险水平',
  },
  {
    name: '位置',
    description: '描述价格在历史区间中相对位置的因子，用于判断超买超卖',
  },
  {
    name: '时间',
    description: '基于时间序列特征计算的因子，包括周期性、季节性等',
  },
  {
    name: '量价',
    description: '结合成交量和价格关系计算的因子，反映市场参与度',
  },
  {
    name: '统计',
    description: '基于统计方法计算的因子，包括相关性、回归系数等',
  },
  {
    name: '成交量',
    description: '基于成交量数据计算的因子，反映市场活跃度和流动性',
  },
  {
    name: '反转',
    description: '捕捉价格反转信号的因子，用于逆势交易策略',
  },
  {
    name: '流动性',
    description: '衡量市场流动性和交易成本的因子',
  },
  {
    name: '其他',
    description: '其他类型的因子',
  },
]

const columns: ResponsiveColumn<FactorCategory>[] = [
  {
    title: '分类名称',
    dataIndex: 'name',
    key: 'name',
    width: 120,
    mobileRole: 'title',
    render: (name: string) => <Tag color="blue">{name}</Tag>,
  },
  {
    title: '说明',
    dataIndex: 'description',
    key: 'description',
    mobileRole: 'subtitle',
    render: (desc: string) => <Text>{desc}</Text>,
  },
]

const FactorCategoriesPage: React.FC = () => {
  return (
    <PageContainer
      title="因子分类说明"
      subtitle="量化因子的常用分类标准，适用于 Alpha158 / Alpha101 / Alpha191 等各类因子库"
    >
      <Card>
        <Paragraph>
          因子分类是量化投资中组织和理解因子的重要方式。以下是常用的因子分类标准，
          适用于 Alpha158、Alpha101、Alpha191 等各类因子库。
        </Paragraph>
        <ResponsiveTable<FactorCategory>
          dataSource={FACTOR_CATEGORIES}
          columns={columns}
          rowKey="name"
          pagination={false}
          size="small"
        />
      </Card>
    </PageContainer>
  )
}

export default FactorCategoriesPage
