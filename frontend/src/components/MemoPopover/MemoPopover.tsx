import React, { Suspense, useState } from 'react'
import { Popover, Spin } from 'antd'
import { useTheme } from '@/hooks/useTheme'

import '@uiw/react-markdown-preview/markdown.css'
import './MemoPopover.css'

const MarkdownPreview = React.lazy(() => import('@uiw/react-markdown-preview'))

interface Props {
  memo: string
  children: React.ReactNode
}

const MemoPopover: React.FC<Props> = ({ memo, children }) => {
  const [open, setOpen] = useState(false)
  const { mode } = useTheme()

  const content = open ? (
    <div className="memo-popover-content" data-color-mode={mode}>
      <Suspense
        fallback={
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin size="small" />
          </div>
        }
      >
        <MarkdownPreview source={memo} />
      </Suspense>
    </div>
  ) : null

  return (
    <Popover
      title="备忘录"
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      destroyTooltipOnHide
      content={content}
    >
      {children}
    </Popover>
  )
}

export default MemoPopover
