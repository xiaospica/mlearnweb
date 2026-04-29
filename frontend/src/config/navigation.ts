/**
 * AlphaPilot 一级导航单一事实源
 *
 * Header / Sidebar / MobileNavDrawer 三处都消费同一份 PRIMARY_NAV，
 * 路由调整 / 新增菜单 / 改图标 / 加徽标都只需改这里。
 *
 * 设计原则：
 * - icon 存的是组件引用（ComponentType），不是 JSX 元素，让消费方决定大小/颜色
 * - match 函数兜底：当一级菜单覆盖多条路由时（如「实验浏览」也覆盖 /report），
 *   显式给出匹配规则，避免散落在 Header / Sidebar 各处重复实现
 * - badgeKey 预留运行时状态徽标（实盘告警 / 跑批进度等），
 *   消费方根据 key 自取数据，配置不持有运行态
 */

import type { ComponentType } from 'react'
import {
  ExperimentOutlined,
  ToolOutlined,
  DatabaseOutlined,
  ThunderboltOutlined,
  BookOutlined,
} from '@ant-design/icons'

export type NavBadgeKey = 'liveAlerts' | 'runningJobs'

/** AntD icon 组件签名（接受 style/className 透传） */
export type NavIcon = ComponentType<{
  style?: React.CSSProperties
  className?: string
}>

export interface NavItem {
  key: string
  label: string
  path: string
  icon?: NavIcon
  /** 若提供，按此函数判断当前路径是否激活该项；否则走默认 path 前缀匹配 */
  match?: (pathname: string) => boolean
  children?: NavItem[]
  badgeKey?: NavBadgeKey
}

const isTrainingRecordsPath = (p: string): boolean =>
  p === '/' ||
  p.startsWith('/training/') ||
  (!p.startsWith('/workbench') &&
    !p.startsWith('/experiments') &&
    !p.startsWith('/report') &&
    !p.startsWith('/live-trading') &&
    !p.startsWith('/help'))

export const PRIMARY_NAV: NavItem[] = [
  {
    key: 'training',
    label: '训练记录',
    path: '/',
    icon: ExperimentOutlined,
    match: isTrainingRecordsPath,
  },
  {
    key: 'workbench',
    label: '训练工作台',
    path: '/workbench',
    icon: ToolOutlined,
    match: (p) => p.startsWith('/workbench'),
  },
  {
    key: 'experiments',
    label: '实验浏览',
    path: '/experiments',
    icon: DatabaseOutlined,
    match: (p) => p.startsWith('/experiments') || p.startsWith('/report'),
  },
  {
    key: 'live',
    label: '实盘交易',
    path: '/live-trading',
    icon: ThunderboltOutlined,
    badgeKey: 'liveAlerts',
    match: (p) => p.startsWith('/live-trading'),
  },
  {
    key: 'help',
    label: '帮助',
    path: '/help',
    icon: BookOutlined,
    match: (p) => p.startsWith('/help'),
    // F4a: 仅保留 legacy「因子文档 → /help」单项（HelpLayout 自带 4 项子导航）
    // F4b: Sidebar 接入后再展开为 4 项（categories/alpha158/alpha101/alpha191）
    children: [
      {
        key: 'help-factor-docs',
        label: '因子文档',
        path: '/help',
        icon: BookOutlined,
      },
    ],
  },
]

const defaultPathMatch = (item: NavItem, pathname: string): boolean =>
  pathname === item.path || pathname.startsWith(item.path + '/')

/** 计算当前 pathname 激活哪一项一级菜单 */
export const findActiveNavKey = (pathname: string): string | null => {
  for (const item of PRIMARY_NAV) {
    const matched = item.match ? item.match(pathname) : defaultPathMatch(item, pathname)
    if (matched) return item.key
  }
  return null
}
