/**
 * 运行期默认（L2 / DB-backed）
 *
 * 展示并编辑 SETTING_REGISTRY 中 category=paths/vnpy 的 6 项：
 *   - daily_merged_root, ml_live_output_root              (paths)
 *   - vnpy_request_timeout, vnpy_poll_interval_seconds,
 *     vnpy_snapshot_retention_days, deployment_sync_interval_seconds (vnpy)
 *
 * 写入立即生效（5s TTL 缓存内最多滞后 5 秒被读到）。
 * 长尾业务回归点：vnpy poll 周期改小后 snapshot_loop 自动按新值 sleep。
 *
 * limits 类（max_image_size_mb / allowed_image_exts / orphan_grace_seconds）
 * 拆到 /settings/system 单独页，避免本页字段过密。
 */

import { Card, Spin, Result, Button, Alert, Space } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import PageContainer from '@/components/layout/PageContainer'
import { listRuntimeSettings, type RuntimeSettingItem } from '@/services/settingsService'
import RuntimeSettingEditor from './RuntimeSettingEditor'

const SettingsRuntimePage = () => {
  const { data, isLoading, error, refetch, isFetching } = useQuery<RuntimeSettingItem[]>({
    queryKey: ['settings', 'runtime'],
    queryFn: listRuntimeSettings,
    staleTime: 30_000,
  })

  if (isLoading) {
    return (
      <PageContainer title="运行期默认">
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin />
        </div>
      </PageContainer>
    )
  }

  if (error || !data) {
    return (
      <PageContainer
        title="运行期默认"
        actions={
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            重试
          </Button>
        }
      >
        <Result
          status="error"
          title="加载运行期配置失败"
          subTitle={String((error as Error)?.message ?? '请确认 /api/settings/runtime 已上线')}
        />
      </PageContainer>
    )
  }

  const paths = data.filter((d) => d.category === 'paths')
  const vnpy = data.filter((d) => d.category === 'vnpy')

  return (
    <PageContainer
      title="运行期默认"
      subtitle="DB 覆盖优先于 .env；保存即生效（最多滞后 5 秒被各进程读到）"
      actions={
        <Button icon={<ReloadOutlined />} onClick={() => refetch()} loading={isFetching}>
          刷新
        </Button>
      }
      alerts={
        <Alert
          type="info"
          showIcon
          message="路径类字段虽然能热改，但需要确保对应文件 / 目录在文件系统上确实存在，否则下次读取时会报错。"
        />
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card title="路径" size="small">
          {paths.map((it) => (
            <RuntimeSettingEditor key={it.key} item={it} invalidateKeys={[['settings', 'env']]} />
          ))}
        </Card>

        <Card title="vnpy 实盘 / 同步周期" size="small">
          {vnpy.map((it) => (
            <RuntimeSettingEditor key={it.key} item={it} invalidateKeys={[['settings', 'env']]} />
          ))}
        </Card>
      </Space>
    </PageContainer>
  )
}

export default SettingsRuntimePage
