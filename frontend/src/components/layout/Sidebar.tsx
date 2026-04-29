/**
 * AlphaPilot 桌面常驻侧栏
 *
 * 仅在 ≥lg (≥992px) 渲染（由 AppLayout 控制），<lg 走 MobileNavDrawer。
 * 折叠态 (~56px) 走 AntD Menu inline + inlineCollapsed 内置 hover popover；
 * 展开态 (224px) 显示完整图标 + 文字，二级菜单内联展开。
 *
 * 状态：
 * - collapsed 由父组件 (AppLayout) 持有并持久化到 localStorage
 * - selectedKeys / openKeys 根据当前路由派生
 */

import { useEffect, useMemo, useState } from 'react'
import { Layout, Menu } from 'antd'
import type { MenuProps } from 'antd'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  PRIMARY_NAV,
  NAV_PATH_BY_KEY,
  findActiveLeafKey,
  findParentKeyOf,
  type NavItem,
} from '@/config/navigation'
import { BRAND_NAME } from '@/config/brand'
import Logo from '@/components/brand/Logo'

const { Sider } = Layout

interface SidebarProps {
  collapsed: boolean
}

const buildMenuItems = (items: NavItem[]): MenuProps['items'] =>
  items.map((item) => {
    const Icon = item.icon
    if (item.children?.length) {
      return {
        key: item.key,
        icon: Icon ? <Icon /> : undefined,
        label: item.label,
        children: buildMenuItems(item.children),
      }
    }
    return {
      key: item.key,
      icon: Icon ? <Icon /> : undefined,
      label: item.label,
    }
  })

const Sidebar = ({ collapsed }: SidebarProps) => {
  const navigate = useNavigate()
  const location = useLocation()

  const activeLeafKey = useMemo(() => findActiveLeafKey(location.pathname), [location.pathname])
  const activeParentKey = useMemo(
    () => (activeLeafKey ? findParentKeyOf(activeLeafKey) : null),
    [activeLeafKey],
  )

  // openKeys 用受控模式：路由变化时同步打开父组（含当前激活叶子的那组）
  const [openKeys, setOpenKeys] = useState<string[]>(activeParentKey ? [activeParentKey] : [])
  useEffect(() => {
    if (activeParentKey && !openKeys.includes(activeParentKey)) {
      setOpenKeys((prev) => Array.from(new Set([...prev, activeParentKey])))
    }
    // 不主动收起其它组，让用户自由展开多组
  }, [activeParentKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const menuItems = useMemo(() => buildMenuItems(PRIMARY_NAV), [])

  const handleClick: MenuProps['onClick'] = ({ key }) => {
    const path = NAV_PATH_BY_KEY[key]
    if (path) navigate(path)
  }

  return (
    <Sider
      width={224}
      collapsedWidth={56}
      collapsible
      collapsed={collapsed}
      trigger={null}
      className="ap-sidebar"
      style={{
        background: 'var(--ap-panel)',
        borderRight: '1px solid var(--ap-border)',
        height: '100vh',
        position: 'sticky',
        top: 0,
        left: 0,
        overflow: 'auto',
        zIndex: 'var(--ap-z-sidebar)' as unknown as number,
      }}
    >
      {/* Logo 区域 */}
      <div
        className="ap-sidebar-logo"
        onClick={() => navigate('/')}
        aria-label={`${BRAND_NAME} home`}
        style={{
          height: 56,
          padding: collapsed ? '12px 12px' : '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          borderBottom: '1px solid var(--ap-border-muted)',
        }}
      >
        <Logo
          variant={collapsed ? 'mark' : 'full'}
          height={collapsed ? 28 : 26}
          style={{ color: 'var(--ap-brand-primary)' }}
        />
      </div>

      {/* 导航 Menu */}
      <Menu
        mode="inline"
        theme="dark"
        inlineCollapsed={collapsed}
        items={menuItems}
        selectedKeys={activeLeafKey ? [activeLeafKey] : []}
        openKeys={collapsed ? [] : openKeys}
        onOpenChange={(keys) => setOpenKeys(keys as string[])}
        onClick={handleClick}
        style={{
          background: 'transparent',
          borderInlineEnd: 'none',
          padding: '8px 0',
        }}
      />
    </Sider>
  )
}

export default Sidebar
