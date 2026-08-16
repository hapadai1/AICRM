/**
 * 제작 발주 팝업 (2026-08-05 현업 확정, 2026-08-16 두 엑셀 분리 관리 개편).
 *
 * 전에는 [발주]가 상태만 바꾸는 버튼이었고, 작업지시서는 같은 줄의 다른 팝업, 채촌은 그 팝업
 * 안의 [바로가기] 링크였다. 발주는 "이 치수로 이 옷을 만들어 달라"고 공장에 넘기는 일인데
 * 셋이 따로 놀아, 무엇을 보고 발주했는지가 화면에 남지 않았다.
 *
 * 그래서 **작업지시서를 이 창에서 그대로 보고 발주한다.** 공장에 나갈 서류가 곧 발주 내용이라,
 * 확인과 결재를 다른 창으로 나눌 이유가 없다.
 *
 * 이 창은 두 엑셀을 관리한다 (2026-08-16 현업 확정):
 * - **작업지시서**: 시스템이 만든다. 발주 전에는 그때 값으로 즉석 생성해 보여 주고, 발주하면
 *   그 시점 엑셀을 고정한다. 이후 수정·재생성은 없다 → 미리보기·다운로드·출력(인쇄)만.
 * - **최종 작업지시서**: 사용자가 작업지시서를 받아 손으로 고쳐 올린 파일 → 위 기능에 업로드·삭제가 는다.
 */
