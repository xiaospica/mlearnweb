/**
 * AlphaPilot 应用外壳
 *
 * 断点策略：
 * - ≥lg (≥992px)：常驻 Sidebar（用户可折叠到 56px 图标态）+ TopBar
 * - <lg：Sidebar 隐藏，hamburger 打开 MobileNavDrawer + TopBar
 *
 * 持久化：
 * - sidebarCollapsed 写 localStorage（key: alphapilot.sidebar.collapsed）
 *
 * 内容区 padding / maxWidth 由 CSS 变量驱动（global.css 媒体查询阶梯），
 * 不在此处 re-render。
 */

import { useCallback, useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Layout } from 'antd'
import Sidebar from './Sidebar'
import MobileNavDrawer from './MobileNavDrawer'
import TopBar from './TopBar'
import { useIsCompact } from '@/hooks/useBreakpoint'

const { Content } = Layout

const SIDEBAR_COLLAPSED_KEY = 'alphapilot.sidebar.collapsed'

const readCollapsedPref = (): boolean => {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

const writeCollapsedPref = (v: boolean): void => {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

const AppLayout = () => {
  const isCompact = useIsCompact()
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readCollapsedPref)
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false)

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      writeCollapsedPref(next)
      return next
    })
  }, [])

  const openMobileNav = useCallback(() => setMobileNavOpen(true), [])
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), [])

  // 视口跨越断点时关闭可能残留的 Drawer
  useEffect(() => {
    if (!isCompact && mobileNavOpen) setMobileNavOpen(false)
  }, [isCompact, mobileNavOpen])

  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--ap-bg)' }}>
      {!isCompact && <Sidebar collapsed={sidebarCollapsed} />}

      <Layout style={{ background: 'var(--ap-bg)' }}>
        <TopBar
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onOpenMobileNav={openMobileNav}
        />
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

      {isCompact && <MobileNavDrawer open={mobileNavOpen} onClose={closeMobileNav} />}
    </Layout>
  )
}

export default AppLayout
