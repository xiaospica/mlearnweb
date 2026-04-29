import React from 'react'
import { Layout, Dropdown } from 'antd'
import { useNavigate, useLocation } from 'react-router-dom'
import { QuestionCircleOutlined, BookOutlined, DownOutlined } from '@ant-design/icons'
import type { MenuProps } from 'antd'
import { BRAND_NAME } from '@/config/brand'
import Logo from '@/components/brand/Logo'

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
    position: 'relative',
    padding: '0 14px',
    height: 56, // 与 Header 同高，让下划线贴 Header 底缘
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--ap-text)' : 'var(--ap-text-muted)',
    background: 'transparent',
    boxShadow: active ? 'inset 0 -2px 0 0 var(--ap-brand-primary)' : 'none',
    transition: 'color 0.2s, box-shadow 0.2s',
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
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          onClick={() => navigate('/')}
          aria-label={`${BRAND_NAME} home`}
        >
          {/* currentColor 同时染 brand mark 与字标。
              在暗色下 brand-primary (#3B82F6) + 字标取 ap-text 显得割裂，
              这里整体用 brand-primary 让 logo 一体感更强（字标也是蓝） */}
          <Logo variant="full" height={28} style={{ color: 'var(--ap-brand-primary)' }} />
        </div>

        <div
          style={{
            display: 'flex',
            marginLeft: 24,
            gap: 4,
            height: 56,
            alignItems: 'center',
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
