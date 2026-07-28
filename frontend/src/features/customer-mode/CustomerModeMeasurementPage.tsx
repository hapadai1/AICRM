/**
 * 고객모드 - 채촌 (/c/:customerId/measurement).
 * 기존 채촌 대상 테이블(MeasurementListPage)을 고객 1명으로 필터해 임베드한다.
 * [기록 보기] → /measurements/:id, [채촌]/[새 채촌] → /measurements/new?customerId.
 */
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Flex, Spin, Typography } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchCustomer } from '../../api/customers';
import { MeasurementListPage } from '../measurements/MeasurementListPage';

export function CustomerModeMeasurementPage() {
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
          {data?.customer?.name ?? '고객'} · 채촌
        </Typography.Title>
        <Button
          icon={<PlusOutlined />}
          onClick={() => navigate(`/measurements/new?customerId=${customerId}`)}
        >
          새 채촌
        </Button>
      </Flex>
      <MeasurementListPage customerId={customerId} embedded />
    </div>
  );
}
