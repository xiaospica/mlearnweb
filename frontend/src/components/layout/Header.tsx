import React from 'react'
import { Layout, Dropdown } from 'antd'
import { useNavigate, useLocation } from 'react-router-dom'
import { QuestionCircleOutlined, BookOutlined, DownOutlined } from '@ant-design/icons'
import type { MenuProps } from 'antd'

const { Header: AntHeader } = Layout

const Header: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()

  const isExperiments =
    location.pathname.startsWith('/experiments') || location.pathname.startsWith('/report')
  const isHelp = location.pathname.startsWith('/help')
  const isLiveTrading = location.pathname.startsWith('/live-trading')
  const isWorkbench = location.pathname.startsWith('/workbench')
  const isTrainingRecords = !isExperiments && !isHelp && !isLiveTrading && !isWorkbench

  const helpMenuItems: MenuProps['items'] = [
    {
      key: 'factor-docs',
      label: '因子文档',
      icon: <BookOutlined />,
      onClick: () => navigate('/help'),
    },
  ]

  const navItemStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--ap-brand-primary)' : 'var(--ap-text-muted)',
    background: active ? 'var(--ap-brand-soft)' : 'transparent',
    transition: 'all 0.2s',
    userSelect: 'none',
  })

  return (
    <AntHeader
      style={{
        background: 'var(--ap-panel)',
        borderBottom: '1px solid var(--ap-border)',
        padding: '0 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 56,
        position: 'sticky',
        top: 0,
        zIndex: 100,
        boxShadow: '0 1px 4px var(--ap-shadow)',
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
              background: 'var(--ap-brand-primary)',
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
              color: 'var(--ap-text)',
              fontFamily: "'Inter', sans-serif",
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            QMLearn
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            marginLeft: 20,
            borderLeft: '1px solid var(--ap-border)',
            paddingLeft: 16,
            gap: 4,
          }}
        >
          <div onClick={() => navigate('/')} style={navItemStyle(isTrainingRecords)}>
            训练记录
          </div>
          <div onClick={() => navigate('/workbench')} style={navItemStyle(isWorkbench)}>
            训练工作台
          </div>
          <div onClick={() => navigate('/experiments')} style={navItemStyle(isExperiments)}>
            实验浏览
          </div>
          <div onClick={() => navigate('/live-trading')} style={navItemStyle(isLiveTrading)}>
            实盘交易
          </div>
          <Dropdown menu={{ items: helpMenuItems }} trigger={['click']}>
            <div
              style={{
                ...navItemStyle(isHelp),
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
        <span style={{ fontSize: 11, color: 'var(--ap-text-dim)' }}>MLFlow Visualizer</span>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--ap-success)',
          }}
        />
      </div>
    </AntHeader>
  )
}

export default Header
