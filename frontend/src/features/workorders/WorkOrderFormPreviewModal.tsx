/**
 * 작업지시서 양식 미리보기 모달 — 실제 출력 워크북을 그대로 그린 HTML을 띄운다.
 *
 * 백엔드가 출력 파일과 **같은 워크북**을 그려 주므로 미리 본 것과 내려받은 것이 어긋나지 않는다.
 * 서식이 섞인 완결형 HTML이라 페이지 CSS와 섞이지 않게 iframe(srcdoc)에 격리한다.
 * 도식(그림·빨간 동그라미·지시선)도 표 위에 겹쳐 그려 실제 양식과 같은 모습으로 보인다.
 */
import { DownloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Modal, Space, Spin, Typography } from 'antd';
import {
  fetchWorkOrderFormPreview,
  fetchWorkOrderVersionFormPreview,
  type WorkOrderFormPreview,
} from '../../api/workorders';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 출력 전 미리보기 — 현재 확정 옵션·채촌으로 그린다 */
  orderItemId?: string;
  /** 미리볼 채촌 버전 (미지정 시 품목에 연결된 채촌) */
  measurementSessionId?: string;
  /** 저장된 출력본 미리보기 — 주면 orderItemId보다 우선한다 */
  versionId?: string;
  title?: string;
  /** 모달 안에서 바로 받게 하려면 넘긴다 */
  onDownload?: () => void;
  downloading?: boolean;
}

export function WorkOrderFormPreviewModal({
  open,
  onClose,
  orderItemId,
  measurementSessionId,
  versionId,
  title,
  onDownload,
  downloading,
}: Props) {
  const query = useQuery<WorkOrderFormPreview>({
    queryKey: ['workorders', 'form-preview', versionId ?? orderItemId, measurementSessionId ?? null],
    queryFn: () =>
      versionId
        ? fetchWorkOrderVersionFormPreview(versionId)
        : fetchWorkOrderFormPreview(orderItemId ?? '', measurementSessionId),
    enabled: open && !!(versionId || orderItemId),
  });

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width="92vw"
      style={{ top: 24 }}
      title={title ?? '작업지시서 양식 미리보기'}
      footer={
        <Space>
          {onDownload && (
            <Button
              type="primary"
              size="large"
              icon={<DownloadOutlined />}
              loading={downloading}
              onClick={onDownload}
            >
              Excel 내려받기
            </Button>
          )}
          <Button size="large" onClick={onClose}>
            닫기
          </Button>
        </Space>
      }
    >
      {query.isLoading ? (
        <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />
      ) : query.error ? (
        <Alert
          type="error"
          showIcon
          message="양식 미리보기를 불러오지 못했습니다."
          description={(query.error as Error).message}
        />
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {versionId
              ? `저장된 출력본 V${query.data?.versionNo}`
              : `출력 시 V${query.data?.versionNo}로 생성됩니다`}
          </Typography.Text>
          <iframe
            title="작업지시서 양식"
            srcDoc={query.data?.html ?? ''}
            style={{ width: '100%', height: '72vh', border: '1px solid #d9d9d9', background: '#fff' }}
          />
        </Space>
      )}
    </Modal>
  );
}
