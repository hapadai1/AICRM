/**
 * 고객모드 - 스타일 컨설팅 딥플로우 (/c/:customerId/consulting). 설계서 01 §4 / plan_v2 flow.
 *
 * 선택 고객 1명의 주문 품목(aggregate orders[].items 재사용)을 optionStatus 배지와 함께 카드로.
 * - 각 품목 [옵션 진행] → /options/:orderItemId (기존 OptionStagePage).
 * 목록 화면으로는 이동하지 않고 단건 편집기로만 딥링크한다(고객모드 원칙).
 * 결제성 금액은 표시하지 않는다(D6).
 */
import { ArrowLeftOutlined, ArrowRightOutlined, SkinOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Empty, Flex, Space, Spin, Steps, Tag, Typography } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchCustomer } from '../../api/customers';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf, OPTION_STATUS_META, ORDER_ITEM_STATUS_META } from '../contracts/labels';

export function CustomerModeConsultingPage() {
  const { customerId = '' } = useParams();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['customer-mode', 'customer', customerId],
    queryFn: () => fetchCustomer(customerId),
    enabled: !!customerId,
  });

  const customer = data?.customer;
  const orders = data?.orders ?? [];
  const hasItems = orders.some((o) => o.items.length > 0);

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
          {customer?.name ?? '고객'} · 스타일 컨설팅
        </Typography.Title>
        <Steps
          size="small"
          current={1}
          items={[{ title: '계약서' }, { title: '스타일 컨설팅' }, { title: '채촌' }]}
        />
      </Card>

      {!hasItems ? (
        <Card>
          <Empty description="컨설팅할 주문 품목이 없습니다. 먼저 계약서를 작성하세요." />
        </Card>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {orders
            .filter((o) => o.items.length > 0)
            .map((o) => (
              <Card
                key={o.id}
                size="small"
                title={
                  <Space>
                    <Typography.Text strong>{o.orderNo}</Typography.Text>
                    <Tag color={o.transactionType === 'RENTAL' ? 'purple' : 'blue'}>
                      {o.transactionType === 'RENTAL' ? '렌탈' : '맞춤'}
                    </Tag>
                  </Space>
                }
              >
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  {o.items.map((item) => {
                    const opt = metaOf(OPTION_STATUS_META, item.optionStatus);
                    const st = metaOf(ORDER_ITEM_STATUS_META, item.status);
                    return (
                      <Flex key={item.id} justify="space-between" align="center" wrap gap={8}>
                        <Space size={8}>
                          <SkinOutlined />
                          <Typography.Text strong>{item.displayName}</Typography.Text>
                          <StatusBadge label={`옵션 ${opt.label}`} color={opt.color} />
                          <StatusBadge label={st.label} color={st.color} />
                        </Space>
                        <Button type="link" onClick={() => navigate(`/options/${item.id}`)}>
                          옵션 진행 <ArrowRightOutlined />
                        </Button>
                      </Flex>
                    );
                  })}
                </Space>
              </Card>
            ))}
        </Space>
      )}

      <Flex justify="space-between" style={{ marginTop: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/c/${customerId}/contract`)}>
          이전: 계약서
        </Button>
        <Button type="primary" onClick={() => navigate(`/c/${customerId}/measurement`)}>
          다음: 채촌 <ArrowRightOutlined />
        </Button>
      </Flex>
    </div>
  );
}
