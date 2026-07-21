import { Card, Empty, Typography } from 'antd';

interface PlaceholderPageProps {
  title: string;
  phase: number;
}

export function PlaceholderPage({ title, phase }: PlaceholderPageProps) {
  return (
    <Card>
      <Typography.Title level={4}>{title}</Typography.Title>
      <Empty description={`Phase ${phase}에서 구현 예정`} style={{ padding: '48px 0' }} />
    </Card>
  );
}
