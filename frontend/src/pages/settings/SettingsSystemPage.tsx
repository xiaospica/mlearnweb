/**
 * 系统限制（L2 / DB-backed）
 *
 * 展示并编辑 SETTING_REGISTRY 中 category=limits 的 3 项：
 *   - max_image_size_mb
 *   - allowed_image_exts  (list_str)
 *   - orphan_grace_seconds
 */

import { Card, Spin, Result, Button, Space } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import PageContainer from '@/components/layout/PageContainer'
import { listRuntimeSettings, type RuntimeSettingItem } from '@/services/settingsService'
import RuntimeSettingEditor from './RuntimeSettingEditor'

const SettingsSystemPage = () => {
  const { data, isLoading, error, refetch, isFetching } = useQuery<RuntimeSettingItem[]>({
    queryKey: ['settings', 'runtime'],
    queryFn: listRuntimeSettings,
    staleTime: 30_000,
  })

  if (isLoading) {
    return (
      <PageContainer title="系统限制">
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin />
        </div>
      </PageContainer>
    )
  }

  if (error || !data) {
    return (
      <PageContainer
        title="系统限制"
        actions={
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            重试
          </Button>
        }
      >
        <Result
          status="error"
          title="加载系统限制失败"
          subTitle={String((error as Error)?.message ?? '请确认 /api/settings/runtime 已上线')}
        />
      </PageContainer>
    )
  }

  const limits = data.filter((d) => d.category === 'limits')

  return (
    <PageContainer
      title="系统限制"
      subtitle="memo 图片上传与孤儿清理相关的配置"
      actions={
        <Button icon={<ReloadOutlined />} onClick={() => refetch()} loading={isFetching}>
          刷新
        </Button>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card title="memo 图片" size="small">
          {limits.map((it) => (
            <RuntimeSettingEditor key={it.key} item={it} invalidateKeys={[['settings', 'env']]} />
          ))}
        </Card>
      </Space>
    </PageContainer>
  )
}

export default SettingsSystemPage
