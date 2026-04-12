import React from 'react'
import { Modal, Descriptions, Typography, Tag, Spin, Empty } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { factorDocService } from '@/services/factorDocService'

interface FactorInfoModalProps {
  visible: boolean
  factorName: string | null
  onClose: () => void
}

export const FactorInfoModal: React.FC<FactorInfoModalProps> = ({ visible, factorName, onClose }) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['factor-doc', factorName],
    queryFn: () => factorDocService.getFactorDetail(factorName!),
    enabled: !!factorName && visible,
    staleTime: 10 * 60 * 1000,
  })

  const factor = data?.data

  return (
    <Modal
      title={
        <span>
          因子详情
          {factorName && (
            <Typography.Text code style={{ marginLeft: 8, fontSize: 14 }}>
              {factorName}
            </Typography.Text>
          )}
        </span>
      }
      open={visible}
      onCancel={onClose}
      footer={null}
      width={600}
      destroyOnClose
    >
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : error ? (
        <Empty description="加载因子信息失败" />
      ) : factor ? (
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="因子名称">
            <Typography.Text strong code>
              {factor.name}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="分类">
            <Tag color="blue">{factor.category}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="表达式">
            <Typography.Text
              code
              style={{
                fontSize: 13,
                wordBreak: 'break-all',
                whiteSpace: 'pre-wrap',
              }}
            >
              {factor.expression}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="说明">
            <Typography.Text style={{ fontSize: 13 }}>{factor.description}</Typography.Text>
          </Descriptions.Item>
        </Descriptions>
      ) : (
        <Empty description="未找到因子信息" />
      )}
    </Modal>
  )
}
