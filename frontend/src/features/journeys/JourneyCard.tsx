import {
  ArrowRightOutlined,
  CheckOutlined,
  FileTextOutlined,
  PhoneOutlined,
  PlusOutlined,
  ProfileOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { CustomerContractRow, CustomerOrderRow } from '../../api/customers';
import {
  cancelJourney,
  changeJourneyStage,
  completeJourney,
  completeStageItem,
  createJourney,
  fetchCustomerJourneys,
  fetchJourney,
  getStageItems,
  journeyStatusMeta,
  OUTCOME_META,
  repairStageReached,
  setNotificationOutcome,
  trackTypeLabel,
  TRACK_TYPES,
  uncompleteStageItem,
  type Journey,
  type JourneyEvent,
  type JourneyStageView,
  type StageItem,
  type TrackType,
} from '../../api/journeys';
import { PRODUCTION_STATUS_META } from '../../api/production';
import { repairStatusMeta } from '../../api/repairs';
import { useAuthStore } from '../../app/auth-store';
import { Can } from '../../shared/Can';
import { NotificationConfirmModal, type SendOutcome } from '../../shared/NotificationConfirmModal';
import { metaOf } from '../../shared/status-meta';

/**
 * 고객 상세 최상단 진행 단계 카드 (개발설계서 05 G-11).
 *
 * 단계는 한 번에 하나씩 "완료"하며, 완료할 때마다 기록(시각·담당자)이 남는다.
 * 건너뛰기는 허용하지 않는다 — 중간 단계에 완료 기록이 비지 않게 하기 위함이다.
 * 연락 단계에서는 [고객 연락]으로 발송하고, 마지막 연락 단계는 발송 시 진행이 자동 완료된다.
 * 실제 제작/입출고 처리는 각 작업 페이지에서 하고, 여기서는 그 페이지로 이동만 시킨다.
 */

/** 단계 코드 → 실제 작업 페이지 (버튼을 누르면 해당 건으로 필터해 이동) */
const WORK_ACTION: Record<string, { label: string; to: string }> = {
  BASTING_RECEIVED: { label: '입고 처리', to: '/production' },
  PRODUCT_RECEIVED: { label: '입고 처리', to: '/production' },
  RELEASED: { label: '출고 처리', to: '/production' },
  RENTAL_CHECKED_OUT: { label: '출고 처리', to: '/rentals/handover' },
  RENTAL_RETURNED: { label: '반납 처리', to: '/rentals/handover' },
};

/** 주문번호 링크를 붙일 단계들 (주문이 존재하는 이후 단계) */
const SHOW_ORDER_LINK = new Set([
  'ORDER_REQUESTED',
  'RENTAL_REQUESTED',
  'BASTING_RECEIVED',
  'FITTING_DONE',
  'PRODUCT_RECEIVED',
  'RELEASED',
  'RENTAL_CHECKED_OUT',
  'RENTAL_RETURNED',
]);

/**
 * 맞춤(CUSTOM) 트랙에서 품목별 입출고를 병렬 표시할 단계.
 * 진행단계는 제작 상태와 자동 연동되지 않으므로(수동 표시 레이어), 품목 status로 실제 부분 진행을 보여준다.
 */
const ITEM_PROGRESS_STAGE: Record<string, 'IN' | 'OUT'> = {
  PRODUCT_RECEIVED: 'IN', // 완성복 입고
  RELEASED: 'OUT', // 완성복 출고/완료
};
/** '입고완료'로 집계할 품목 상태 (부분출고·출고는 이미 전체 입고된 것). */
const ITEM_RECEIVED_STATUSES = new Set(['RECEIVED', 'PARTIALLY_RELEASED', 'RELEASED']);

/**
 * 품목 상태 힌트 — 완료의 근거가 아니라 담당자 판단을 돕는 표시다(설계서 v2 02 §3.3).
 * 원천은 대상 유형에 따라 다르다: 맞춤·렌탈은 제작 상태, 수선은 수선 상태(통합설계서 §12.1).
 *
 * 수선은 수선 화면과 진행 카드 두 곳에 각각 입력해야 하므로, 수선 상태가 이미 이 단계를
 * 지났는데 품목 완료가 비어 있으면 "누를 차례"로 강조한다. 자동 완료는 하지 않는다.
 */
function statusHint(it: StageItem, stageCode: string) {
  const status = it.productionHint?.status;
  if (!status) return null;
  const isRepair = it.targetType === 'REPAIR_ITEM';
  const label = isRepair
    ? repairStatusMeta(status).label
    : metaOf(PRODUCTION_STATUS_META, status).label;
  const nudge = isRepair && !it.completed && repairStageReached(stageCode, status);
  return (
    <Tooltip
      title={
        nudge
          ? `수선 상태가 '${label}'까지 왔습니다 — [완료]를 눌러 진행에도 기록하세요.`
          : `${isRepair ? '수선' : '제작'} 상태 힌트 (자동 완료 아님)`
      }
    >
      <Tag color={nudge ? 'gold' : 'default'} style={{ marginInlineEnd: 0 }}>
        {label}
      </Tag>
    </Tooltip>
  );
}

interface Props {
  customerId: string;
  customerName: string;
  /** 고객 상세가 이미 조회한 계약·주문 — 단계에 번호 링크를 붙이는 데 쓴다 */
  contracts: CustomerContractRow[];
  orders: CustomerOrderRow[];
}

export function JourneyCard({ customerId, customerName, contracts, orders }: Props) {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [startForm] = Form.useForm<{ trackType: TrackType }>();
  const [contactOpen, setContactOpen] = useState(false);
  // [전체 완료] 시 비고 입력 모달 (선택 입력)
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeNotes, setCompleteNotes] = useState('');

  const journeysQuery = useQuery({
    queryKey: ['customer-journeys', customerId],
    queryFn: () => fetchCustomerJourneys(customerId),
  });

  const journeys = journeysQuery.data ?? [];
  // 선택이 없으면 진행 중인 것 우선, 없으면 가장 최근 건을 본다.
  const activeId =
    selectedId && journeys.some((j) => j.id === selectedId)
      ? selectedId
      : (journeys.find((j) => j.status === 'ACTIVE')?.id ?? journeys[0]?.id ?? null);

  const detailQuery = useQuery({
    queryKey: ['journey', activeId],
    queryFn: () => fetchJourney(activeId as string),
    enabled: activeId != null,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['customer-journeys', customerId] });
    void queryClient.invalidateQueries({ queryKey: ['journey', activeId] });
  };

  const startMutation = useMutation({
    mutationFn: (trackType: TrackType) => createJourney(customerId, { trackType }),
    onSuccess: (created) => {
      message.success('진행을 시작했습니다.');
      setSelectedId(created.id);
      setStartOpen(false);
      startForm.resetFields();
      invalidate();
    },
    onError: (error) =>
      message.error(error instanceof ApiError ? error.message : '진행 시작에 실패했습니다.'),
  });

  // 단계 이동(전진 완료 / 되돌리기 공용). 새 단계가 연락 단계면 재조회로 [고객 연락] 버튼이 뜬다.
  const stageMutation = useMutation({
    mutationFn: (vars: { toStageCode: string; version: number; reason?: string; notes?: string }) =>
      changeJourneyStage(activeId as string, vars),
    onSuccess: (result) => {
      message.success(`‘${result.journey.currentStageName}’ 단계로 이동했습니다.`);
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        message.warning('다른 사용자가 먼저 변경했습니다. 최신 내용을 불러옵니다.');
        invalidate();
        return;
      }
      message.error(error instanceof ApiError ? error.message : '단계 변경에 실패했습니다.');
    },
  });

  const closeMutation = useMutation({
    mutationFn: (vars: { kind: 'COMPLETE' | 'CANCEL'; version: number; reason?: string }) =>
      vars.kind === 'COMPLETE'
        ? completeJourney(activeId as string, vars.version, vars.reason)
        : cancelJourney(activeId as string, vars.version, vars.reason),
    onSuccess: () => {
      message.success('진행을 완료했습니다.');
      invalidate();
    },
    onError: (error) =>
      message.error(error instanceof ApiError ? error.message : '완료 처리에 실패했습니다.'),
  });

  const detail = detailQuery.data;
  const canEdit = useAuthStore((s) => s.user?.permissions.includes('JOURNEY_EDIT') ?? false);

  // ---- 파생 값 -------------------------------------------------------------
  const currentSeq = detail?.currentStageSequenceNo ?? 0;
  const nextStage = detail?.stages.find((s) => s.sequenceNo === currentSeq + 1) ?? null;
  // 현재 단계 메타(게이팅·완료방식) — 품목 체크리스트/전체완료 활성 판단의 근거
  const currentStage = detail?.stages.find((s) => s.code === detail.currentStageCode) ?? null;
  const isGatedCurrent = currentStage?.completionMode === 'GATED';
  const isActive = detail?.status === 'ACTIVE';

  // 현재 단계가 GATED면 품목별 완료 체크리스트를 조회한다. AUTO 단계는 품목 대상이 없다.
  const stageItemsQuery = useQuery({
    queryKey: ['journey-stage-items', activeId, detail?.currentStageCode],
    queryFn: () => getStageItems(activeId as string, detail!.currentStageCode),
    enabled: activeId != null && detail != null && isActive && isGatedCurrent,
  });
  const stageItems = stageItemsQuery.data?.items ?? [];

  const invalidateStageItems = () =>
    void queryClient.invalidateQueries({
      queryKey: ['journey-stage-items', activeId, detail?.currentStageCode],
    });

  // 품목 완료/취소 — 클릭마다 게이팅이 재계산되어 [전체 완료] 활성/비활성이 토글된다.
  const completeItemMutation = useMutation({
    mutationFn: (targetId: string) =>
      completeStageItem(activeId as string, detail!.currentStageCode, targetId),
    onSuccess: () => {
      invalidateStageItems();
      invalidate();
    },
    onError: (error) =>
      message.error(error instanceof ApiError ? error.message : '품목 완료에 실패했습니다.'),
  });
  const uncompleteItemMutation = useMutation({
    mutationFn: (targetId: string) =>
      uncompleteStageItem(activeId as string, detail!.currentStageCode, targetId),
    onSuccess: () => {
      invalidateStageItems();
      invalidate();
    },
    onError: (error) =>
      message.error(error instanceof ApiError ? error.message : '완료 취소에 실패했습니다.'),
  });
  const currentWorkAction = detail ? (WORK_ACTION[detail.currentStageCode] ?? null) : null;

  // 진행에 연결된 주문 → 없으면 고객의 첫 주문. 계약은 그 주문의 계약번호로 역참조.
  const linkedOrder = detail
    ? (orders.find((o) => o.id === detail.orderId) ?? orders[0] ?? null)
    : null;
  const linkedContract = linkedOrder?.contractNo
    ? (contracts.find((c) => c.contractNo === linkedOrder.contractNo) ?? null)
    : (contracts[0] ?? null);

  // 단계별 완료 기록(그 단계를 떠난 최신 이벤트) — from == 단계코드
  const completionByCode = new Map<string, JourneyEvent>();
  detail?.events.forEach((e) => {
    if (e.fromStageCode && !completionByCode.has(e.fromStageCode)) {
      completionByCode.set(e.fromStageCode, e);
    }
  });

  const fmt = (iso: string) => iso.slice(0, 16).replace('T', ' ');

  // ---- 핸들러 --------------------------------------------------------------
  const goWork = (to: string) => {
    const q = linkedOrder?.orderNo ?? customerName;
    navigate(`${to}?q=${encodeURIComponent(q)}`);
  };

  // [전체 완료] — 마지막 단계면 진행 완료, 아니면 비고 입력 모달을 띄운다(§6.1).
  const handleCompleteStage = () => {
    if (!detail) return;
    if (!nextStage) {
      modal.confirm({
        title: '이 진행을 완료 처리할까요?',
        content: '마지막 단계입니다. 완료 후에는 단계를 바꿀 수 없습니다.',
        okText: '진행 완료',
        cancelText: '취소',
        onOk: () => closeMutation.mutateAsync({ kind: 'COMPLETE', version: detail.version }),
      });
      return;
    }
    setCompleteNotes('');
    setCompleteOpen(true);
  };

  const handleCompleteConfirm = () => {
    if (!detail || !nextStage) return;
    stageMutation
      .mutateAsync({
        toStageCode: nextStage.code,
        version: detail.version,
        notes: completeNotes.trim() || undefined,
      })
      .then(() => {
        setCompleteOpen(false);
        setCompleteNotes('');
      })
      .catch(() => {
        // 게이팅 미충족(422 STAGE_NOT_COMPLETE) 등은 onError에서 메시지 처리 — 모달은 유지
      });
  };

  const handleRollback = () => {
    if (!detail) return;
    const prev = detail.stages.find((s) => s.sequenceNo === currentSeq - 1);
    if (!prev) return;
    let reason = '';
    modal.confirm({
      title: `‘${prev.name}’ 단계로 되돌릴까요?`,
      content: (
        <Input.TextArea
          rows={3}
          placeholder="되돌리는 사유를 적어주세요 (필수)"
          onChange={(e) => {
            reason = e.target.value;
          }}
        />
      ),
      okText: '되돌리기',
      cancelText: '취소',
      onOk: async () => {
        if (!reason.trim()) {
          message.warning('사유를 입력해 주세요.');
          return Promise.reject(new Error('reason required'));
        }
        return stageMutation.mutateAsync({
          toStageCode: prev.code,
          version: detail.version,
          reason: reason.trim(),
        });
      },
    });
  };

  /** 발송 확인창 결과를 이력에 봉합. 마지막 연락 단계면 발송과 동시에 진행 자동 완료. */
  const handleContactDone = async (outcome: SendOutcome, historyId?: string) => {
    setContactOpen(false);
    const sug = detail?.currentSuggestion;
    if (!sug || !detail) return;
    await setNotificationOutcome(detail.id, sug.eventId, {
      outcome,
      notificationHistoryId: historyId,
    });
    if (outcome === 'SENT' && !nextStage) {
      // 마지막 단계(인사·반납 안내) 발송 → 진행 자동 완료
      await closeMutation.mutateAsync({ kind: 'COMPLETE', version: detail.version });
    } else {
      invalidate();
    }
  };

  const journeyLabel = (j: Journey) =>
    `${trackTypeLabel(j.trackType)}${j.orderNo ? ` · ${j.orderNo}` : ''}`;

  // ---- 품목별 입출고 집계 (맞춤 전용) --------------------------------------
  // 완성복 입고/출고는 품목별로 병렬 진행되므로, 단계 옆에 품목 단위 진척을 함께 보여준다.
  const renderItemProgress = (mode: 'IN' | 'OUT') => {
    const items = linkedOrder?.items ?? [];
    if (items.length === 0) return null;
    const isDone = (status: string) =>
      mode === 'IN' ? ITEM_RECEIVED_STATUSES.has(status) : status === 'RELEASED';
    const badge = (status: string): { text: string; color: string } => {
      if (mode === 'IN') {
        if (ITEM_RECEIVED_STATUSES.has(status)) return { text: '입고완료', color: 'green' };
        if (status === 'PARTIALLY_RECEIVED') return { text: '부분입고', color: 'gold' };
        return { text: '대기', color: 'default' };
      }
      if (status === 'RELEASED') return { text: '출고완료', color: 'green' };
      if (status === 'PARTIALLY_RELEASED') return { text: '부분출고', color: 'gold' };
      return { text: '대기', color: 'default' };
    };
    const doneCount = items.filter((i) => isDone(i.status)).length;
    const allDone = doneCount === items.length;
    return (
      <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
        <Typography.Text type={allDone ? 'success' : 'secondary'} style={{ fontSize: 12 }}>
          {mode === 'IN' ? '입고' : '출고'} {doneCount}/{items.length}
          {allDone ? ' · 전체 완료' : ''}
        </Typography.Text>
        {items.map((i) => {
          const b = badge(i.status);
          return (
            <Space key={i.id} size={4}>
              <Tag color={b.color} style={{ marginInlineEnd: 0 }}>
                {b.text}
              </Tag>
              <Typography.Text style={{ fontSize: 12 }}>{i.displayName}</Typography.Text>
            </Space>
          );
        })}
      </Space>
    );
  };

  // ---- 현재 단계 품목 완료 체크리스트 (GATED 전용) -------------------------
  // 각 품목을 [완료]/[취소]로 수동 확정하고, 전 품목 완료 시 [전체 완료]가 열린다(설계서 v2 02 §4·§9.3).
  const renderStageChecklist = () => {
    if (!isGatedCurrent) return null;
    const stageCode = detail?.currentStageCode ?? '';
    const remaining = (currentStage?.targetCount ?? 0) - (currentStage?.completedCount ?? 0);
    return (
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Space size={6}>
          <Typography.Text strong style={{ fontSize: 12 }}>
            품목 완료
          </Typography.Text>
          <Tag color={remaining === 0 && (currentStage?.targetCount ?? 0) > 0 ? 'green' : 'blue'}>
            {currentStage?.completedCount ?? 0}/{currentStage?.targetCount ?? 0}
          </Tag>
        </Space>
        {stageItemsQuery.isLoading ? (
          <Spin size="small" />
        ) : stageItems.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            대상 품목이 없습니다.
          </Typography.Text>
        ) : (
          stageItems.map((it) => (
            <Space key={it.targetId} size={6} wrap>
              {canEdit ? (
                it.completed ? (
                  <Button
                    size="small"
                    onClick={() => uncompleteItemMutation.mutate(it.targetId)}
                    loading={
                      uncompleteItemMutation.isPending &&
                      uncompleteItemMutation.variables === it.targetId
                    }
                  >
                    취소
                  </Button>
                ) : (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    icon={<CheckOutlined />}
                    onClick={() => completeItemMutation.mutate(it.targetId)}
                    loading={
                      completeItemMutation.isPending &&
                      completeItemMutation.variables === it.targetId
                    }
                  >
                    완료
                  </Button>
                )
              ) : (
                <Tag color={it.completed ? 'green' : 'default'}>
                  {it.completed ? '완료' : '대기'}
                </Tag>
              )}
              <Typography.Text style={{ fontSize: 12 }}>{it.displayName}</Typography.Text>
              {statusHint(it, stageCode)}
              {it.completed && it.completedByName && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {it.completedByName}
                </Typography.Text>
              )}
            </Space>
          ))
        )}
      </Space>
    );
  };

  // ---- 단계 노드 설명 ------------------------------------------------------
  const stageDescription = (s: JourneyStageView) => {
    const isCurrent = detail?.currentStageCode === s.code;
    const done = completionByCode.get(s.code);
    const isGap = !isCurrent && !done && s.sequenceNo < currentSeq;

    const links: React.ReactNode[] = [];
    if (s.code === 'CONTRACT_CONFIRMED' && linkedContract) {
      links.push(
        <Link key="c" to={`/contracts/${linkedContract.id}`}>
          <FileTextOutlined /> {linkedContract.contractNo}
        </Link>,
      );
    }
    if (SHOW_ORDER_LINK.has(s.code) && linkedOrder) {
      links.push(
        <Link key="o" to={`/orders/${linkedOrder.id}`}>
          <ProfileOutlined /> {linkedOrder.orderNo}
        </Link>,
      );
    }

    return (
      <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
        {links.length > 0 && <Space size="small">{links}</Space>}
        {detail?.trackType === 'CUSTOM' &&
          ITEM_PROGRESS_STAGE[s.code] &&
          renderItemProgress(ITEM_PROGRESS_STAGE[s.code])}
        {done && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            완료 {fmt(done.changedAt)}
            {done.actor ? ` · ${done.actor.displayName}` : ''}
          </Typography.Text>
        )}
        {done && done.notificationOutcome !== 'NONE' && (
          <Tag color={OUTCOME_META[done.notificationOutcome]?.color}>
            연락 {OUTCOME_META[done.notificationOutcome]?.label}
          </Tag>
        )}
        {done?.reason && (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            {done.reason}
          </Typography.Text>
        )}
        {s.notes && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            비고: {s.notes}
          </Typography.Text>
        )}
        {isCurrent && detail?.status === 'ACTIVE' && (
          <Space
            direction="vertical"
            size={8}
            style={{
              width: '100%',
              marginTop: 4,
              padding: 8,
              border: '1px solid #91caff',
              background: '#e6f4ff',
              borderRadius: 8,
            }}
          >
            {renderStageChecklist()}
            {canEdit ? (
              <Space wrap size="small">
                {currentWorkAction && (
                  <Button
                    size="small"
                    icon={<ArrowRightOutlined />}
                    onClick={() => goWork(currentWorkAction.to)}
                  >
                    {currentWorkAction.label}
                  </Button>
                )}
                {detail.currentSuggestion && (
                  <Button size="small" icon={<PhoneOutlined />} onClick={() => setContactOpen(true)}>
                    고객 연락
                  </Button>
                )}
                {nextStage ? (
                  <Tooltip
                    title={
                      isGatedCurrent && !currentStage?.canComplete
                        ? `품목 ${(currentStage?.targetCount ?? 0) - (currentStage?.completedCount ?? 0)}건 미완료`
                        : undefined
                    }
                  >
                    <Button
                      size="small"
                      type="primary"
                      icon={<CheckOutlined />}
                      disabled={isGatedCurrent && !currentStage?.canComplete}
                      loading={stageMutation.isPending}
                      onClick={handleCompleteStage}
                    >
                      {isGatedCurrent ? '전체 완료' : '이 단계 완료'} → {nextStage.name}
                    </Button>
                  </Tooltip>
                ) : (
                  <Button
                    size="small"
                    type="primary"
                    icon={<CheckOutlined />}
                    loading={closeMutation.isPending}
                    onClick={handleCompleteStage}
                  >
                    진행 완료
                  </Button>
                )}
                {currentSeq > 1 && (
                  <Button size="small" icon={<RollbackOutlined />} onClick={handleRollback}>
                    되돌리기
                  </Button>
                )}
              </Space>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                진행 중
              </Typography.Text>
            )}
          </Space>
        )}
        {isGap && <Tag color="warning">완료 기록 없음 (건너뜀)</Tag>}
      </Space>
    );
  };

  const stageStatus = (s: JourneyStageView) => {
    if (detail?.currentStageCode === s.code) {
      if (detail.status === 'COMPLETED') return 'finish' as const;
      if (detail.status === 'CANCELLED') return 'error' as const;
      return 'process' as const;
    }
    if (completionByCode.has(s.code)) return 'finish' as const;
    if (s.sequenceNo < currentSeq) return 'error' as const; // 건너뛴 미완료
    return 'wait' as const;
  };

  return (
    <Card
      title="진행 단계"
      extra={
        <Space>
          {journeys.length > 1 && (
            <Segmented
              size="small"
              value={activeId ?? undefined}
              onChange={(v) => setSelectedId(v as string)}
              options={journeys.map((j) => ({ label: journeyLabel(j), value: j.id }))}
            />
          )}
          <Can permission="JOURNEY_EDIT">
            <Button size="small" icon={<PlusOutlined />} onClick={() => setStartOpen(true)}>
              진행 시작
            </Button>
          </Can>
        </Space>
      }
    >
      {journeysQuery.isLoading || (activeId && detailQuery.isLoading) ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : !detail ? (
        <Empty
          description={`${customerName}님의 진행이 없습니다`}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Can permission="JOURNEY_EDIT">
            <Button type="primary" onClick={() => setStartOpen(true)}>
              진행 시작
            </Button>
          </Can>
        </Empty>
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Tag color="blue">{trackTypeLabel(detail.trackType)}</Tag>
            <Tag color={journeyStatusMeta(detail.status).color}>
              {journeyStatusMeta(detail.status).label}
            </Tag>
            {detail.orderNo && (
              <Typography.Text type="secondary">{detail.orderNo}</Typography.Text>
            )}
            <Typography.Text type="secondary">
              {currentSeq}/{detail.totalStages} 단계
            </Typography.Text>
          </Space>

          <Steps
            size="small"
            direction="vertical"
            current={currentSeq > 0 ? currentSeq - 1 : 0}
            items={detail.stages.map((s) => ({
              title: s.name,
              status: stageStatus(s),
              description: stageDescription(s),
            }))}
          />
        </Space>
      )}

      <Modal
        open={startOpen}
        title="진행 시작"
        okText="시작"
        cancelText="취소"
        confirmLoading={startMutation.isPending}
        onCancel={() => setStartOpen(false)}
        onOk={() => {
          void startForm.validateFields().then((v) => startMutation.mutate(v.trackType));
        }}
      >
        <Form form={startForm} layout="vertical" initialValues={{ trackType: 'CUSTOM' }}>
          <Form.Item
            name="trackType"
            label="거래 유형"
            rules={[{ required: true, message: '거래 유형을 선택해 주세요' }]}
          >
            <Select
              options={TRACK_TYPES.map((t) => ({ label: trackTypeLabel(t), value: t }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={completeOpen}
        title={
          detail && nextStage
            ? `‘${detail.currentStageName}’ 단계 완료 → ‘${nextStage.name}’`
            : '단계 완료'
        }
        okText="완료"
        cancelText="취소"
        confirmLoading={stageMutation.isPending}
        onCancel={() => setCompleteOpen(false)}
        onOk={handleCompleteConfirm}
      >
        <Typography.Paragraph type="secondary">
          완료 기록을 남기고 다음 단계로 넘어갑니다. 비고는 선택 입력입니다.
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          value={completeNotes}
          onChange={(e) => setCompleteNotes(e.target.value)}
          placeholder="비고 (선택)"
          maxLength={1000}
        />
      </Modal>

      <NotificationConfirmModal
        open={contactOpen}
        title={detail ? `${detail.currentStageName} — 고객 연락` : '고객 연락'}
        suggestion={detail?.currentSuggestion ?? null}
        onDone={handleContactDone}
        onCancel={() => setContactOpen(false)}
      />
    </Card>
  );
}
