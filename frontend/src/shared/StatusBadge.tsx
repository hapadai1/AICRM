import { Badge } from 'antd';

interface StatusBadgeProps {
  label: string;
  color?: string;
}

/** 상태 텍스트에 색상 배지를 병기하는 컴포넌트 */
export function StatusBadge({ label, color = 'default' }: StatusBadgeProps) {
  return <Badge color={color} text={label} />;
}
