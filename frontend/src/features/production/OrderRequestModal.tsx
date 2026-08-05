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
import {
  CheckCircleFilled,
  DownloadOutlined,
  EyeOutlined,
  FileExcelOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Modal, Radio, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { linkOrderItemMeasurement } from '../../api/measurements';
import type { ProductionItem } from '../../api/production';
import {
  downloadWorkOrderVersionFile,
  fetchWorkOrderFormPreview,
  fetchWorkOrderPreview,
  type WorkOrderMeasurementCandidate,
} from '../../api/workorders';
import { metaOf } from '../../shared/status-meta';
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

/**
 * 준비 한 줄 — `됐는지(아이콘) · 무엇(이름) · 상태 낱말 · 부가정보 · 가는 곳(버튼)`.
 * 다섯 칸의 x를 고정해 두 줄이 계단처럼 어긋나지 않게 한다.
 */
function PrepRow({
  label,
  done,
  detail,
  action,
  children,
}: {
  label: string;
  done: boolean;
  detail: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
        {done ? (
          <CheckCircleFilled style={{ color: '#52c41a', fontSize: 16 }} />
        ) : (
          <MinusCircleOutlined style={{ color: '#bfbfbf', fontSize: 16 }} />
        )}
        <Typography.Text style={{ width: 96, flexShrink: 0 }}>{label}</Typography.Text>
        <Typography.Text
          type={done ? undefined : 'secondary'}
          style={{ width: 48, flexShrink: 0 }}
          strong={done}
        >
          {done ? '완료' : '미완료'}
        </Typography.Text>
        <div style={{ flex: 1, minWidth: 0 }}>{detail}</div>
        {action}
      </div>
      {children}
    </>
  );
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

  const wo = item.workOrder;
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
              {wo.currentVersionNo
                ? `V${wo.currentVersionNo}${wo.lastIssuedAt ? ` · ${wo.lastIssuedAt.slice(0, 10)} 출력` : ''}`
                : formQuery.data
                  ? `발주하면 V${formQuery.data.versionNo}로 출력됩니다`
                  : ''}
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
                발주 전에는 출력 버튼을 내지 않는다 — [발주하기]가 출력까지 한다 (2026-08-05).
                발주 뒤 다시 뽑아야 할 때만 이 자리가 열린다.
              */}
              {!onRequest && (
                <Tooltip title={printable ? '' : blockedReason ?? ''}>
                  <Button
                    icon={<FileExcelOutlined />}
                    disabled={!printable}
                    onClick={() => navigate(`/work-orders/${item.orderItemId}`)}
                  >
                    재출력
                  </Button>
                </Tooltip>
              )}
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
                  다운로드
                </Button>
              </Tooltip>
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
