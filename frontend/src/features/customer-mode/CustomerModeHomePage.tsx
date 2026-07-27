/**
 * 고객모드 - 진행상태 요약 홈 (/c/:customerId). 설계서 01 §4.2.
 *
 * 선택 고객 1명의 기본정보 + 기존 관리자 테이블 3종(계약 목록·스타일 컨설팅 진행·채촌 대상)을
 * 고객 1명으로 필터해 그대로 임베드한다(중복 UI 금지 — 기존 컴포넌트 재사용).
 * 각 표의 행 클릭/액션은 기존 관리자 단건 화면으로 이동한다(다른 고객 노출 없음).
 * 계약금액 등 금액은 기존 화면과 동일하게 노출한다(사용자 확정, 기존 D6 예외).
 */
import { ArrowRightOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Descriptions, Flex, Spin, Typography } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchCustomer } from '../../api/customers';
import { maskPhone, useModeStore } from '../../app/mode-store';
import { ContractListPage } from '../contracts/ContractListPage';
import { MeasurementListPage } from '../measurements/MeasurementListPage';
import { OptionProgressListPage } from '../options/OptionProgressListPage';

/** 섹션 래퍼 — 제목 + (선택)액션 버튼 + 기존 테이블 임베드 */
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {action}
      </Flex>
      {children}
    </div>
  );
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

  const customer = data?.customer;
  const contractIds = (data?.contracts ?? []).map((c) => c.id);

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
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
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

      <Section
        title="계약서"
        action={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate(`/contracts/new?customerId=${customerId}`)}
          >
            새 계약서
          </Button>
        }
      >
        <ContractListPage customerId={customerId} embedded />
      </Section>

      <Section title="스타일 컨설팅">
        <OptionProgressListPage contractIds={contractIds} embedded />
      </Section>

      <Section
        title="채촌"
        action={
          <Button
            icon={<PlusOutlined />}
            onClick={() => navigate(`/measurements/new?customerId=${customerId}`)}
          >
            새 채촌
          </Button>
        }
      >
        <MeasurementListPage customerId={customerId} embedded />
      </Section>

      <Flex justify="space-between" style={{ marginTop: 8 }}>
        <Button icon={<SearchOutlined />} onClick={backToSearch}>
          고객 검색으로
        </Button>
        <Button
          type="primary"
          onClick={() => navigate(`/contracts/new?customerId=${customerId}`)}
        >
          계약 작성 <ArrowRightOutlined />
        </Button>
      </Flex>
    </div>
  );
}
