import React from 'react'
import { Layout, Dropdown } from 'antd'
import { useNavigate, useLocation } from 'react-router-dom'
import { DownOutlined } from '@ant-design/icons'
import type { MenuProps } from 'antd'
import { BRAND_NAME } from '@/config/brand'
import { PRIMARY_NAV, findActiveNavKey, type NavItem } from '@/config/navigation'
import Logo from '@/components/brand/Logo'

const { Header: AntHeader } = Layout

const Header: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const activeKey = findActiveNavKey(location.pathname)

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
    gap: 4,
  })

  const buildDropdownItems = (children: NavItem[]): MenuProps['items'] =>
    children.map((c) => ({
      key: c.key,
      label: c.label,
      icon: c.icon ? <c.icon /> : undefined,
      onClick: () => navigate(c.path),
    }))

  const renderNavItem = (item: NavItem) => {
    const active = activeKey === item.key

    if (item.children && item.children.length > 0) {
      return (
        <Dropdown key={item.key} menu={{ items: buildDropdownItems(item.children) }} trigger={['click']}>
          <div style={navItemStyle(active)}>
            {item.icon && <item.icon style={{ fontSize: 12 }} />}
            {item.label}
            <DownOutlined style={{ fontSize: 10 }} />
          </div>
        </Dropdown>
      )
    }

    return (
      <div key={item.key} onClick={() => navigate(item.path)} style={navItemStyle(active)}>
        {item.label}
      </div>
    )
  }

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
          {PRIMARY_NAV.map(renderNavItem)}
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
