/**
 * 从 AlphaPilot 设计 token 派生 AntD ConfigProvider 配置
 * 暗色用 darkAlgorithm + 自定义 token 覆盖；浅色用 defaultAlgorithm。
 */

import { theme as antTheme, type ThemeConfig } from 'antd'
import { FONT_FAMILY, FS, PALETTE_DARK, PALETTE_LIGHT, RADIUS, type ThemeMode } from './tokens'

const buildToken = (p: typeof PALETTE_DARK) => ({
  colorPrimary: p.brandPrimary,
  colorPrimaryHover: p.brandPrimaryHover,
  colorSuccess: p.success,
  colorWarning: p.warning,
  colorError: p.danger,
  colorInfo: p.info,
  colorBgBase: p.bg,
  colorBgContainer: p.panel,
  colorBgElevated: p.panelElevated,
  colorBgLayout: p.bg,
  colorBorder: p.border,
  colorBorderSecondary: p.borderMuted,
  colorText: p.text,
  colorTextSecondary: p.textMuted,
  colorTextTertiary: p.textDim,
  colorTextDescription: p.textMuted,
  borderRadius: RADIUS.base,
  borderRadiusSM: RADIUS.sm,
  borderRadiusLG: RADIUS.lg,
  fontFamily: FONT_FAMILY,
  fontSize: FS.base,
  fontSizeSM: FS.sm,
  fontSizeLG: FS.lg,
})

const darkComponents = {
  Layout: {
    headerBg: PALETTE_DARK.panel,
    siderBg: PALETTE_DARK.panel,
    bodyBg: PALETTE_DARK.bg,
    triggerBg: PALETTE_DARK.panelMuted,
  },
  Menu: {
    itemBg: 'transparent',
    itemSelectedBg: PALETTE_DARK.panelMuted,
    itemHoverBg: PALETTE_DARK.panelMuted,
    itemSelectedColor: PALETTE_DARK.brandPrimary,
    // subMenu 与主菜单同 bg（透明继承 Sider），避免子菜单出现明显色块
    subMenuItemBg: 'transparent',
  },
  Table: {
    headerBg: PALETTE_DARK.panelMuted,
    headerColor: PALETTE_DARK.text,
    rowHoverBg: PALETTE_DARK.panelElevated,
    borderColor: PALETTE_DARK.borderMuted,
    colorBgContainer: PALETTE_DARK.panel,
  },
  Card: {
    colorBgContainer: PALETTE_DARK.panel,
    colorBorderSecondary: PALETTE_DARK.border,
  },
  Tabs: {
    itemColor: PALETTE_DARK.textMuted,
    itemHoverColor: PALETTE_DARK.text,
    itemSelectedColor: PALETTE_DARK.brandPrimary,
    inkBarColor: PALETTE_DARK.brandPrimary,
  },
  Button: {
    colorPrimaryHover: PALETTE_DARK.brandPrimaryHover,
  },
  Tag: {
    defaultBg: PALETTE_DARK.panelMuted,
    defaultColor: PALETTE_DARK.text,
  },
  Statistic: {
    titleFontSize: FS.sm,
    contentFontSize: FS.xxl,
  },
  Drawer: {
    colorBgElevated: PALETTE_DARK.panel,
  },
  Modal: {
    contentBg: PALETTE_DARK.panel,
    headerBg: PALETTE_DARK.panel,
  },
  Tooltip: {
    colorBgSpotlight: PALETTE_DARK.panelElevated,
  },
  Input: {
    colorBgContainer: PALETTE_DARK.panelMuted,
    colorBorder: PALETTE_DARK.border,
  },
  Select: {
    colorBgContainer: PALETTE_DARK.panelMuted,
    colorBgElevated: PALETTE_DARK.panelElevated,
  },
}

const lightComponents = {
  Layout: {
    headerBg: PALETTE_LIGHT.panel,
    siderBg: PALETTE_LIGHT.panel,
    bodyBg: PALETTE_LIGHT.bg,
    triggerBg: PALETTE_LIGHT.panelMuted,
  },
  Menu: {
    itemSelectedBg: '#E6F1FF',
    itemHoverBg: PALETTE_LIGHT.panelMuted,
    itemSelectedColor: PALETTE_LIGHT.brandPrimary,
  },
  Table: {
    headerBg: '#FAFBFC',
    rowHoverBg: '#F0F5FF',
    borderColor: '#F0F0F0',
  },
  Card: {
    colorBgContainer: PALETTE_LIGHT.panel,
    colorBorderSecondary: '#E8E8E8',
  },
  Tabs: {
    itemSelectedColor: PALETTE_LIGHT.brandPrimary,
    inkBarColor: PALETTE_LIGHT.brandPrimary,
  },
  Statistic: {
    titleFontSize: FS.sm,
    contentFontSize: FS.xxl,
  },
}

export const darkTheme: ThemeConfig = {
  algorithm: antTheme.darkAlgorithm,
  token: buildToken(PALETTE_DARK),
  components: darkComponents,
}

export const lightTheme: ThemeConfig = {
  algorithm: antTheme.defaultAlgorithm,
  token: buildToken(PALETTE_LIGHT),
  components: lightComponents,
}

export const themeConfigOf = (mode: ThemeMode): ThemeConfig =>
  mode === 'dark' ? darkTheme : lightTheme
