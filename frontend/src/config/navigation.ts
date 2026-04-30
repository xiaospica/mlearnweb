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
  AppstoreOutlined,
  FileTextOutlined,
  ProfileOutlined,
  SettingOutlined,
  BgColorsOutlined,
  ControlOutlined,
  ClusterOutlined,
  SafetyCertificateOutlined,
  CodeOutlined,
  InfoCircleOutlined,
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
    !p.startsWith('/help') &&
    !p.startsWith('/settings'))

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
    children: [
      {
        key: 'help-categories',
        label: '因子分类',
        path: '/help/categories',
        icon: AppstoreOutlined,
      },
      {
        key: 'help-alpha158',
        label: 'Alpha158',
        path: '/help/alpha158',
        icon: DatabaseOutlined,
      },
      {
        key: 'help-alpha101',
        label: 'Alpha101',
        path: '/help/alpha101',
        icon: FileTextOutlined,
      },
      {
        key: 'help-alpha191',
        label: 'Alpha191',
        path: '/help/alpha191',
        icon: ProfileOutlined,
      },
    ],
  },
  {
    key: 'settings',
    label: '设置',
    path: '/settings',
    icon: SettingOutlined,
    match: (p) => p.startsWith('/settings'),
    children: [
      {
        key: 'settings-appearance',
        label: '外观',
        path: '/settings/appearance',
        icon: BgColorsOutlined,
      },
      {
        key: 'settings-runtime',
        label: '运行期默认',
        path: '/settings/runtime',
        icon: ControlOutlined,
      },
      {
        key: 'settings-nodes',
        label: 'vnpy 节点',
        path: '/settings/nodes',
        icon: ClusterOutlined,
      },
      {
        key: 'settings-system',
        label: '系统限制',
        path: '/settings/system',
        icon: SafetyCertificateOutlined,
      },
      {
        key: 'settings-env',
        label: '环境信息',
        path: '/settings/env',
        icon: CodeOutlined,
      },
      {
        key: 'settings-about',
        label: '关于',
        path: '/settings/about',
        icon: InfoCircleOutlined,
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

/**
 * 计算当前 pathname 激活的叶子节点 key（优先匹配二级，兜底返回一级）。
 * 用于 Sidebar/Drawer 的 Menu 高亮。
 */
export const findActiveLeafKey = (pathname: string): string | null => {
  // 先匹配二级（更具体）
  for (const item of PRIMARY_NAV) {
    if (!item.children) continue
    for (const c of item.children) {
      const matched = c.match ? c.match(pathname) : defaultPathMatch(c, pathname)
      if (matched) return c.key
    }
  }
  // 再匹配一级
  return findActiveNavKey(pathname)
}

/** 给定一个 leaf key，找它所属的一级菜单 key（用于决定 Menu 默认展开哪一组） */
export const findParentKeyOf = (leafKey: string): string | null => {
  for (const item of PRIMARY_NAV) {
    if (item.key === leafKey) return null // 自己就是一级
    if (item.children?.some((c) => c.key === leafKey)) return item.key
  }
  return null
}

/** key → path 的扁平映射，给 Menu onClick 查表 */
export const NAV_PATH_BY_KEY: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const item of PRIMARY_NAV) {
    map[item.key] = item.path
    for (const c of item.children ?? []) map[c.key] = c.path
  }
  return map
})()
