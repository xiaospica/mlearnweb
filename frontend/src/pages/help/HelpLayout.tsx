import React from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Card, Menu } from 'antd'
import { BookOutlined, FileTextOutlined, DatabaseOutlined, AppstoreOutlined } from '@ant-design/icons'

const HelpLayout: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()

  const selectedKey = location.pathname.split('/').pop() || 'categories'

  const menuItems = [
    {
      key: 'categories',
      icon: <AppstoreOutlined />,
      label: '因子分类说明',
    },
    {
      key: 'alpha158',
      icon: <DatabaseOutlined />,
      label: 'Alpha158 因子',
    },
    {
      key: 'alpha101',
      icon: <FileTextOutlined />,
      label: 'Alpha101 因子',
    },
    {
      key: 'alpha191',
      icon: <BookOutlined />,
      label: 'Alpha191 因子',
    },
  ]

  return (
    <div style={{ display: 'flex', gap: 16, padding: 24, minHeight: 'calc(100vh - 56px)' }}>
      <Card style={{ width: 200, height: 'fit-content' }}>
        <Menu
          mode="vertical"
          selectedKeys={[selectedKey]}
          onClick={({ key }) => navigate(`/help/${key}`)}
          items={menuItems}
          style={{ border: 'none' }}
        />
      </Card>
      <div style={{ flex: 1 }}>
        <Outlet />
      </div>
    </div>
  )
}

export default HelpLayout
