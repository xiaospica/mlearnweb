/**
 * 外观设置（L3 / 仅本浏览器）
 *
 * 集中以下偏好的可视化入口：
 * - 主题：dark / light（驱动 themeStore）
 * - Sidebar 默认折叠（驱动 prefsStore.sidebarDefaultCollapsed —— 仅作下次会话默认值）
 * - 图表默认高度：xs/sm/md/lg 四档（驱动 prefsStore.chartHeights，由 chart-utils 消费）
 * - 一键重置：清空所有 prefs.v1，主题保持不变（在 themeStore 自治范围）
 *
 * 写入即生效；图表高度由于使用 sync 读 + 无订阅设计，需图表 re-mount 才生效，
 * 页面通过 Alert 提示。
 */

import { useMemo } from 'react'
import {
  Card,
  Radio,
  Switch,
  InputNumber,
  Space,
  Button,
  Alert,
  Typography,
  Row,
  Col,
  Divider,
  App as AntApp,
} from 'antd'
import { ReloadOutlined, BulbOutlined } from '@ant-design/icons'
import PageContainer from '@/components/layout/PageContainer'
import { useThemeStore } from '@/stores/themeStore'
import { usePrefs } from '@/stores/prefsStore'
import { DEFAULT_CHART_HEIGHTS } from '@/components/responsive/chart-utils'

const { Text } = Typography

type BpKey = 'xs' | 'sm' | 'md' | 'lg'
const BP_LIST: { key: BpKey; label: string; hint: string }[] = [
  { key: 'xs', label: 'xs', hint: '<576px 手机' },
  { key: 'sm', label: 'sm', hint: '≥576px 大手机' },
  { key: 'md', label: 'md', hint: '≥768px 平板' },
  { key: 'lg', label: 'lg', hint: '≥992px 桌面' },
]

const SettingsAppearancePage = () => {
  const { mode, setMode } = useThemeStore()
  const { prefs, setPrefs, reset } = usePrefs()
  const { message } = AntApp.useApp()

  const chartHeights = useMemo(
    () => ({
      xs: prefs.chartHeights?.xs ?? DEFAULT_CHART_HEIGHTS.xs,
      sm: prefs.chartHeights?.sm ?? DEFAULT_CHART_HEIGHTS.sm,
      md: prefs.chartHeights?.md ?? DEFAULT_CHART_HEIGHTS.md,
      lg: prefs.chartHeights?.lg ?? DEFAULT_CHART_HEIGHTS.lg,
    }),
    [prefs.chartHeights],
  )

  const updateHeight = (bp: BpKey, v: number | null) => {
    if (v == null) return
    setPrefs({ chartHeights: { [bp]: v } })
  }

  const resetHeights = () => {
    setPrefs({ chartHeights: {} })
    message.success('图表高度已恢复默认')
  }

  const handleReset = () => {
    reset()
    message.success('外观偏好已重置')
  }

  return (
    <PageContainer
      title="外观"
      subtitle="主题、侧栏、图表高度等仅影响当前浏览器的偏好；与服务端无关"
      actions={
        <Button icon={<ReloadOutlined />} onClick={handleReset}>
          重置全部偏好
        </Button>
      }
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="主题" size="small">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Radio.Group
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                optionType="button"
                buttonStyle="solid"
              >
                <Radio.Button value="dark">深色</Radio.Button>
                <Radio.Button value="light">浅色</Radio.Button>
              </Radio.Group>
              <Text type="secondary" style={{ fontSize: 12 }}>
                <BulbOutlined /> 顶栏右上角的图标可以快速切换主题；这里和那里读写的是同一份偏好。
              </Text>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title="侧栏" size="small">
            <Space align="center" size={16}>
              <Switch
                checked={!!prefs.sidebarDefaultCollapsed}
                onChange={(v) => setPrefs({ sidebarDefaultCollapsed: v })}
              />
              <div>
                <div>下次进入页面时默认折叠侧栏</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  当前会话的折叠状态由顶栏的折叠按钮控制；这里是新会话的默认值。
                </Text>
              </div>
            </Space>
          </Card>
        </Col>

        <Col xs={24}>
          <Card
            title="图表默认高度"
            size="small"
            extra={
              <Button size="small" onClick={resetHeights}>
                恢复默认
              </Button>
            }
          >
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="高度修改在图表下次挂载时生效（切页 / 刷新即可）。"
            />
            <Row gutter={[16, 12]}>
              {BP_LIST.map(({ key, label, hint }) => (
                <Col key={key} xs={12} sm={12} md={6}>
                  <div style={{ marginBottom: 4 }}>
                    <Text strong>{label}</Text>{' '}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {hint}
                    </Text>
                  </div>
                  <InputNumber
                    value={chartHeights[key]}
                    onChange={(v) => updateHeight(key, v as number | null)}
                    min={120}
                    max={800}
                    step={20}
                    addonAfter="px"
                    style={{ width: '100%' }}
                  />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    默认 {DEFAULT_CHART_HEIGHTS[key]}px
                  </Text>
                </Col>
              ))}
            </Row>
            <Divider style={{ margin: '12px 0' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              这只是「未指定高度」的图表的默认值；ReportPage 中部分图表（SHAP 热图、Plotly 大图）已显式设置高度，会忽略这里的值。
            </Text>
          </Card>
        </Col>
      </Row>
    </PageContainer>
  )
}

export default SettingsAppearancePage
