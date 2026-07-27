/**
 * 고객모드 - 스타일 컨설팅 (/c/:customerId/consulting).
 * 기존 스타일 컨설팅 진행 테이블(OptionProgressListPage)을 고객의 계약들로 필터해 임베드한다.
 * 행 클릭 → 기존 계약 스타일 컨설팅 화면(/contracts/:id/options).
 */
import { useQuery } from '@tanstack/react-query';
import { Spin, Typography } from 'antd';
import { useParams } from 'react-router-dom';
import { fetchCustomer } from '../../api/customers';
import { OptionProgressListPage } from '../options/OptionProgressListPage';

export function CustomerModeConsultingPage() {
  const { customerId = '' } = useParams();

  const { data, isLoading } = useQuery({
    queryKey: ['customer-mode', 'customer', customerId],
    queryFn: () => fetchCustomer(customerId),
    enabled: !!customerId,
  });

  const contractIds = (data?.contracts ?? []).map((c) => c.id);

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 12 }}>
        {data?.customer?.name ?? '고객'} · 스타일 컨설팅
      </Typography.Title>
      <OptionProgressListPage contractIds={contractIds} embedded />
    </div>
  );
}
