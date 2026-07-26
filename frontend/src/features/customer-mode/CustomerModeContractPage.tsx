/**
 * 고객모드 - 계약서 딥플로우 (/c/:customerId/contract). 설계서 01 §4 / plan_v2 flow.
 *
 * 선택 고객 1명의 계약 목록(aggregate contracts 재사용, 목록 API 아님)만 카드로 보여주는 허브.
 * - [새 계약서 작성] → /contracts/new?customerId (기존 ContractFormPage가 customerId 프리필 지원).
 * - 각 계약 [열기] → /contracts/:id (기존 상세 = 서명·엑셀·문서 포함).
 * - 최신 계약은 ContractDocumentView를 임베드해 "최종 확인"으로 노출.
 * 목록 화면(/contracts)으로는 절대 이동하지 않는다(고객모드 원칙). 단건 편집기로만 딥링크.
 * 결제성 금액(수금·미수·잔금)은 표시하지 않는다(D6). 계약 총액은 확인용으로 노출한다.
 */
import { ArrowRightOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Empty, Flex, Space, Spin, Steps, Typography } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchCustomer, type CustomerContractRow } from '../../api/customers';
import { StatusBadge } from '../../shared/StatusBadge';
import { ContractDocumentView } from '../contracts/ContractDocumentView';
import { CONTRACT_STATUS_META, formatKrw, metaOf } from '../contracts/labels';

/** 최신(현재) 계약 선정: contractedAt 최댓값 → 없으면 목록 첫 건 */
function pickLatest(rows: CustomerContractRow[]): CustomerContractRow | undefined {
  if (rows.length === 0) return undefined;
  return [...rows].sort((a, b) => (b.contractedAt ?? '').localeCompare(a.contractedAt ?? ''))[0];
}

export function CustomerModeContractPage() {
  const { customerId = '' } = useParams();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['customer-mode', 'customer', customerId],
    queryFn: () => fetchCustomer(customerId),
    enabled: !!customerId,
  });

  const customer = data?.customer;
  const contracts = data?.contracts ?? [];
  const latest = pickLatest(contracts);

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
          {customer?.name ?? '고객'} · 계약서
        </Typography.Title>
        <Steps
          size="small"
          current={0}
          items={[{ title: '계약서' }, { title: '스타일 컨설팅' }, { title: '채촌' }]}
        />
      </Card>

      <Flex justify="flex-end" style={{ marginBottom: 12 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate(`/contracts/new?customerId=${customerId}`)}
        >
          새 계약서 작성
        </Button>
      </Flex>

      {contracts.length === 0 ? (
        <Card>
          <Empty description="작성된 계약이 없습니다" />
        </Card>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {contracts.map((c) => {
            const meta = metaOf(CONTRACT_STATUS_META, c.status);
            return (
              <Card
                key={c.id}
                size="small"
                title={
                  <Space>
                    <Typography.Text strong>{c.contractNo}</Typography.Text>
                    <StatusBadge label={meta.label} color={meta.color} />
                  </Space>
                }
                extra={
                  <Button type="link" onClick={() => navigate(`/contracts/${c.id}`)}>
                    열기 <ArrowRightOutlined />
                  </Button>
                }
              >
                <Flex justify="space-between" wrap gap={8}>
                  <Typography.Text type="secondary">
                    {c.contractTypeName ?? '유형 미지정'}
                    {c.currentVersionNo != null ? ` · V${c.currentVersionNo}` : ''}
                  </Typography.Text>
                  <Typography.Text>계약 총액 {formatKrw(c.totalAmount)}</Typography.Text>
                </Flex>
              </Card>
            );
          })}
        </Space>
      )}

      {latest && (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>최종 확인 · {latest.contractNo}</Typography.Title>
          <ContractDocumentView contractId={latest.id} />
        </div>
      )}

      <Flex justify="space-between" style={{ marginTop: 16 }}>
        <Button onClick={() => navigate(`/c/${customerId}`)}>진행 홈</Button>
        <Button type="primary" onClick={() => navigate(`/c/${customerId}/consulting`)}>
          다음: 스타일 컨설팅 <ArrowRightOutlined />
        </Button>
      </Flex>
    </div>
  );
}
