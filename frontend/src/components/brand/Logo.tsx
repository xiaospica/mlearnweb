/**
 * AlphaPilot 品牌 Logo（内联 SVG）
 *
 * 用内联 SVG 而非 <img src=...> 是为了让 currentColor 生效——可通过 `style={{color: ...}}`
 * 或 `className` 控色，从而在 dark/light 主题间切换 brand mark 与字标颜色。
 *
 * 与 src/assets/brand/*.svg 视觉等价；那些 .svg 文件用于需要 URL 的场景（favicon、外链）。
 */

import { type CSSProperties } from 'react'

interface LogoProps {
  /** 'mark' 仅图标 32x32；'full' 图标 + AlphaPilot 字标 168x32 */
  variant?: 'mark' | 'full'
  /** 渲染高度（px）。宽度按比例自适应 */
  height?: number
  className?: string
  style?: CSSProperties
  title?: string
  onClick?: () => void
}

const Logo = ({
  variant = 'full',
  height = 32,
  className,
  style,
  title,
  onClick,
}: LogoProps) => {
  const commonProps = {
    xmlns: 'http://www.w3.org/2000/svg',
    fill: 'none' as const,
    height,
    className,
    style: { display: 'block', cursor: onClick ? 'pointer' : undefined, ...style },
    onClick,
  }

  if (variant === 'mark') {
    return (
      <svg {...commonProps} viewBox="0 0 32 32" width={height}>
        {title && <title>{title}</title>}
        <rect width="32" height="32" rx="7" fill="currentColor" />
        <text
          x="16"
          y="22"
          fontFamily="'Inter', system-ui, -apple-system, sans-serif"
          fontSize="20"
          fontWeight="700"
          fill="#fff"
          textAnchor="middle"
        >
          α
        </text>
        <polygon points="22,3.5 28.5,8 22,12.5" fill="#fff" />
      </svg>
    )
  }

  // full variant: 168x32 — mark + AlphaPilot 字标
  const width = (height * 168) / 32
  return (
    <svg {...commonProps} viewBox="0 0 168 32" width={width}>
      {title && <title>{title}</title>}
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <text
        x="16"
        y="22"
        fontFamily="'Inter', system-ui, -apple-system, sans-serif"
        fontSize="20"
        fontWeight="700"
        fill="#fff"
        textAnchor="middle"
      >
        α
      </text>
      <polygon points="22,3.5 28.5,8 22,12.5" fill="#fff" />
      <text
        x="42"
        y="22"
        fontFamily="'Inter', system-ui, -apple-system, sans-serif"
        fontSize="18"
        fontWeight="600"
        fill="currentColor"
      >
        AlphaPilot
      </text>
    </svg>
  )
}

export default Logo
