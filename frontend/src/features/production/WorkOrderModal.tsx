/**
 * 작업지시서 팝업 (2026-08-04 현업 확정).
 *
 * 목록 줄에 출력·보기·엑셀 세 버튼이 늘어서 있어 품목 줄이 길었다. 가봉과 같은 방식으로
 * 버튼 하나를 열면 그 안에서 처리하게 모았다.
 *
 * 스타일 컨설팅·채촌은 **링크만** 둔다 — 확정 내용은 [보기](작업지시서 양식 미리보기)에서
 * 그 서류 그대로 보는 것이 맞고, 여기서 옮겨 적으면 두 곳이 어긋난다.
 */
import { DownloadOutlined, EyeOutlined, FileExcelOutlined } from '@ant-design/icons';
import { Button, Descriptions, Modal, Space, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { ProductionItem } from '../../api/production';
import { downloadWorkOrderVersionFile } from '../../api/workorders';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { WORK_ORDER_STATUS_META } from '../workorders/wo-meta';

interface WorkOrderModalProps {
  item: ProductionItem;
  open: boolean;
  onClose: () => void;
  /** [보기] — 작업지시서 양식 미리보기 (버전이 생기지 않는다) */
  onPreviewForm: () => void;
}

export function WorkOrderModal({ item, open, onClose, onPreviewForm }: WorkOrderModalProps) {
  const navigate = useNavigate();
  const wo = item.workOrder;
  const meta = metaOf(WORK_ORDER_STATUS_META, wo.status);

  return (
    <Modal
      title={`작업지시서 — ${item.customerName} · ${item.displayName}`}
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>닫기</Button>}
      width={560}
      destroyOnClose
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space size={6} wrap>
          <Tooltip title={wo.canIssue ? '' : '옵션 확정과 채촌 완료 후 출력할 수 있습니다.'}>
            <Button
              type="primary"
              ghost={wo.status !== 'CURRENT'}
              icon={<FileExcelOutlined />}
              disabled={!wo.canIssue}
              onClick={() => navigate(`/work-orders/${item.orderItemId}`)}
            >
              {wo.currentVersionNo ? '재출력' : '출력'}
            </Button>
          </Tooltip>
          <Tooltip title={wo.canIssue ? '' : '옵션 확정과 채촌 완료 후 볼 수 있습니다.'}>
            <Button icon={<EyeOutlined />} disabled={!wo.canIssue} onClick={onPreviewForm}>
              보기
            </Button>
          </Tooltip>
          <Tooltip title={wo.currentVersionId ? `최신 출력본 V${wo.currentVersionNo}` : '출력본이 없습니다.'}>
            <Button
              icon={<DownloadOutlined />}
              disabled={!wo.currentVersionId || !wo.currentFileName}
              onClick={() =>
                void downloadWorkOrderVersionFile(
                  wo.currentVersionId as string,
                  wo.currentFileName as string,
                )
              }
            >
              엑셀 다운로드
            </Button>
          </Tooltip>
        </Space>

        <Descriptions size="small" column={1} colon={false}>
          <Descriptions.Item label="상태">
            <Space size={6}>
              <StatusBadge label={meta.label} color={meta.color} />
              {wo.currentVersionNo ? (
                <Typography.Text type="secondary">V{wo.currentVersionNo}</Typography.Text>
              ) : null}
              {wo.lastIssuedAt ? (
                <Typography.Text type="secondary">{wo.lastIssuedAt}</Typography.Text>
              ) : null}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="스타일 컨설팅">
            <Space size={6}>
              <Typography.Text type={wo.optionConfirmedAt ? undefined : 'secondary'}>
                {wo.optionConfirmedAt?.slice(0, 10) ?? '미확정'}
              </Typography.Text>
              <Button size="small" onClick={() => navigate(`/contracts/${item.contractId}/options`)}>
                바로가기
              </Button>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="채촌">
            <Space size={6}>
              <Typography.Text type={wo.measurementLinkedAt ? undefined : 'secondary'}>
                {wo.measurementLinkedAt?.slice(0, 10) ?? '미연결'}
              </Typography.Text>
              <Button
                size="small"
                onClick={() => navigate(`/measurements?customerId=${item.customerId}`)}
              >
                바로가기
              </Button>
            </Space>
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </Modal>
  );
}
