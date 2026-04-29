/**
 * 响应式 AntD Modal props
 *
 * 使用方式：
 *   const responsiveProps = useResponsiveModalProps()
 *   <Modal {...responsiveProps} title="..." open={...}>...</Modal>
 *
 * 在 xs (<sm, <576px) 自动把 Modal 撑成全屏，移除外缘 padding 与圆角，
 * body 高度填满视口减去 header / footer 高度。其它断点不注入任何 props，
 * 让调用方原本的 width / style 完整生效。
 *
 * 调用方需要自定义 width 时，可以用 spread + override：
 *   <Modal {...useResponsiveModalProps()} width={720}>
 * 在 xs 时 width 仍会被 hook 的 '100%' 覆盖（spread 顺序保证），符合预期。
 */

import type { ModalProps } from 'antd'
import { useIsMobile } from '@/hooks/useBreakpoint'

const FULLSCREEN_PROPS: Partial<ModalProps> = {
  width: '100%',
  centered: false,
  style: { top: 0, padding: 0, margin: 0, maxWidth: '100vw' },
  styles: {
    content: {
      borderRadius: 0,
      minHeight: '100vh',
      paddingTop: 16,
    },
    body: {
      maxHeight: 'calc(100vh - 120px)',
      overflowY: 'auto',
    },
  },
}

export const useResponsiveModalProps = (): Partial<ModalProps> => {
  const isMobile = useIsMobile()
  return isMobile ? FULLSCREEN_PROPS : {}
}
