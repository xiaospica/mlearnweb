import { Result } from 'antd'
import PageContainer from '@/components/layout/PageContainer'

const SettingsNodesPage = () => {
  return (
    <PageContainer
      title="vnpy 节点"
      subtitle="实盘节点的注册、健康探测、JWT 密码与 yaml 导入导出"
    >
      <Result
        status="info"
        title="即将上线"
        subTitle="此面板需要将 vnpy_nodes.yaml 迁移到数据库 + CRUD API + 健康探测（Phase 4）。当前请直接编辑 mlearnweb/backend/vnpy_nodes.yaml 并重启 app.live_main。"
      />
    </PageContainer>
  )
}

export default SettingsNodesPage
