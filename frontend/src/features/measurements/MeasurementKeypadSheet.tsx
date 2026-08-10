/**
 * 폰·세로 태블릿용 하단 고정 키패드 (2026-08-05 MeasurementEditPage에서 분리).
 * 좁은 폭에서는 오른쪽 키패드가 화면 밖으로 밀리므로 화면 하단에 고정해 띄운다 (현업 확정 2026-08-01).
 */
import { Button, Typography } from 'antd';
import { labelOf } from '../../shared/status-meta';
import { FIELD_LABELS } from './measurement-form';
import { NumericKeypad } from './NumericKeypad';

export function MeasurementKeypadSheet({
  activeKey,
  onPress,
  onDelete,
  onPrev,
  onNext,
  onClose,
}: {
  activeKey: string;
  onPress: (key: string) => void;
  onDelete: () => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        background: '#fff',
        borderTop: '1px solid #d9d9d9',
        boxShadow: '0 -4px 16px rgba(0, 0, 0, 0.12)',
        padding: '8px 12px calc(8px + env(safe-area-inset-bottom))',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <Typography.Text strong style={{ fontSize: 16 }}>
          입력 중: {labelOf(FIELD_LABELS, activeKey)}
        </Typography.Text>
        <Button size="small" onClick={onClose}>
          닫기
        </Button>
      </div>
      <NumericKeypad
        onPress={onPress}
        onDelete={onDelete}
        onPrev={onPrev}
        onNext={onNext}
        onDone={onClose}
      />
    </div>
  );
}
