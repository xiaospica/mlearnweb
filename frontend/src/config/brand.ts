/**
 * AlphaPilot 品牌常量
 * 统一通过 BRAND_NAME / BRAND_TAGLINE 引用，便于将来改名时零成本迁移。
 */

import logoMarkUrl from '@/assets/brand/logo-mark.svg'
import logoFullUrl from '@/assets/brand/logo-full.svg'

export const BRAND_NAME = 'AlphaPilot'
export const BRAND_TAGLINE = 'Quant Research → Live Trading'

export const BRAND_ASSETS = {
  /** 仅 mark（32x32，currentColor 染色） */
  mark: logoMarkUrl,
  /** mark + 字标（168x32，currentColor 染色） */
  full: logoFullUrl,
} as const
