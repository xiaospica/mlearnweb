import React from 'react'
import { Outlet } from 'react-router-dom'

/**
 * Settings 子路由 wrapper：仅作 <Outlet /> 容器。
 * 子页导航由 AppLayout 的 Sidebar / MobileNavDrawer 提供
 * （详见 src/config/navigation.ts 中 settings.children 的 6 项），
 * 不在此处再嵌左侧菜单卡片，避免与 Sidebar 重复。
 */
const SettingsLayout: React.FC = () => {
  return <Outlet />
}

export default SettingsLayout
