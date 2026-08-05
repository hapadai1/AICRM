/**
 * [동일 옵션 적용] 팝업 (2026-08-05 ContractOptionsPage에서 분리).
 * 같은 대분류의 다른 품목으로 선택값을 복사한다 — 대상 선택만 담당하고 실행은 페이지가 한다.
 */
import { Modal, Radio, Space, Typography } from 'antd';
import type { OptionProgressItem } from '../../api/options';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { OPTION_STATUS_META } from './option-meta';

export function CopyOptionsModal({
  source,
  targets,
  targetId,
  pending,
  onSelect,
  onCancel,
  onApply,
}: {
  source: OptionProgressItem | null;
  targets: OptionProgressItem[];
  targetId: string | null;
  pending: boolean;
  onSelect: (id: string) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <Modal
      title={`동일 옵션 적용 — ${source?.displayName ?? ''}`}
      open={!!source}
      onCancel={onCancel}
      okText="적용"
      cancelText="취소"
      okButtonProps={{ disabled: !targetId, loading: pending }}
      onOk={onApply}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text>
          선택값을 복사할 동일 대분류 품목을 선택하세요. 적용 후 개별 수정이 가능합니다.
        </Typography.Text>
        <Radio.Group
          value={targetId}
          onChange={(e) => onSelect(e.target.value as string)}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          {targets.map((t) => (
            <Radio key={t.contractItemId} value={t.contractItemId} style={{ minHeight: 40, alignItems: 'center' }}>
              <Space>
                <Typography.Text strong>{t.displayName}</Typography.Text>
                <StatusBadge
                  label={metaOf(OPTION_STATUS_META, t.status).label}
                  color={metaOf(OPTION_STATUS_META, t.status).color}
                />
              </Space>
            </Radio>
          ))}
        </Radio.Group>
      </Space>
    </Modal>
  );
}
