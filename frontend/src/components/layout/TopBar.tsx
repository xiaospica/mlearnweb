/**
 * AlphaPilot 顶部栏
 *
 * 桌面端：左侧 sidebar 折叠按钮 + 右侧主题切换 / 系统状态指示
 * 移动端：左侧 hamburger（打开 MobileNavDrawer） + 右侧主题切换 / 状态
 *
 * 中央 toast 槽留给 F5 的 message 全局配置（实盘连接、运维口令等）。
 */

import { Layout, Button, Tooltip } from 'antd'
import {
  MenuOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SunOutlined,
  MoonOutlined,
} from '@ant-design/icons'
import { useTheme } from '@/hooks/useTheme'
import { useIsCompact } from '@/hooks/useBreakpoint'

const { Header: AntHeader } = Layout

interface TopBarProps {
  /** Sidebar 折叠状态（桌面） */
  sidebarCollapsed: boolean
  /** 切换 Sidebar 折叠状态（桌面） */
  onToggleSidebar: () => void
  /** 打开移动端 Drawer */
  onOpenMobileNav: () => void
}

const TopBar = ({ sidebarCollapsed, onToggleSidebar, onOpenMobileNav }: TopBarProps) => {
  const { isDark, toggle } = useTheme()
  const isCompact = useIsCompact() // <lg 视为移动/小屏

  const leftIcon = isCompact ? (
    <MenuOutlined />
  ) : sidebarCollapsed ? (
    <MenuUnfoldOutlined />
  ) : (
    <MenuFoldOutlined />
  )

  const handleLeftClick = () => {
    if (isCompact) onOpenMobileNav()
    else onToggleSidebar()
  }

  return (
    <AntHeader
      style={{
        background: 'var(--ap-panel)',
        borderBottom: '1px solid var(--ap-border)',
        padding: '0 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 56,
        position: 'sticky',
        top: 0,
        zIndex: 'var(--ap-z-header)' as unknown as number,
        boxShadow: '0 1px 4px var(--ap-shadow)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button
          type="text"
          icon={leftIcon}
          onClick={handleLeftClick}
          aria-label={isCompact ? 'Open menu' : sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{ fontSize: 18, color: 'var(--ap-text-muted)' }}
        />
      </div>

      {/* 中央 toast 槽预留（F5 接入 message 全局配置） */}
      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tooltip title={isDark ? '切换浅色' : '切换暗色'}>
          <Button
            type="text"
            icon={isDark ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggle}
            aria-label="Toggle theme"
            style={{ color: 'var(--ap-text-muted)' }}
          />
        </Tooltip>

        <span
          style={{
            fontSize: 11,
            color: 'var(--ap-text-dim)',
            display: isCompact ? 'none' : 'inline',
          }}
        >
          MLFlow Visualizer
        </span>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--ap-success)',
          }}
          aria-label="System OK"
        />
      </div>
    </AntHeader>
  )
}

export default TopBar