import { useState } from 'react';
import {
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  PrinterOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Modal, Radio, Space, Spin, Tag, Tooltip, Typography, Upload } from 'antd';
import type { RcFile } from 'antd/es/upload';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { linkOrderItemMeasurement } from '../../api/measurements';
import type { ProductionItem } from '../../api/production';
import {
  downloadFinalWorkOrderFile,
  downloadSystemWorkOrderFile,
  fetchUploadedWorkOrderPreview,
  fetchWorkOrderFormPreview,
  fetchWorkOrderPreview,
  openFinalWorkOrderFile,
  removeWorkOrderFinalFile,
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

const IFRAME_STYLE = {
  width: '100%',
  height: '52vh',
  border: '1px solid #d9d9d9',
  borderRadius: 4,
  background: '#fff',
} as const;

/** HTML을 새 창에 띄우고 인쇄 대화상자를 연다 — 도식·이미지 로딩을 기다렸다가 찍는다. */
function printHtmlDocument(html: string) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  let printed = false;
  const fire = () => {
    if (printed) return;
    printed = true;
    win.focus();
    win.print();
  };
  win.onload = fire;
  // onload가 이미 지났거나 뜨지 않는 경우 대비
  setTimeout(fire, 800);
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
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  /*
    아래 미리보기 영역에 무엇을 그릴지. 'system' = 시스템 작업지시서(양식 HTML),
    'final' = 올린 최종본(업로드 xlsx를 그린 HTML), null = 접음.
    서류를 확인하고 내는 창이라 기본은 시스템 서류를 펼쳐 둔다.
  */
  const [preview, setPreview] = useState<'system' | 'final' | null>('system');

  const wo = item.workOrder;

  const previewQuery = useQuery({
    queryKey: ['workorders', 'preview', item.orderItemId],
    queryFn: () => fetchWorkOrderPreview(item.orderItemId),
    enabled: open,
  });
  const previewData = previewQuery.data;
  const printable = previewData?.printable ?? item.workOrder.canIssue;

  /*
    파일 상태는 서버 최신값(previewQuery)을 신뢰한다. item prop은 팝업을 열 때의 스냅샷이라
    업로드/삭제해도 그대로여서 화면이 안 바뀐다(파일명이 남는다). previewData가 오면 그것을
    authoritative로 쓰고, 아직 못 받았을 때만 스냅샷으로 대체한다.
  */
  const workOrderId = previewData ? previewData.workOrderId : item.workOrder.workOrderId;
  const uploadedFileName = previewData
    ? previewData.uploadedFileName
    : item.workOrder.uploadedFileName;
  const docStatus = previewData ? previewData.docStatus : item.workOrder.docStatus;
  const lastIssuedAt = previewData ? previewData.lastIssuedAt : item.workOrder.lastIssuedAt;

  /*
    출력물과 **같은 워크북**을 백엔드가 HTML로 그려 준다. 서식이 섞인 완결형 문서라
    페이지 CSS와 섞이지 않게 iframe(srcdoc)에 격리한다 — 미리 본 것과 내려받은 것이 같다.
  */
  const formQuery = useQuery({
    queryKey: ['workorders', 'form-preview', item.orderItemId, null],
    queryFn: () => fetchWorkOrderFormPreview(item.orderItemId),
    enabled: open && printable,
  });

  /* 최종본(업로드 xlsx) 미리보기 — 펼칠 때만 불러온다. PDF 등은 renderable:false로 온다. */
  const finalPreviewQuery = useQuery({
    queryKey: ['workorders', 'uploaded-preview', workOrderId],
    queryFn: () => fetchUploadedWorkOrderPreview(workOrderId as string),
    enabled: open && preview === 'final' && !!workOrderId && !!uploadedFileName,
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
    수기 최종본 — 시스템이 뽑아 준 Excel을 받아 손으로 고쳐 올린 파일 (현업 확정 2026-08-05).
    작업지시서와 별개의 엑셀로 관리한다. 올라와 있으면 최종 다운로드/미리보기/인쇄가 이 파일을 쓴다.
  */
  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadWorkOrderFinalFile(workOrderId as string, file),
    onSuccess: async () => {
      message.success('최종본을 올렸습니다.');
      // preview(파일명 최신값)와 uploaded-preview까지 함께 갱신 — 둘 다 ['workorders'] 아래.
      await queryClient.invalidateQueries({ queryKey: ['workorders'] });
      await queryClient.invalidateQueries({ queryKey: ['production'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '업로드에 실패했습니다.'),
  });

  /* 잘못 올린 최종본 내리기 — 되돌리면 시스템 출력본이 다시 최종이 된다. */
  const deleteMutation = useMutation({
    mutationFn: () => removeWorkOrderFinalFile(workOrderId as string),
    onSuccess: async () => {
      message.success('최종본을 삭제했습니다.');
      setPreview((p) => (p === 'final' ? 'system' : p));
      // preview가 파일명을 내려주므로 여기까지 무효화해야 화면의 파일명이 사라진다.
      await queryClient.invalidateQueries({ queryKey: ['workorders'] });
      await queryClient.invalidateQueries({ queryKey: ['production'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '삭제에 실패했습니다.'),
  });

  const confirmDeleteFinal = () =>
    modal.confirm({
      title: '최종 작업지시서를 삭제할까요?',
      content: '올린 최종본을 내립니다. 시스템 출력본이 다시 최종이 됩니다.',
      okText: '삭제',
      okButtonProps: { danger: true },
      cancelText: '취소',
      onOk: () => deleteMutation.mutateAsync(),
    });

  /* 출력 = 인쇄 (2026-08-16). 미리보기와 같은 HTML을 새 창에 띄워 브라우저 인쇄를 연다. */
  const printSystemMutation = useMutation({
    mutationFn: () => fetchWorkOrderFormPreview(item.orderItemId),
    onSuccess: (data) => printHtmlDocument(data.html),
    onError: (e) => message.error(e instanceof ApiError ? e.message : '인쇄 준비에 실패했습니다.'),
  });
  const printFinalMutation = useMutation({
    mutationFn: () => fetchUploadedWorkOrderPreview(workOrderId as string),
    onSuccess: async (data) => {
      // 그릴 수 있으면 그 HTML을 인쇄하고, PDF 등은 새 탭에서 열어 거기서 인쇄한다.
      if (data.renderable && data.html) printHtmlDocument(data.html);
      else await openFinalWorkOrderFile(workOrderId as string);
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '인쇄 준비에 실패했습니다.'),
  });

  const current = previewData?.measurement;
  /* 값이 없는 채촌은 품목에 연결할 수 없다(서버가 거부한다) — 고를 수 없는 줄은 내지 않는다. */
  const candidates: WorkOrderMeasurementCandidate[] = (previewData?.measurementCandidates ?? []).filter(
    (c) => c.completed,
  );
  const canChange = previewData?.canChangeMeasurement ?? false;

  /** 발주를 막는 사유 — 버튼을 흐리게만 두면 왜 못 누르는지 알 수 없다. */
  const blockedReason = !previewData
    ? null
    : !previewData.optionConfirmed
      ? '스타일 컨설팅을 확정한 뒤 발주할 수 있습니다.'
      : !previewData.measurementCompleted
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
            done={!!previewData?.optionConfirmed}
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
            done={!!previewData?.measurementCompleted}
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

          {/* --- 작업지시서 (시스템 생성) — 미리보기·다운로드·출력(인쇄) ------------ */}
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
              {docStatus === 'COMPLETED'
                ? `완료${lastIssuedAt ? ` · ${lastIssuedAt.slice(0, 10)} 발주 고정` : ''}`
                : '작성중 — 발주 전이라 지금 값으로 그립니다'}
            </Typography.Text>
            <Space size={6} wrap>
              <Tooltip title={printable ? '' : blockedReason ?? ''}>
                <Button
                  type={preview === 'system' ? 'primary' : 'default'}
                  ghost={preview === 'system'}
                  icon={<EyeOutlined />}
                  disabled={!printable}
                  onClick={() => setPreview((p) => (p === 'system' ? null : 'system'))}
                >
                  미리보기
                </Button>
              </Tooltip>
              <Tooltip title={printable ? '' : blockedReason ?? ''}>
                <Button
                  icon={<DownloadOutlined />}
                  disabled={!printable}
                  onClick={() =>
                    void downloadSystemWorkOrderFile(
                      item.orderItemId,
                      `${item.customerName}_작업지시서.xlsx`,
                    )
                  }
                >
                  다운로드
                </Button>
              </Tooltip>
              <Tooltip title={printable ? '' : blockedReason ?? ''}>
                <Button
                  icon={<PrinterOutlined />}
                  disabled={!printable}
                  loading={printSystemMutation.isPending}
                  onClick={() => printSystemMutation.mutate()}
                >
                  출력
                </Button>
              </Tooltip>
            </Space>
          </div>

          {/* --- 최종 작업지시서 — 손으로 고쳐 올린 그 파일 (업로드·삭제가 는다) ------ */}
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
            <Typography.Text type={uploadedFileName ? undefined : 'secondary'} style={{ flex: 1 }}>
              {uploadedFileName ?? '올린 파일 없음 — 시스템 출력본이 최종입니다'}
            </Typography.Text>
            <Space size={6} wrap>
              <Button
                type={preview === 'final' ? 'primary' : 'default'}
                ghost={preview === 'final'}
                icon={<EyeOutlined />}
                disabled={!uploadedFileName}
                onClick={() => setPreview((p) => (p === 'final' ? null : 'final'))}
              >
                미리보기
              </Button>
              <Tooltip title={workOrderId ? '' : '발주 후 최종본을 올릴 수 있습니다.'}>
                <Upload
                  accept=".xlsx,.pdf"
                  showUploadList={false}
                  disabled={!workOrderId}
                  beforeUpload={(file: RcFile) => {
                    uploadMutation.mutate(file);
                    return false;
                  }}
                >
                  <Button
                    icon={<UploadOutlined />}
                    loading={uploadMutation.isPending}
                    disabled={!workOrderId}
                  >
                    {uploadedFileName ? '수정' : '업로드'}
                  </Button>
                </Upload>
              </Tooltip>
              <Button
                icon={<DownloadOutlined />}
                disabled={!uploadedFileName}
                onClick={() =>
                  void downloadFinalWorkOrderFile(
                    workOrderId as string,
                    uploadedFileName as string,
                  )
                }
              >
                다운로드
              </Button>
              <Button
                icon={<PrinterOutlined />}
                disabled={!uploadedFileName}
                loading={printFinalMutation.isPending}
                onClick={() => printFinalMutation.mutate()}
              >
                출력
              </Button>
              <Button
                icon={<DeleteOutlined />}
                danger
                disabled={!uploadedFileName}
                loading={deleteMutation.isPending}
                onClick={confirmDeleteFinal}
              >
                삭제
              </Button>
            </Space>
          </div>

          <div style={{ marginTop: 8 }}>
            {preview === 'final' ? (
              finalPreviewQuery.isLoading ? (
                <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />
              ) : finalPreviewQuery.error ? (
                <Alert
                  type="error"
                  showIcon
                  message="최종본을 불러오지 못했습니다."
                  description={(finalPreviewQuery.error as Error).message}
                />
              ) : finalPreviewQuery.data?.renderable ? (
                <iframe
                  title="최종 작업지시서"
                  srcDoc={finalPreviewQuery.data.html ?? ''}
                  style={IFRAME_STYLE}
                />
              ) : (
                <Alert
                  type="info"
                  showIcon
                  message="이 최종본은 팝업 미리보기를 지원하지 않는 형식입니다(PDF 등)."
                  action={
                    <Button
                      size="small"
                      onClick={() => void openFinalWorkOrderFile(workOrderId as string)}
                    >
                      새 탭에서 열기
                    </Button>
                  }
                />
              )
            ) : preview === 'system' ? (
              !printable ? (
                <Alert
                  type="info"
                  showIcon
                  message={blockedReason ?? '준비가 끝나면 작업지시서를 볼 수 있습니다.'}
                />
              ) : formQuery.isLoading ? (
                <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />
              ) : formQuery.error ? (
                <Alert
                  type="error"
                  showIcon
                  message="작업지시서를 불러오지 못했습니다."
                  description={(formQuery.error as Error).message}
                />
              ) : (
                <iframe title="작업지시서" srcDoc={formQuery.data?.html ?? ''} style={IFRAME_STYLE} />
              )
            ) : null}
          </div>
        </>
      )}
    </Modal>
  );
}
