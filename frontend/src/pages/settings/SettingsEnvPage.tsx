/**
 * 环境信息（只读视图，含编辑入口）
 *
 * 展示当前研究侧后端进程的关键路径、版本与节点摘要。
 * - L1 字段（mlruns_dir / database_url / upload_dir / vnpy_nodes_config_path / cors_origins）：
 *   显示「需重启」徽标，编辑路径只能改 .env / config.py 后重启进程
 * - L2 字段（已注册到 SETTING_REGISTRY 的 8 项）：显示当前 source（DB 覆盖 / 跟随 .env）
 *   并附「在 Runtime 编辑」链接跳到对应编辑页
 */

import { useMemo } from 'react'
import {
  Card,
  Descriptions,
  Tag,
  Alert,
  Spin,
  Result,
  Button,
  Typography,
  Space,
  Tooltip,
  Table,
  App as AntApp,
} from 'antd'
import {
  ReloadOutlined,
  CopyOutlined,
  EditOutlined,
  WarningOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import PageContainer from '@/components/layout/PageContainer'
import { fetchEnvInfo, type EnvInfo } from '@/services/settingsService'

const { Text } = Typography

const formatYesNo = (v: boolean) => (v ? <Tag color="green">是</Tag> : <Tag color="red">否</Tag>)

interface FieldExtraProps {
  /** L2 注册键名；非注册键传 null 则只显示「需重启」 */
  runtimeKey: string | null
  /** 跳转目标，默认 /settings/runtime；limits 类传 /settings/system */
  editTo?: string
  overrides?: EnvInfo['runtime_overrides']
}

/** 字段右侧 chip：DB 覆盖 + 跳编辑 / 跟随 .env / 需重启 */
const FieldExtra = ({ runtimeKey, editTo = '/settings/runtime', overrides }: FieldExtraProps) => {
  const mark = runtimeKey ? overrides?.[runtimeKey] : null
  if (mark == null) {
    return (
      <Tooltip title="此字段在启动时绑定到进程内对象，必须改 .env / config.py 后重启对应进程才能生效。">
        <Tag color="orange" icon={<WarningOutlined />}>需重启</Tag>
      </Tooltip>
    )
  }
  return (
    <Space size={4}>
      {mark.source === 'db' ? (
        <Tag color="blue">DB 覆盖</Tag>
      ) : (
        <Tag>跟随 .env</Tag>
      )}
      <Tooltip title="在 Runtime 配置页编辑（保存即热生效）">
        <Link to={editTo}>
          <Button size="small" type="link" icon={<EditOutlined />}>编辑</Button>
        </Link>
      </Tooltip>
      <Tag color="green" icon={<ThunderboltOutlined />}>热改</Tag>
    </Space>
  )
}

const CopyableText = ({ value }: { value: string | null | undefined }) => {
  const { message } = AntApp.useApp()
  if (!value) return <Text type="secondary">—</Text>
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      message.success('已复制')
    } catch {
      message.error('复制失败')
    }
  }
  return (
    <Space size={4}>
      <Text code style={{ wordBreak: 'break-all' }}>{value}</Text>
      <Button
        size="small"
        type="text"
        icon={<CopyOutlined />}
        onClick={onCopy}
        aria-label="复制"
      />
    </Space>
  )
}

