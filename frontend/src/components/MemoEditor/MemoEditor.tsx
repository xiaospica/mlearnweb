import React, { useCallback, useRef } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { message } from 'antd'
import { trainingImageService } from '@/services/trainingImageService'

import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import './MemoEditor.css'

interface Props {
  recordId: number
  value: string
  onChange: (v: string) => void
  height?: number
}

const MemoEditor: React.FC<Props> = ({ recordId, value, onChange, height = 420 }) => {
  const valueRef = useRef(value)
  valueRef.current = value

  const insertAtCursor = useCallback(
    (textarea: HTMLTextAreaElement, snippet: string) => {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const current = valueRef.current || ''
      const next = current.slice(0, start) + snippet + current.slice(end)
      onChange(next)
      requestAnimationFrame(() => {
        textarea.focus()
        const pos = start + snippet.length
        textarea.setSelectionRange(pos, pos)
      })
    },
    [onChange],
  )

  const replaceInValue = useCallback(
    (needle: string, replacement: string) => {
      const current = valueRef.current || ''
      if (current.includes(needle)) {
        onChange(current.replace(needle, replacement))
      }
    },
    [onChange],
  )

  const uploadAndInsert = useCallback(
    async (file: File, textarea: HTMLTextAreaElement | null) => {
      if (!file.type.startsWith('image/')) return
      const token = `uploading-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const placeholder = `![uploading...](${token})`
      if (textarea) {
        insertAtCursor(textarea, placeholder)
      } else {
        onChange((valueRef.current || '') + `\n${placeholder}\n`)
      }
      try {
        const { url } = await trainingImageService.upload(recordId, file)
        const alt = file.name.replace(/[\]\[()]/g, '')
        replaceInValue(placeholder, `![${alt}](${url})`)
      } catch (e) {
        console.error('[MemoEditor] upload failed', e)
        message.error(`图片上传失败: ${file.name}`)
        replaceInValue(placeholder, '')
      }
    },
    [recordId, insertAtCursor, replaceInValue, onChange],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items || items.length === 0) return
      const files: File[] = []
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        if (it.kind === 'file') {
          const f = it.getAsFile()
          if (f && f.type.startsWith('image/')) files.push(f)
        }
      }
      if (files.length === 0) return
      e.preventDefault()
      const target = e.currentTarget
      files.forEach((f) => {
        void uploadAndInsert(f, target)
      })
    },
    [uploadAndInsert],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
        f.type.startsWith('image/'),
      )
      if (files.length === 0) return
      e.preventDefault()
      const target = e.currentTarget
      files.forEach((f) => {
        void uploadAndInsert(f, target)
      })
    },
    [uploadAndInsert],
  )

  return (
    <div data-color-mode="light" className="memo-editor-wrapper">
      <MDEditor
        value={value}
        onChange={(v) => onChange(v || '')}
        height={height}
        preview="live"
        textareaProps={{
          placeholder:
            '支持 Markdown · 直接粘贴 (Ctrl+V) 或拖拽图片到此处上传',
          onPaste: handlePaste,
          onDrop: handleDrop,
        }}
      />
    </div>
  )
}

export default MemoEditor
