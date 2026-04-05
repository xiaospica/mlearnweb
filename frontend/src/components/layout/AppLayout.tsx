import React from 'react'
import { Outlet } from 'react-router-dom'
import { Layout } from 'antd'
import Header from './Header'

const { Content } = Layout

const AppLayout: React.FC = () => {
  return (
    <Layout style={{ minHeight: '100vh', background: '#f5f7fa' }}>
      <Header />
      <Content style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
        <Outlet />
      </Content>
    </Layout>
  )
}

export default AppLayout