/** 「如何编辑只读字段」面板：展示 .env 路径 + L1 字段对应的 env 变量名 */
const L1EditGuideCard = ({ data }: { data: EnvInfo }) => {
  const meta = data.l1_field_meta ?? {}
  const fileInfo = data.env_file_info
  const allEntries = Object.entries(meta)
  const owned = allEntries.filter(([, m]) => m.ownership === 'mlearnweb_owned')
  const remoteView = allEntries.filter(([, m]) => m.ownership === 'remote_mount_view')

  const restartLabel = (r: 'main' | 'live_main' | 'both') =>
    r === 'main' ? (
      <Tag color="purple">app.main</Tag>
    ) : r === 'live_main' ? (
      <Tag color="cyan">app.live_main</Tag>
    ) : (
      <Tag color="magenta">两个进程</Tag>
    )

  const ownedRows = owned.map(([key, m]) => ({
    key,
    setting_key: key,
    env_var: m.env_var,
    restart: m.restart,
    hint: m.hint,
  }))

  return (
    <Card
      title={
        <Space size={6}>
          <WarningOutlined style={{ color: 'var(--ap-warning)' }} />
          如何编辑「需重启」字段
        </Space>
      }
      size="small"
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="warning"
          showIcon
          message={
            <span>
              这些字段都是 <strong>部署绑定</strong>，出于安全与一致性考虑不通过 web UI 编辑。
              修改步骤：① 编辑下面的 .env 文件 ② 重启对应进程。
            </span>
          }
        />

        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label=".env 文件路径">
            <Space size={4} wrap>
              <CopyableText value={fileInfo.env_file_path} />
              <Tag color={fileInfo.env_file_exists ? 'green' : 'red'}>
                {fileInfo.env_file_exists ? '已存在' : '不存在（需新建）'}
              </Tag>
            </Space>
          </Descriptions.Item>
          {fileInfo.env_example_path && (
            <Descriptions.Item label=".env.example 模板">
              <CopyableText value={fileInfo.env_example_path} />
            </Descriptions.Item>
          )}
          <Descriptions.Item label="生效命令（开发）">
            <Text code style={{ wordBreak: 'break-all' }}>
              停止 uvicorn → 重新执行 start_mlearnweb.bat 或 systemctl restart
            </Text>
          </Descriptions.Item>
        </Descriptions>

        {/* mlearnweb 自有 deployment 配置 */}
        <div>
          <Text strong>mlearnweb 自有部署配置</Text>{' '}
          <Text type="secondary" style={{ fontSize: 12 }}>
            （本仓权威，改 .env 即可）
          </Text>
          <Table
            size="small"
            rowKey="key"
            pagination={false}
            style={{ marginTop: 8 }}
            dataSource={ownedRows}
            columns={[
              {
                title: '配置项',
                dataIndex: 'setting_key',
                render: (v) => <Text code>{v}</Text>,
                width: 220,
              },
              {
                title: '.env 变量名',
                dataIndex: 'env_var',
                render: (v) => <Text code>{v}</Text>,
                width: 220,
              },
              {
                title: '重启进程',
                dataIndex: 'restart',
                render: (v) => restartLabel(v),
                width: 140,
              },
              {
                title: '说明',
                dataIndex: 'hint',
                render: (v) => <Text type="secondary">{v}</Text>,
              },
            ]}
          />
        </div>

        {/* 远端挂载视图（这是用户最容易误解的部分，独立分组并强调权威源头） */}
        {remoteView.length > 0 && (
          <div>
            <Text strong>远端策略机产物的本地视图</Text>{' '}
            <Text type="secondary" style={{ fontSize: 12 }}>
              （权威配置在 vnpy_strategy_dev；mlearnweb 这边只是本机看到的路径）
            </Text>
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 8 }}
              message={
                <span>
                  下表字段不是 mlearnweb 「定义」的，而是 mlearnweb 作为<strong>读方</strong>看到这些远端文件的本地路径。
                  写方在 vnpy_strategy_dev 仓库；同机部署时填同样的绝对路径，跨机部署时填本机的 NFS/SMB 挂载点。
                  改这里只改读视图，不会改写方实际产出位置。
                </span>
              }
            />
            <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 12 }}>
              {remoteView.map(([key, m]) => (
                <Card key={key} size="small" type="inner">
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="mlearnweb 这边的 env 变量">
                      <Space size={4} wrap>
                        <Text code>{m.env_var}</Text>
                        {restartLabel(m.restart)}
                        <Tag color="orange">仅本地视图</Tag>
                      </Space>
                    </Descriptions.Item>
                    {m.source_of_truth && (
                      <>
                        <Descriptions.Item label="权威配置仓库">
                          <Text code>{m.source_of_truth.repo}</Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="写方（生产文件的进程）">
                          <Text code style={{ wordBreak: 'break-all' }}>
                            {m.source_of_truth.writer_path}
                          </Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="写方控制变量">
                          <Text code>{m.source_of_truth.writer_env}</Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="写方默认值">
                          <Text code>{m.source_of_truth.default_writer_value}</Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="说明">
                          <Text type="secondary">{m.source_of_truth.note}</Text>
                        </Descriptions.Item>
                      </>
                    )}
                  </Descriptions>
                </Card>
              ))}
            </Space>
          </div>
        )}
      </Space>
    </Card>
  )
}

