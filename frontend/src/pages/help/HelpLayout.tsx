import React from 'react'
import { Outlet } from 'react-router-dom'

/**
 * Help 子路由 wrapper：仅作 <Outlet /> 容器。
 * 子页导航已由 AppLayout 的 Sidebar / MobileNavDrawer 提供（详见
 * src/config/navigation.ts 中 help.children 的 4 项），不再需要内嵌
 * 左侧菜单卡片，避免与 Sidebar 重复。
 */
const HelpLayout: React.FC = () => {
  return <Outlet />
}

export default HelpLayout
