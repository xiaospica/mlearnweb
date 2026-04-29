/**
 * AlphaPilot 移动端导航 Drawer
 *
 * <lg (<992px) 时取代 Sidebar；由 TopBar 的 hamburger 触发。
 * 复用同一份 PRIMARY_NAV 配置 + 同样的 Menu 内联展开模式。
 *
 * 行为：用户点叶子节点导航后自动 onClose；若点的是有 children 的父节点，
 * 仅展开/收起，不关闭 Drawer。
 */

import { useEffect, useMemo, useState } from 'react'
import { Drawer, Menu } from 'antd'
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

interface MobileNavDrawerProps {
  open: boolean
  onClose: () => void
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

const MobileNavDrawer = ({ open, onClose }: MobileNavDrawerProps) => {
  const navigate = useNavigate()
  const location = useLocation()

  const activeLeafKey = useMemo(() => findActiveLeafKey(location.pathname), [location.pathname])
  const activeParentKey = useMemo(
    () => (activeLeafKey ? findParentKeyOf(activeLeafKey) : null),
    [activeLeafKey],
  )

  const [openKeys, setOpenKeys] = useState<string[]>(activeParentKey ? [activeParentKey] : [])
  useEffect(() => {
    if (activeParentKey && !openKeys.includes(activeParentKey)) {
      setOpenKeys((prev) => Array.from(new Set([...prev, activeParentKey])))
    }
  }, [activeParentKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // 路由切换后关闭 Drawer（用户从 Drawer 内点了叶子导航）
  useEffect(() => {
    if (open) onClose()
    // 仅在 pathname 变化时触发，open / onClose 不进依赖
  }, [location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  const menuItems = useMemo(() => buildMenuItems(PRIMARY_NAV), [])

  const handleClick: MenuProps['onClick'] = ({ key }) => {
    const path = NAV_PATH_BY_KEY[key]
    if (path) navigate(path)
  }

  return (
    <Drawer
      placement="left"
      width={280}
      open={open}
      onClose={onClose}
      closable={false}
      styles={{
        body: { padding: 0, background: 'var(--ap-panel)' },
        header: { display: 'none' },
        content: { background: 'var(--ap-panel)' },
      }}
      className="ap-sidebar"
    >
      <div
        className="ap-sidebar-logo"
        onClick={() => {
          navigate('/')
          onClose()
        }}
        aria-label={`${BRAND_NAME} home`}
        style={{
          height: 56,
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid var(--ap-border-muted)',
        }}
      >
        <Logo variant="full" height={26} style={{ color: 'var(--ap-brand-primary)' }} />
      </div>

      <Menu
        mode="inline"
        theme="dark"
        items={menuItems}
        selectedKeys={activeLeafKey ? [activeLeafKey] : []}
        openKeys={openKeys}
        onOpenChange={(keys) => setOpenKeys(keys as string[])}
        onClick={handleClick}
        style={{
          background: 'transparent',
          borderInlineEnd: 'none',
          padding: '8px 0',
        }}
      />
    </Drawer>
  )
}

export default MobileNavDrawer
