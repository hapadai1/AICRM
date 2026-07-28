/**
 * 고객모드 - 계약서 (/c/:customerId/contract).
 * 기존 계약 목록 테이블(ContractListPage)을 고객 1명으로 필터해 임베드한다.
 * 행 클릭 → 기존 계약 상세(/contracts/:id), [새 계약서] → /contracts/new?customerId.
 */
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Flex, Spin, Typography } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchCustomer } from '../../api/customers';
import { ContractListPage } from '../contracts/ContractListPage';

export function CustomerModeContractPage() {
  const { customerId = '' } = useParams();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['customer-mode', 'customer', customerId],
    queryFn: () => fetchCustomer(customerId),
    enabled: !!customerId,
  });

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {data?.customer?.name ?? '고객'} · 계약서
        </Typography.Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate(`/contracts/new?customerId=${customerId}`)}
        >
          새 계약서
        </Button>
      </Flex>
      <ContractListPage customerId={customerId} embedded />
    </div>
  );
}
