import React from 'react'
import { Layout, Dropdown } from 'antd'
import { useNavigate, useLocation } from 'react-router-dom'
import { QuestionCircleOutlined, BookOutlined, DownOutlined } from '@ant-design/icons'
import type { MenuProps } from 'antd'

const { Header: AntHeader } = Layout

const Header: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()

  const isExperiments = location.pathname.startsWith('/experiments') || location.pathname.startsWith('/report')
  const isHelp = location.pathname.startsWith('/help')
  const isLiveTrading = location.pathname.startsWith('/live-trading')
  const isTrainingRecords = !isExperiments && !isHelp && !isLiveTrading

  const helpMenuItems: MenuProps['items'] = [
    {
      key: 'factor-docs',
      label: '因子文档',
      icon: <BookOutlined />,
      onClick: () => navigate('/help'),
    },
  ]

  return (
    <AntHeader
      style={{
        background: '#ffffff',
        borderBottom: '1px solid #e8e8e8',
        padding: '0 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 56,
        position: 'sticky',
        top: 0,
        zIndex: 100,
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}
          onClick={() => navigate('/')}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              background: '#1677ff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
            }}
          >
            Q
          </div>
          <span
            style={{
              color: '#1f2937',
              fontFamily: "'Inter', sans-serif",
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            QMLearn
          </span>
        </div>

        <div style={{
          display: 'flex',
          marginLeft: 20,
          borderLeft: '1px solid #e8e8e8',
          paddingLeft: 16,
          gap: 4,
        }}>
          <div
            onClick={() => navigate('/')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: isTrainingRecords ? 600 : 400,
              color: isTrainingRecords ? '#1677ff' : '#6b7280',
              background: isTrainingRecords ? '#e8f4fd' : 'transparent',
              transition: 'all 0.2s',
              userSelect: 'none',
            }}
          >
            训练记录
          </div>
          <div
            onClick={() => navigate('/experiments')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: isExperiments ? 600 : 400,
              color: isExperiments ? '#1677ff' : '#6b7280',
              background: isExperiments ? '#e8f4fd' : 'transparent',
              transition: 'all 0.2s',
              userSelect: 'none',
            }}
          >
            实验浏览
          </div>
          <div
            onClick={() => navigate('/live-trading')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: isLiveTrading ? 600 : 400,
              color: isLiveTrading ? '#1677ff' : '#6b7280',
              background: isLiveTrading ? '#e8f4fd' : 'transparent',
              transition: 'all 0.2s',
              userSelect: 'none',
            }}
          >
            实盘交易
          </div>
          <Dropdown menu={{ items: helpMenuItems }} trigger={['click']}>
            <div
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: isHelp ? 600 : 400,
                color: isHelp ? '#1677ff' : '#6b7280',
                background: isHelp ? '#e8f4fd' : 'transparent',
                transition: 'all 0.2s',
                userSelect: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <QuestionCircleOutlined style={{ fontSize: 12 }} />
              帮助
              <DownOutlined style={{ fontSize: 10 }} />
            </div>
          </Dropdown>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>
          MLFlow Visualizer
        </span>
        <div style={{
          width: 8, height: 8, borderRadius: '50%', background: '#52c41a',
        }} />
      </div>
    </AntHeader>
  )
}

export default Header
