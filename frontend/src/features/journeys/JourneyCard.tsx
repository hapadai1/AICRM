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
  Collapse,
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
  createJourney,
  fetchCustomerJourneys,
  fetchJourney,
  journeyStatusMeta,
  OUTCOME_META,
  setNotificationOutcome,
  trackTypeLabel,
  TRACK_TYPES,
  type Journey,
  type JourneyEvent,
  type TrackType,
} from '../../api/journeys';
import { Can } from '../../shared/Can';
import { NotificationConfirmModal, type SendOutcome } from '../../shared/NotificationConfirmModal';

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
    mutationFn: (vars: { toStageCode: string; version: number; reason?: string }) =>
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

  // ---- 파생 값 -------------------------------------------------------------
  const currentSeq = detail?.currentStageSequenceNo ?? 0;
  const nextStage = detail?.stages.find((s) => s.sequenceNo === currentSeq + 1) ?? null;
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
  const codeToName = new Map<string, string>();
  detail?.stages.forEach((s) => codeToName.set(s.code, s.name));
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
    modal.confirm({
      title: `‘${detail.currentStageName}’ 단계를 완료할까요?`,
      content: `완료 기록을 남기고 ‘${nextStage.name}’ 단계로 넘어갑니다.`,
      okText: '단계 완료',
      cancelText: '취소',
      onOk: () => stageMutation.mutateAsync({ toStageCode: nextStage.code, version: detail.version }),
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

  // ---- 단계 노드 설명 ------------------------------------------------------
  const stageDescription = (s: { code: string; sequenceNo: number }) => {
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
        {done && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            완료 {fmt(done.changedAt)}
            {done.actor ? ` · ${done.actor.displayName}` : ''}
          </Typography.Text>
        )}
        {isCurrent && detail?.status === 'ACTIVE' && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            진행 중
          </Typography.Text>
        )}
        {isGap && <Tag color="warning">완료 기록 없음 (건너뜀)</Tag>}
      </Space>
    );
  };

  const stageStatus = (s: { code: string; sequenceNo: number }) => {
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

          {/* 현재 단계 액션 패널 — 상태 변경을 여기서 바로 */}
          {detail.status === 'ACTIVE' && (
            <div
              style={{
                border: '1px solid #91caff',
                background: '#e6f4ff',
                borderRadius: 8,
                padding: 12,
              }}
            >
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Typography.Text strong>현재 · {detail.currentStageName}</Typography.Text>
                <Can permission="JOURNEY_EDIT">
                  <Space wrap>
                    {currentWorkAction && (
                      <Button
                        icon={<ArrowRightOutlined />}
                        onClick={() => goWork(currentWorkAction.to)}
                      >
                        {currentWorkAction.label}
                      </Button>
                    )}
                    {detail.currentSuggestion && (
                      <Button icon={<PhoneOutlined />} onClick={() => setContactOpen(true)}>
                        고객 연락
                      </Button>
                    )}
                    <Button
                      type="primary"
                      icon={<CheckOutlined />}
                      loading={stageMutation.isPending || closeMutation.isPending}
                      onClick={handleCompleteStage}
                    >
                      {nextStage ? `이 단계 완료 → ${nextStage.name}` : '진행 완료'}
                    </Button>
                    {currentSeq > 1 && (
                      <Button icon={<RollbackOutlined />} onClick={handleRollback}>
                        되돌리기
                      </Button>
                    )}
                  </Space>
                </Can>
              </Space>
            </div>
          )}

          {detail.events.length > 0 && (
            <Collapse
              ghost
              size="small"
              items={[
                {
                  key: 'log',
                  label: `단계 변경 기록 (${detail.events.length})`,
                  children: (
                    <div>
                      {detail.events.map((e) => (
                        <div key={e.id} style={{ fontSize: 12, marginBottom: 6 }}>
                          <Typography.Text type="secondary">{fmt(e.changedAt)}</Typography.Text>{' '}
                          {e.fromStageCode && (
                            <Typography.Text type="secondary">
                              {codeToName.get(e.fromStageCode) ?? e.fromStageCode} →{' '}
                            </Typography.Text>
                          )}
                          <Typography.Text strong>
                            {codeToName.get(e.toStageCode) ?? e.toStageCode}
                          </Typography.Text>
                          {e.actor && (
                            <Typography.Text type="secondary"> · {e.actor.displayName}</Typography.Text>
                          )}
                          {e.notificationOutcome !== 'NONE' && (
                            <Tag
                              style={{ marginLeft: 6 }}
                              color={OUTCOME_META[e.notificationOutcome]?.color}
                            >
                              연락 {OUTCOME_META[e.notificationOutcome]?.label}
                            </Tag>
                          )}
                          {e.reason && (
                            <Typography.Text type="warning"> · {e.reason}</Typography.Text>
                          )}
                        </div>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          )}
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