const SettingsEnvPage = () => {
  const { data, isLoading, error, refetch, isFetching } = useQuery<EnvInfo>({
    queryKey: ['settings', 'env'],
    queryFn: fetchEnvInfo,
    staleTime: 60_000,
  })

  const fetchedAt = useMemo(
    () => (data ? new Date(data.fetched_at).toLocaleString() : ''),
    [data],
  )

  if (isLoading) {
    return (
      <PageContainer title="环境信息">
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin />
        </div>
      </PageContainer>
    )
  }

  if (error || !data) {
    return (
      <PageContainer
        title="环境信息"
        actions={
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            重试
          </Button>
        }
      >
        <Result
          status="error"
          title="加载环境信息失败"
          subTitle={String((error as Error)?.message ?? '请确认 /api/settings/env 已上线')}
        />
      </PageContainer>
    )
  }

  const overrides = data.runtime_overrides

  return (
    <PageContainer
      title="环境信息"
      subtitle={`取自 ${fetchedAt}`}
      actions={
        <Button icon={<ReloadOutlined />} onClick={() => refetch()} loading={isFetching}>
          刷新
        </Button>
      }
      alerts={
        <Alert
          type="info"
          showIcon
          message={
            <Space size={4} wrap>
              带
              <Tag color="green" icon={<ThunderboltOutlined />}>热改</Tag>
              的字段可在
              <Link to="/settings/runtime">运行期默认</Link>
              /
              <Link to="/settings/system">系统限制</Link>
              页面直接编辑保存即生效；带
              <Tag color="orange" icon={<WarningOutlined />}>需重启</Tag>
              的字段必须修改 .env 后重启对应进程。
            </Space>
          }
        />
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card title="Python 解释器" size="small">
          <Descriptions column={{ xxl: 2, xl: 2, lg: 2, md: 2, sm: 1, xs: 1 }} size="small">
            <Descriptions.Item label="可执行文件">
              <CopyableText value={data.python.executable} />
            </Descriptions.Item>
            <Descriptions.Item label="版本">{data.python.version}</Descriptions.Item>
            <Descriptions.Item label="实现">{data.python.implementation}</Descriptions.Item>
            <Descriptions.Item label="操作系统">
              {`${data.platform.system} ${data.platform.release} (${data.platform.machine})`}
            </Descriptions.Item>
            <Descriptions.Item label="主机名">{data.platform.node}</Descriptions.Item>
            <Descriptions.Item label="git">
              {data.git.sha ? (
                <Space size={4}>
                  <Tag color="blue">{data.git.branch ?? '?'}</Tag>
                  <Text code>{data.git.sha}</Text>
                </Space>
              ) : (
                <Text type="secondary">未知（非 git 仓库或 git 不可用）</Text>
              )}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="关键路径" size="small">
          <Descriptions column={1} size="small">
            <Descriptions.Item label={<Space size={4}>MLflow 存储 (mlruns_dir) <FieldExtra runtimeKey={null} overrides={overrides} /></Space>}>
              <CopyableText value={data.paths.mlruns_dir} />
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>SQLite (database_url) <FieldExtra runtimeKey={null} overrides={overrides} /></Space>}>
              <CopyableText value={data.paths.database_url} />
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>上传目录 (upload_dir) <FieldExtra runtimeKey={null} overrides={overrides} /></Space>}>
              <CopyableText value={data.paths.upload_dir} />
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>vnpy 节点配置 (vnpy_nodes_config_path) <FieldExtra runtimeKey={null} overrides={overrides} /></Space>}>
              <CopyableText value={data.paths.vnpy_nodes_config_path} />
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>日合并 parquet (daily_merged_root) <FieldExtra runtimeKey={null} overrides={overrides} /></Space>}>
              <CopyableText value={data.paths.daily_merged_root} />
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>ML 实盘输出根 (ml_live_output_root) <FieldExtra runtimeKey={null} overrides={overrides} /></Space>}>
              <CopyableText value={data.paths.ml_live_output_root} />
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="vnpy 实盘运行参数" size="small">
          <Descriptions column={{ xxl: 2, xl: 2, lg: 2, md: 1, sm: 1, xs: 1 }} size="small">
            <Descriptions.Item label={<Space size={4}>请求超时 <FieldExtra runtimeKey="vnpy_request_timeout" overrides={overrides} /></Space>}>
              {data.vnpy.request_timeout}s
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>轮询周期 <FieldExtra runtimeKey="vnpy_poll_interval_seconds" overrides={overrides} /></Space>}>
              {data.vnpy.poll_interval_seconds}s
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>快照保留 <FieldExtra runtimeKey="vnpy_snapshot_retention_days" overrides={overrides} /></Space>}>
              {data.vnpy.snapshot_retention_days} 天
            </Descriptions.Item>
            <Descriptions.Item label="运维口令已配置">
              {formatYesNo(data.vnpy.ops_password_set)}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Card
          title="vnpy 节点列表（来自 yaml 摘要，密码不展示）"
          size="small"
          extra={
            data.vnpy.nodes.error ? (
              <Tag color="red">解析错误：{data.vnpy.nodes.error}</Tag>
            ) : (
              <Tag color={data.vnpy.nodes.exists ? 'green' : 'default'}>
                {data.vnpy.nodes.exists ? '已加载' : '文件不存在'}
              </Tag>
            )
          }
        >
          {data.vnpy.nodes.nodes.length === 0 ? (
            <Text type="secondary">未配置任何节点</Text>
          ) : (
            <Descriptions column={1} size="small">
              {data.vnpy.nodes.nodes.map((n, i) => (
                <Descriptions.Item key={i} label={n.node_id ?? `节点 #${i + 1}`}>
                  <Space size={8} wrap>
                    <Text code>{n.base_url ?? '?'}</Text>
                    <Tag>{n.username ?? '?'}</Tag>
                    <Tag color={n.has_password ? 'green' : 'red'}>
                      {n.has_password ? '密码已配置' : '密码缺失'}
                    </Tag>
                    <Tag color={n.enabled ? 'blue' : 'default'}>
                      {n.enabled ? '启用' : '禁用'}
                    </Tag>
                    {n.mode && <Tag color="purple">{n.mode}</Tag>}
                  </Space>
                </Descriptions.Item>
              ))}
            </Descriptions>
          )}
        </Card>

        <Card title="上传与系统限制" size="small">
          <Descriptions column={{ xxl: 2, xl: 2, lg: 2, md: 1, sm: 1, xs: 1 }} size="small">
            <Descriptions.Item label={<Space size={4}>单图上限 <FieldExtra runtimeKey="max_image_size_mb" editTo="/settings/system" overrides={overrides} /></Space>}>
              {data.limits.max_image_size_mb} MB
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>允许扩展名 <FieldExtra runtimeKey="allowed_image_exts" editTo="/settings/system" overrides={overrides} /></Space>}>
              <Space size={4} wrap>
                {data.limits.allowed_image_exts.map((e) => (
                  <Tag key={e}>{e}</Tag>
                ))}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>孤儿宽限期 <FieldExtra runtimeKey="orphan_grace_seconds" editTo="/settings/system" overrides={overrides} /></Space>}>
              {data.limits.orphan_grace_seconds}s
            </Descriptions.Item>
            <Descriptions.Item label={<Space size={4}>部署同步周期 <FieldExtra runtimeKey="deployment_sync_interval_seconds" overrides={overrides} /></Space>}>
              {data.sync.deployment_sync_interval_seconds}s
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title={<Space size={4}>CORS 来源 <FieldExtra runtimeKey={null} overrides={overrides} /></Space>} size="small">
          <Space size={4} wrap>
            {data.cors_origins.map((o) => (
              <Tag key={o}>{o}</Tag>
            ))}
          </Space>
        </Card>

        <L1EditGuideCard data={data} />
      </Space>
    </PageContainer>
  )
}

export default SettingsEnvPage
