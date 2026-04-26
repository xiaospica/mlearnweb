/**
 * JSON 代码编辑器（基于 CodeMirror 6）
 *
 * - 语法高亮 / 自动缩进 / 括号匹配 / 行号 / 折叠
 * - 失焦时校验 + 触发 onChange（JSON.parse 成功才会回写）
 * - 高度自适应：默认填满到 viewport bottom（可通过 fillToBottom 关闭，传固定 height）
 * - 暗色主题（与日志面板视觉一致）
 */

import React, { useEffect, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { linter, lintGutter } from '@codemirror/lint'
import { Typography } from 'antd'

interface JsonCodeEditorProps {
  value: unknown
  onChange: (value: unknown) => void
  /** 固定高度（px），传了就不自适应 */
  height?: number
  /** 自适应到 viewport 底部，预留 px 留白（默认 24） */
  bottomPadding?: number
  /** 最小高度（自适应模式下） */
  minHeight?: number
  /** 只读 */
  readonly?: boolean
}

const JsonCodeEditor: React.FC<JsonCodeEditorProps> = ({
  value,
  onChange,
  height,
  bottomPadding = 24,
  minHeight = 240,
  readonly = false,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [error, setError] = useState<string | null>(null)
  const [autoHeight, setAutoHeight] = useState<number>(height ?? 480)

  // 外部 value 变化时同步 textarea
  useEffect(() => {
    setText(JSON.stringify(value, null, 2))
    setError(null)
  }, [value])

  // 高度自适应：测容器顶部到 viewport 底部
  useEffect(() => {
    if (height !== undefined) return // 固定高度模式不自适应
    const update = () => {
      if (containerRef.current) {
        const top = containerRef.current.getBoundingClientRect().top
        const h = Math.max(minHeight, window.innerHeight - top - bottomPadding)
        setAutoHeight(h)
      }
    }
    const raf = requestAnimationFrame(update)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', update)
    }
  }, [height, bottomPadding, minHeight])

  const handleChange = (val: string) => {
    setText(val)
  }

  const handleBlur = () => {
    try {
      const parsed = JSON.parse(text)
      setError(null)
      onChange(parsed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON')
    }
  }

  const finalHeight = height ?? autoHeight

  return (
    <div ref={containerRef}>
      <div onBlur={handleBlur}>
        <CodeMirror
          value={text}
          onChange={handleChange}
          height={`${finalHeight}px`}
          theme="dark"
          extensions={[json(), linter(jsonParseLinter()), lintGutter()]}
          readOnly={readonly}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            indentOnInput: true,
            tabSize: 2,
          }}
        />
      </div>
      {error && (
        <Typography.Text
          type="danger"
          style={{ fontSize: 12, marginTop: 4, display: 'block' }}
        >
          ⚠ JSON 解析失败：{error}（失焦时校验，请修正后失焦或自动保存）
        </Typography.Text>
      )}
    </div>
  )
}

export default JsonCodeEditor
