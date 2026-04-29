import React from 'react'
import { Outlet } from 'react-router-dom'
import { Layout } from 'antd'
import Header from './Header'

const { Content } = Layout

const AppLayout: React.FC = () => {
  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--ap-bg)' }}>
      <Header />
      <Content
        style={{
          padding: 'var(--ap-content-py) var(--ap-content-px)',
          maxWidth: 'var(--ap-content-max-w)',
          margin: '0 auto',
          width: '100%',
        }}
      >
        <Outlet />
      </Content>
    </Layout>
  )
}

export default AppLayout
