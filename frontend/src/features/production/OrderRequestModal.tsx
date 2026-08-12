/**
 * 제작 발주 팝업 (2026-08-05 현업 확정).
 *
 * 전에는 [발주]가 상태만 바꾸는 버튼이었고, 작업지시서는 같은 줄의 다른 팝업, 채촌은 그 팝업
 * 안의 [바로가기] 링크였다. 발주는 "이 치수로 이 옷을 만들어 달라"고 공장에 넘기는 일인데
 * 셋이 따로 놀아, 무엇을 보고 발주했는지가 화면에 남지 않았다.
 *
 * 그래서 **작업지시서를 이 창에서 그대로 보고 발주한다.** 공장에 나갈 서류가 곧 발주 내용이라,
 * 확인과 결재를 다른 창으로 나눌 이유가 없다. 채촌은 백엔드가 최신 스타일 컨설팅 채촌을
 * 골라 두므로(measurementAutoSelected) 다른 것을 쓸 때만 [변경]을 편다.
 */
import { useState } from 'react';
import { DownloadOutlined, EyeOutlined, FileExcelOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Modal, Radio, Space, Spin, Tag, Tooltip, Typography, Upload } from 'antd';
import type { RcFile } from 'antd/es/upload';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { linkOrderItemMeasurement } from '../../api/measurements';
import type { ProductionItem } from '../../api/production';
import {
  downloadWorkOrderFile,
  fetchWorkOrderFormPreview,
  fetchWorkOrderPreview,
  issueWorkOrder,
  openWorkOrderFile,
  uploadWorkOrderFinalFile,
  type WorkOrderMeasurementCandidate,
} from '../../api/workorders';
import { metaOf } from '../../shared/status-meta';
import { PrepRow } from './PrepRow';
import { MEASUREMENT_TYPE_META } from '../workorders/wo-meta';

interface OrderRequestModalProps {
  item: ProductionItem;
  open: boolean;
  onClose: () => void;
  /**
   * [발주하기] — 품목 상태 전이와 진행 단계 완료는 호출한 쪽(제작 흐름 카드)이 한다.
   * 이미 발주한 품목이면 넘기지 않는다. 그때 이 창은 서류를 다시 보는 자리다.
   */
  onRequest?: () => void;
  requesting?: boolean;
}

/** 채촌 한 줄 표기 — 구분 뱃지 + 채촌일. 현재 선택과 후보 목록이 같은 모양을 쓴다. */
function MeasurementLine({
  measurementType,
  measurementDate,
}: {
  measurementType: string;
  measurementDate: string;
}) {
  const meta = metaOf(MEASUREMENT_TYPE_META, measurementType);
  return (
    <Space size={6} wrap>
      <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
        {meta.label}
      </Tag>
      <Typography.Text>{measurementDate}</Typography.Text>
    </Space>
  );
}

