import { Card, Typography } from 'antd';
import { useAuthStore } from '../app/auth-store';

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);

  return (
    <Card>
      <Typography.Title level={4}>대시보드</Typography.Title>
      <Typography.Paragraph>
        {user?.displayName ?? '사용자'}님, 환영합니다. AICRM에 로그인되었습니다.
      </Typography.Paragraph>
      <Typography.Text type="secondary">
        좌측 메뉴에서 예약, 고객, 계약·주문 등 업무 메뉴를 선택해 주세요.
      </Typography.Text>
    </Card>
  );
}
