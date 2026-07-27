/**
 * 고객모드 - 진행상태 요약 홈 (/c/:customerId). 설계서 01 §4.2.
 *
 * 선택 고객 1명의 기본정보 + 계약/스타일컨설팅/채촌 진행상태 카드 3종을 보여준다.
 * 결제성 금액(수금·미수·잔금)은 표시하지 않는다(D6, 설계 §5). 계약 총액 등은 후속 계약 화면에서.
 * 진행상태 값 모델은 설계서 02를 따르며 여기서는 aggregate로부터 요약 표시만 한다(중복 설계 금지).
 * 각 카드/버튼은 해당 흐름 화면으로 이동한다(흐름 화면은 후속 에이전트가 구현).
 */
import { ArrowRightOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Descriptions, Row, Space, Spin, Tag, Typography } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchCustomer, type CustomerAggregate } from '../../api/customers';
import { maskPhone, useModeStore } from '../../app/mode-store';

interface StatusCardModel {
  key: string;
  title: string;
  label: string;
  color: string;
  /** 이동 경로 (후속 흐름 화면) */
  to: string;
}

const OPTION_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  NOT_STARTED: { label: '미시작', color: 'default' },
  IN_PROGRESS: { label: '진행중', color: 'blue' },
  REVIEW: { label: '검토', color: 'orange' },
  CONFIRMED: { label: '확정', color: 'green' },
};

function buildCards(customerId: string, agg?: CustomerAggregate): StatusCardModel[] {
  const contracts = agg?.contracts ?? [];
  const orderItems = (agg?.orders ?? []).flatMap((o) => o.items);
  const measurements = agg?.measurements ?? [];

  // 계약서
  const contractCard: StatusCardModel = {
    key: 'contract',
    title: '계약서',
    label: contracts.length === 0 ? '미작성' : `${contracts.length}건`,
    color: contracts.length === 0 ? 'default' : 'blue',
    to: `/c/${customerId}/contract`,
  };

  // 스타일 컨설팅 — 주문 품목의 optionStatus를 진행도순으로 요약
  const order = ['CONFIRMED', 'REVIEW', 'IN_PROGRESS', 'NOT_STARTED'];
  const best = orderItems
    .map((i) => i.optionStatus)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  const consultMeta = best ? OPTION_STATUS_LABEL[best] : { label: '미시작', color: 'default' };
  const consultCard: StatusCardModel = {
    key: 'consulting',
    title: '스타일 컨설팅',
    label: orderItems.length === 0 ? '미시작' : consultMeta.label,
    color: orderItems.length === 0 ? 'default' : consultMeta.color,
    to: `/c/${customerId}/consulting`,
  };

  // 채촌
  const measureCard: StatusCardModel = {
    key: 'measurement',
    title: '채촌',
    label: measurements.length === 0 ? '미시작' : `${measurements.length}회 기록`,
    color: measurements.length === 0 ? 'default' : 'green',
    to: `/c/${customerId}/measurement`,
  };

  return [contractCard, consultCard, measureCard];
}

export function CustomerModeHomePage() {
  const { customerId = '' } = useParams();
  const navigate = useNavigate();
  const clearSelectedCustomer = useModeStore((s) => s.clearSelectedCustomer);

  const { data, isLoading } = useQuery({
    queryKey: ['customer-mode', 'customer', customerId],
    queryFn: () => fetchCustomer(customerId),
    enabled: !!customerId,
  });

  const cards = buildCards(customerId, data);
  const customer = data?.customer;

  const backToSearch = () => {
    clearSelectedCustomer();
    navigate('/c');
  };

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
        <Descriptions
          title={
            <Typography.Title level={4} style={{ margin: 0 }}>
              {customer?.name ?? '고객'}
            </Typography.Title>
          }
          column={2}
          size="small"
        >
          <Descriptions.Item label="전화번호">{maskPhone(customer?.phone)}</Descriptions.Item>
          <Descriptions.Item label="상태">{customer?.customerStatus ?? '-'}</Descriptions.Item>
          {customer?.notes && (
            <Descriptions.Item label="메모" span={2}>
              {customer.notes}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Row gutter={16}>
        {cards.map((c) => (
          <Col xs={24} md={8} key={c.key} style={{ marginBottom: 16 }}>
            <Card
              title={c.title}
              extra={<Tag color={c.color}>{c.label}</Tag>}
              actions={[
                <Button key="open" type="link" onClick={() => navigate(c.to)}>
                  열기 <ArrowRightOutlined />
                </Button>,
              ]}
            >
              <Typography.Text type="secondary">{c.label}</Typography.Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Space style={{ marginTop: 8, justifyContent: 'space-between', width: '100%' }}>
        <Button icon={<SearchOutlined />} onClick={backToSearch}>
          고객 검색으로
        </Button>
        <Button type="primary" onClick={() => navigate(`/c/${customerId}/contract`)}>
          계약 작성 <ArrowRightOutlined />
        </Button>
      </Space>
    </div>
  );
}
