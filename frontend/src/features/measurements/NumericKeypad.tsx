/**
 * 태블릿용 가상 숫자 키패드 (§3.3)
 * 0~9 · 소수점 · 지우기 · 이전 · 다음 · 완료 — 모든 버튼 높이 48px 이상.
 */
import { CheckOutlined, DeleteOutlined, DownOutlined, UpOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

interface NumericKeypadProps {
  onPress: (key: string) => void;
  onDelete: () => void;
  onPrev: () => void;
  onNext: () => void;
  onDone: () => void;
  disabled?: boolean;
}

const KEY_STYLE: CSSProperties = {
  height: 60,
  fontSize: 22,
  fontWeight: 600,
  width: '100%',
};

export function NumericKeypad({ onPress, onDelete, onPrev, onNext, onDone, disabled }: NumericKeypadProps) {
  const digit = (d: string): ReactNode => (
    <Button key={d} style={KEY_STYLE} disabled={disabled} onClick={() => onPress(d)}>
      {d}
    </Button>
  );

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 8,
      }}
    >
      {digit('7')}
      {digit('8')}
      {digit('9')}
      <Button style={{ ...KEY_STYLE, fontSize: 18 }} disabled={disabled} onClick={onDelete} icon={<DeleteOutlined />}>
        지우기
      </Button>

      {digit('4')}
      {digit('5')}
      {digit('6')}
      <Button style={{ ...KEY_STYLE, fontSize: 18 }} disabled={disabled} onClick={onPrev} icon={<UpOutlined />}>
        이전
      </Button>

      {digit('1')}
      {digit('2')}
      {digit('3')}
      <Button style={{ ...KEY_STYLE, fontSize: 18 }} disabled={disabled} onClick={onNext} icon={<DownOutlined />}>
        다음
      </Button>

      <div style={{ gridColumn: 'span 2' }}>{digit('0')}</div>
      {digit('.')}
      <Button
        type="primary"
        style={{ ...KEY_STYLE, fontSize: 18 }}
        disabled={disabled}
        onClick={onDone}
        icon={<CheckOutlined />}
      >
        완료
      </Button>
    </div>
  );
}
