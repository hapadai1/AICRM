/**
 * 고객모드 - 채촌 딥플로우 (/c/:customerId/measurement). 설계서 01 §4 / plan_v2 flow.
 *
 * 선택 고객 1명의 채촌 기록(aggregate measurements 재사용)을 카드로 보여주는 허브.
 * - [새 채촌] → /measurements/new?customerId (기존 MeasurementEditPage가 customerId 프리필 지원).
 * - 각 기록 [열기] → /measurements/:id (기존 편집기).
 * 목록 화면(/measurements)으로는 이동하지 않고 단건 편집기로만 딥링크한다(고객모드 원칙).
 * 결제성 금액은 표시하지 않는다(D6).
 */
import { ArrowLeftOutlined, ArrowRightOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Empty, Flex, Space, Spin, Steps, Tag, Typography } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { MEASUREMENT_TYPE_LABELS } from '../../api/measurements';
import { fetchCustomer } from '../../api/customers';

export function CustomerModeMeasurementPage() {
  const { customerId = '' } = useParams();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['customer-mode', 'customer', customerId],
    queryFn: () => fetchCustomer(customerId),
    enabled: !!customerId,
  });

  const customer = data?.customer;
  const measurements = data?.measurements ?? [];

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Card style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          {customer?.name ?? '고객'} · 채촌
        </Typography.Title>
        <Steps
          size="small"
          current={2}
          items={[{ title: '계약서' }, { title: '스타일 컨설팅' }, { title: '채촌' }]}
        />
      </Card>

      <Flex justify="flex-end" style={{ marginBottom: 12 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate(`/measurements/new?customerId=${customerId}`)}
        >
          새 채촌
        </Button>
      </Flex>

      {measurements.length === 0 ? (
        <Card>
          <Empty description="채촌 기록이 없습니다" />
        </Card>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {measurements.map((m) => (
            <Card
              key={m.id}
              size="small"
              title={
                <Space>
                  <Typography.Text strong>{m.date}</Typography.Text>
                  <Tag color="green">{MEASUREMENT_TYPE_LABELS[m.type] ?? m.type}</Tag>
                </Space>
              }
              extra={
                <Button type="link" onClick={() => navigate(`/measurements/${m.id}`)}>
                  열기 <ArrowRightOutlined />
                </Button>
              }
            >
              <Flex justify="space-between" wrap gap={8}>
                <Typography.Text type="secondary">담당: {m.staffName || '-'}</Typography.Text>
                {m.usedByItems.length > 0 && (
                  <Space size={4} wrap>
                    {m.usedByItems.map((it, i) => (
                      <Tag key={`${it}-${i}`}>{it}</Tag>
                    ))}
                  </Space>
                )}
              </Flex>
            </Card>
          ))}
        </Space>
      )}

      <Flex justify="space-between" style={{ marginTop: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/c/${customerId}/consulting`)}>
          이전: 스타일 컨설팅
        </Button>
        <Button onClick={() => navigate(`/c/${customerId}`)}>진행 홈</Button>
      </Flex>
    </div>
  );
}
