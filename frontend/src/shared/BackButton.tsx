import { ArrowLeftOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import type { ButtonProps } from 'antd';
import { useNavigate } from 'react-router-dom';

/**
 * 상세·편집 화면 하단에 두는 "이전화면" 복귀 버튼.
 *
 * 상세 화면에는 목록뿐 아니라 계약·품목 상세, 진행 현황 칸반 등
 * 여러 경로에서 들어온다. 목록으로 고정 이동하면 들어온 곳으로 못
 * 돌아가므로, 화면 이동은 뒤로가기(navigate(-1)) "이전화면"으로 통일한다.
 */
export function BackButton(props: ButtonProps) {
  const navigate = useNavigate();
  return (
    <Button
      size="large"
      icon={<ArrowLeftOutlined />}
      style={{ height: 56, minWidth: 140, fontSize: 18 }}
      onClick={() => navigate(-1)}
      {...props}
    >
      이전화면
    </Button>
  );
}
