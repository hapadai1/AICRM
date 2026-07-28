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
      // 높이 56 · 글자 18px 이면 버튼 하나가 카드 한 장만큼 자리를 차지했다.
      // 위치(화면 하단 이동 영역)는 그대로 두고 크기만 보통 버튼으로 줄인다.
      icon={<ArrowLeftOutlined />}
      onClick={() => navigate(-1)}
      {...props}
    >
      이전화면
    </Button>
  );
}