export function OrderRequestModal({
  item,
  open,
  onClose,
  onRequest,
  requesting,
}: OrderRequestModalProps) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  // 서류는 펼친 채로 연다 — 확인하고 내는 창이라 한 번 더 누르게 할 이유가 없다. [보기]로 접는다.
  const [showForm, setShowForm] = useState(true);

  const wo = item.workOrder;

  const previewQuery = useQuery({
    queryKey: ['workorders', 'preview', item.orderItemId],
    queryFn: () => fetchWorkOrderPreview(item.orderItemId),
    enabled: open,
  });
  const preview = previewQuery.data;
  const printable = preview?.printable ?? item.workOrder.canIssue;

  /*
    출력물과 **같은 워크북**을 백엔드가 HTML로 그려 준다. 서식이 섞인 완결형 문서라
    페이지 CSS와 섞이지 않게 iframe(srcdoc)에 격리한다 — 미리 본 것과 내려받은 것이 같다.
  */
  const formQuery = useQuery({
    queryKey: ['workorders', 'form-preview', item.orderItemId, null],
    queryFn: () => fetchWorkOrderFormPreview(item.orderItemId),
    enabled: open && printable,
  });

  const pickMutation = useMutation({
    mutationFn: (sessionId: string) => linkOrderItemMeasurement(item.orderItemId, sessionId),
    onSuccess: async () => {
      message.success('이 품목에 쓸 채촌을 바꿨습니다.');
      setPicking(false);
      // 서류도 새 채촌으로 다시 그려야 한다 — 확인하고 내는 창이라 여기서 어긋나면 안 된다.
      await queryClient.invalidateQueries({ queryKey: ['workorders'] });
      await queryClient.invalidateQueries({ queryKey: ['production'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '채촌을 연결하지 못했습니다.'),
  });

  /*
    수기 최종본 — 시스템이 뽑아 준 Excel을 손으로 고쳐 공장에 보낸 파일 (현업 확정 2026-08-05).
    시스템은 열어 보지 않고 **보관만** 한다. 올라와 있으면 [다운로드]가 이 파일을 준다.
  */
  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadWorkOrderFinalFile(wo.workOrderId as string, file),
    onSuccess: async () => {
      message.success('최종본을 올렸습니다.');
      await queryClient.invalidateQueries({ queryKey: ['production'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '업로드에 실패했습니다.'),
  });

  /* [출력] — 그 자리에서 파일을 만든다. 다시 뽑으면 덮어쓴다 (2026-08-05). */
  const issueMutation = useMutation({
    mutationFn: () => issueWorkOrder(item.orderItemId, {}),
    onSuccess: async (res) => {
      message.success('작업지시서를 출력했습니다.');
      await downloadWorkOrderFile(res.workOrderId, res.file.fileName);
      await queryClient.invalidateQueries({ queryKey: ['production'] });
      await queryClient.invalidateQueries({ queryKey: ['workorders'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '출력에 실패했습니다.'),
  });

  const current = preview?.measurement;
  /* 값이 없는 채촌은 품목에 연결할 수 없다(서버가 거부한다) — 고를 수 없는 줄은 내지 않는다. */
  const candidates: WorkOrderMeasurementCandidate[] = (preview?.measurementCandidates ?? []).filter(
    (c) => c.completed,
  );
  const canChange = preview?.canChangeMeasurement ?? false;

  /** 발주를 막는 사유 — 버튼을 흐리게만 두면 왜 못 누르는지 알 수 없다. */
  const blockedReason = !preview
    ? null
    : !preview.optionConfirmed
      ? '스타일 컨설팅을 확정한 뒤 발주할 수 있습니다.'
      : !preview.measurementCompleted
        ? '완료된 채촌이 있어야 발주할 수 있습니다.'
        : null;

  return (
    <Modal
      title={
        <Space size={8}>
          <span>{onRequest ? '제작 발주' : '작업지시서'}</span>
          <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
            {item.customerName} · {item.displayName}
          </Typography.Text>
        </Space>
      }
      open={open}
      onCancel={onClose}
      /*
        폭은 작업지시서 양식에 맞춘다 — 넓게 잡았더니 서류 오른쪽이 텅 비어 보였다
        (2026-08-05 현업 지적). 양식이 더 넓은 품목은 iframe 안에서 가로로 스크롤한다.
      */
      width={1120}
      style={{ top: 24 }}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>닫기</Button>
          {onRequest && (
            <Tooltip title={blockedReason ?? ''}>
              <Button
                type="primary"
                loading={requesting}
                disabled={!!blockedReason || previewQuery.isLoading}
                onClick={onRequest}
              >
                발주하기
              </Button>
            </Tooltip>
          )}
        </Space>
      }
    >
      {previewQuery.isLoading ? (
        <Spin style={{ display: 'block', margin: '48px auto' }} />
      ) : (
        <>
          <PrepRow
            label="스타일 컨설팅"
            done={!!preview?.optionConfirmed}
            detail={
              wo.optionConfirmedAt ? (
                <Typography.Text type="secondary">{wo.optionConfirmedAt.slice(0, 10)}</Typography.Text>
              ) : null
            }
            action={
              <Button onClick={() => navigate(`/contracts/${item.contractId}/options`)}>보기</Button>
            }
          />

          <PrepRow
            label="채촌"
            done={!!preview?.measurementCompleted}
            detail={
              current ? (
                <MeasurementLine
                  measurementType={current.measurementType}
                  measurementDate={current.measurementDate}
                />
              ) : (
                <Typography.Text type="secondary">쓸 수 있는 채촌이 없습니다.</Typography.Text>
              )
            }
            action={
              canChange && candidates.length > 0 ? (
                <Button onClick={() => setPicking((v) => !v)}>{picking ? '접기' : '변경'}</Button>
              ) : undefined
            }
          >
            {picking && (
              <div
                style={{
                  margin: '2px 0 10px 122px',
                  padding: 12,
                  background: '#fafafa',
                  borderRadius: 6,
                }}
              >
                <Radio.Group
                  value={current?.measurementSessionId}
                  onChange={(e) => pickMutation.mutate(e.target.value as string)}
                  disabled={pickMutation.isPending}
                  style={{ width: '100%' }}
                >
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {candidates.map((c) => (
                      <Radio key={c.measurementSessionId} value={c.measurementSessionId}>
                        <MeasurementLine
                          measurementType={c.measurementType}
                          measurementDate={c.measurementDate}
                        />
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
              </div>
            )}
          </PrepRow>

          {/* --- 공장에 나갈 서류 그대로 -------------------------------------- */}
          <div
            style={{
              marginTop: 14,
              paddingTop: 10,
              borderTop: '1px solid #f0f0f0',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Typography.Text strong>작업지시서</Typography.Text>
            <Typography.Text type="secondary" style={{ flex: 1 }}>
              {wo.docStatus === 'COMPLETED'
                ? `완료${wo.lastIssuedAt ? ` · ${wo.lastIssuedAt.slice(0, 10)} 출력` : ''}`
                : '작성중 — 발주하면 완료가 됩니다'}

            </Typography.Text>
            <Space size={6} wrap>
              <Tooltip title={printable ? '' : blockedReason ?? ''}>
                <Button
                  type={showForm ? 'primary' : 'default'}
                  ghost={showForm}
                  icon={<EyeOutlined />}
                  disabled={!printable}
                  onClick={() => setShowForm((v) => !v)}
                >
                  {showForm ? '접기' : '보기'}
                </Button>
              </Tooltip>
              {/*
                준비가 끝났으면 언제든 뽑을 수 있다 — [발주하기]가 출력까지 하지만,
                미리 뽑아 보거나 다시 뽑는 길을 막을 이유는 없다 (2026-08-05 현업 지적).
              */}
              <Tooltip title={printable ? '' : blockedReason ?? ''}>
                <Button
                  icon={<FileExcelOutlined />}
                  disabled={!printable}
                  loading={issueMutation.isPending}
                  onClick={() => issueMutation.mutate()}
                >
                  {wo.workOrderFileKey ? '재출력' : '출력'}
                </Button>
              </Tooltip>
              <Tooltip title={wo.workOrderFileKey ? '' : '아직 뽑은 파일이 없습니다.'}>
                <Button
                  icon={<DownloadOutlined />}
                  disabled={!wo.workOrderFileKey || !wo.currentFileName}
                  onClick={() =>
                    void downloadWorkOrderFile(
                      wo.workOrderId as string,
                      wo.currentFileName as string,
                    )
                  }
                >
                  다운로드
                </Button>
              </Tooltip>
            </Space>
          </div>

          {/* --- 최종 작업지시서 — 손으로 고쳐 공장에 보낸 그 파일 -------------- */}
          <div
            style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: '1px solid #f5f5f5',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Typography.Text strong>최종 작업지시서</Typography.Text>
            <Typography.Text type={wo.uploadedFileName ? undefined : 'secondary'} style={{ flex: 1 }}>
              {wo.uploadedFileName ?? '올린 파일 없음 — 시스템 출력본이 최종입니다'}
            </Typography.Text>
            <Space size={6} wrap>
              <Upload
                accept=".xlsx,.pdf"
                showUploadList={false}
                beforeUpload={(file: RcFile) => {
                  uploadMutation.mutate(file);
                  return false;
                }}
              >
                <Button
                  icon={<UploadOutlined />}
                  loading={uploadMutation.isPending}
                >
                  {wo.uploadedFileName ? '교체' : '업로드'}
                </Button>
              </Upload>
              {/*
                업로드본은 시스템이 만든 워크북이 아니라 담당자가 올린 파일이라 창 안에 그릴 수 없다
                — 새 탭에서 연다(PDF는 보이고 엑셀은 브라우저가 받는다). 2026-08-05.
              */}
              <Button
                icon={<EyeOutlined />}
                disabled={!wo.uploadedFileName}
                onClick={() => void openWorkOrderFile(wo.workOrderId as string)}
              >
                보기
              </Button>
              <Button
                icon={<DownloadOutlined />}
                disabled={!wo.uploadedFileName}
                onClick={() =>
                  void downloadWorkOrderFile(
                    wo.workOrderId as string,
                    wo.currentFileName as string,
                  )
                }
              >
                다운로드
              </Button>
            </Space>
          </div>

          <div style={{ marginTop: 8 }}>
            {!printable ? (
              <Alert
                type="info"
                showIcon
                message={blockedReason ?? '준비가 끝나면 작업지시서를 볼 수 있습니다.'}
              />
            ) : !showForm ? null : formQuery.isLoading ? (
              <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />
            ) : formQuery.error ? (
              <Alert
                type="error"
                showIcon
                message="작업지시서를 불러오지 못했습니다."
                description={(formQuery.error as Error).message}
              />
            ) : (
              <iframe
                title="작업지시서"
                srcDoc={formQuery.data?.html ?? ''}
                style={{
                  width: '100%',
                  height: '52vh',
                  border: '1px solid #d9d9d9',
                  borderRadius: 4,
                  background: '#fff',
                }}
              />
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
