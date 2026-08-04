/**
 * 제작 관리의 한 흐름(맞춤 또는 렌탈) — 진행(journey) 단계를 세로로 세우고 그 안에서 품목을 관리한다.
 *
 * 단계·완료 기록의 원천은 진행이다. 담당자가 품목 버튼을 누르면 이 화면이
 *  1) 제작 도메인(구성품 입출고·품목 상태)을 먼저 처리하고
 *  2) 진행의 품목 완료를 찍는다.
 * 두 곳을 따로 누르지 않게 하려는 것이고, 순서를 이렇게 둔 이유는 실물 처리가 실패했는데
 * 진행만 완료로 남는 상황을 막기 위해서다.
 *
 * 그 단계의 마지막 품목이 완료되면 다음 단계로 넘어가고, 넘어간 단계에 연락 문구가 걸려 있으면
 * 발송 확인창이 뜬다(자동 발송은 하지 않는다 — 개발설계서 05 G-06).
 */
import { ExperimentOutlined, FileExcelOutlined, NotificationOutlined } from '@ant-design/icons';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, DatePicker, Form, Modal, Popconfirm, Progress, Space, Steps, Tooltip, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  changeJourneyStage,
  completeStageItem,
  fetchJourney,
  getStageItems,
  setNotificationOutcome,
  uncompleteStageItem,
  type Journey,
  type SuggestedNotification,
} from '../../api/journeys';
import {
  ITEM_STATUS_RANK,
  canRequestProduction,
  postComponentStatusEvent,
  postItemProductionEvent,
  receiveComponent,
  releaseComponent,
  type ProductionComponent,
  type ProductionItem,
} from '../../api/production';
import { Can } from '../../shared/Can';
import { NotificationConfirmModal, type SendOutcome } from '../../shared/NotificationConfirmModal';
import { WorkOrderFormPreviewModal } from '../workorders/WorkOrderFormPreviewModal';
import { FittingModal } from './FittingModal';
import { StageProgress, type StageRow } from './StageProgress';
import { WorkOrderModal } from './WorkOrderModal';
import {
  STAGE_BODY_INDENT,
  STAGE_LABEL_WIDTH,
  STAGE_SUMMARY_WIDTH,
  bulkButtonStyle,
  docButtonStyle,
} from './production-layout';
import {
  PREP_STAGE_CODE,
  needsDate,
  prepDone,
  stageReached,
  stagesForTrack,
  type ProductionStage,
} from './production-stages';

interface ProductionFlowCardProps {
  title: string;
  trackType: 'CUSTOM' | 'RENTAL';
  /** 이 흐름의 제작 품목 (취소 제외) */
  items: ProductionItem[];
  /** 이 흐름의 진행. 아직 시작되지 않았으면 null */
  journey: Journey | null;
}

/** 일자를 받아야 하는 단계에서 쓰는 대기 상태 */
interface DateAsk {
  stage: ProductionStage;
  index: number;
  rows: StageRow[];
  /** 구성품 하나만 처리하는 경우 */
  component?: ProductionComponent;
}

export function ProductionFlowCard({ title, trackType, items, journey }: ProductionFlowCardProps) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const stages = stagesForTrack(trackType);

  const [expanded, setExpanded] = useState<string[]>([]);
  const [dateAsk, setDateAsk] = useState<DateAsk | null>(null);
  const [pendingKey, setPendingKey] = useState<string | undefined>();
  const [fittingTarget, setFittingTarget] = useState<ProductionItem | null>(null);
  const [workOrderTarget, setWorkOrderTarget] = useState<ProductionItem | null>(null);
  const [formPreviewItemId, setFormPreviewItemId] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestedNotification | null>(null);
  const [suggestionTitle, setSuggestionTitle] = useState('');
  const [dateForm] = Form.useForm<{ date: Dayjs }>();

  const journeyId = journey?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ['journeys', 'detail', journeyId],
    queryFn: () => fetchJourney(journeyId as string),
    enabled: !!journeyId,
  });
  const detail = detailQuery.data;

  // 단계마다 대상 품목과 완료 기록을 가져온다 — 지난 단계도 누가 언제 끝냈는지 보여야 한다.
  const stageItemQueries = useQueries({
    queries: stages.map((stage) => ({
      queryKey: ['journey-stage-items', journeyId, stage.code],
      queryFn: () => getStageItems(journeyId as string, stage.code),
      enabled: !!journeyId,
    })),
  });

  /*
    준비 단계는 이 카드에 그리지 않지만(위의 준비 카드가 계약당 하나로 세운다) 진행에는 그대로 있다.
    첫 단계를 처리할 때 준비의 품목 완료도 함께 찍어야 진행이 막히지 않으므로 그 기록만 읽어 둔다.
  */
  const prepItemsQuery = useQuery({
    queryKey: ['journey-stage-items', journeyId, PREP_STAGE_CODE],
    queryFn: () => getStageItems(journeyId as string, PREP_STAGE_CODE),
    enabled: !!journeyId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['journeys'] });
    void queryClient.invalidateQueries({ queryKey: ['journey-stage-items'] });
    void queryClient.invalidateQueries({ queryKey: ['production'] });
  };

  const itemOf = (targetId: string) => items.find((i) => i.orderItemId === targetId);

  const rowsOf = (index: number): StageRow[] =>
    (stageItemQueries[index].data?.items ?? []).map((target) => ({
      key: target.targetId,
      target,
      item: itemOf(target.targetId),
    }));

  /**
   * 앞 단계를 끝내지 않은 품목은 이 단계를 누를 수 없다 — 순서를 화면이 지킨다.
   * 첫 단계 앞에는 준비가 있다 — 준비는 사람이 누르는 단계가 아니므로
   * 이 카드 밖(준비 카드)의 판정과 같은 조건으로 본다(prepDone).
   */
  const blockedReasonAt = (index: number) => (row: StageRow): string | null => {
    if (index === 0) {
      const ready = row.item ? prepDone(row.item.workOrder, trackType) : false;
      return ready
        ? null
        : trackType === 'RENTAL'
          ? '옵션이 확정되어야 시작할 수 있습니다.'
          : '옵션 확정과 채촌이 끝나야 시작할 수 있습니다.';
    }
    // 앞 단계는 진행 기록이든 제작 상태든 지나갔으면 끝난 것으로 본다.
    const prevStage = stages[index - 1];
    const prev = rowsOf(index - 1).find((r) => r.key === row.key);
    const prevDone =
      prev?.target.completed || stageReached(prevStage, row.item?.itemStatus ?? prev?.item?.itemStatus);
    return prevDone ? null : `‘${prevStage.label}’를 먼저 끝내야 합니다.`;
  };

  /** 그 단계에서 아직 손대지 않은 구성품 */
  const pendingComponentsOf = (stage: ProductionStage, item: ProductionItem) =>
    item.components.filter((c) => {
      if (!c.active || c.status === 'CANCELLED') return false;
      if (stage.effect === 'COMPONENT_RECEIVE') return !c.actualInboundAt && c.status !== 'RELEASED';
      if (stage.effect === 'COMPONENT_RELEASE') return c.status === 'RECEIVED' && !c.actualOutboundAt;
      if (stage.effect === 'COMPONENT_BASTING')
        return !['BASTING_RECEIVED', 'PRODUCTION_COMPLETED', 'RECEIVED', 'RELEASED'].includes(
          c.status,
        );
      return false;
    });

  /** 품목 버튼이 함께 처리하는 실물 기록 — 이미 지나온 것은 건드리지 않는다. */
  async function applyEffect(stage: ProductionStage, item: ProductionItem | undefined, date?: string) {
    if (!item || !stage.effect) return;
    if (stage.effect === 'ITEM_REQUEST') {
      if (canRequestProduction(item.itemStatus))
        await postItemProductionEvent(item.orderItemId, { toStatus: 'PRODUCTION_REQUESTED' });
      return;
    }
    if (stage.effect === 'ITEM_FITTING') {
      const rank = ITEM_STATUS_RANK[item.itemStatus] ?? -1;
      if (rank < ITEM_STATUS_RANK.FITTING_COMPLETED)
        await postItemProductionEvent(item.orderItemId, { toStatus: 'FITTING_COMPLETED' });
      return;
    }
    for (const c of pendingComponentsOf(stage, item)) {
      if (stage.effect === 'COMPONENT_BASTING')
        await postComponentStatusEvent(c.id, { toStatus: 'BASTING_RECEIVED' });
      else if (stage.effect === 'COMPONENT_RECEIVE')
        await receiveComponent(c.id, { receivedDate: date as string });
      else if (stage.effect === 'COMPONENT_RELEASE')
        await releaseComponent(c.id, { releasedDate: date as string });
    }
  }

  /**
   * 끝난 단계만큼 진행을 앞으로 민다.
   * 한 칸씩만 밀면 자동 단계(상담 예약·계약 확정)나 방금 함께 봉합한 준비 단계에서 걸려
   * 진행이 실제보다 뒤처진다. 그래서 "현재 단계의 품목이 전부 끝났으면" 계속 민다.
   * 연락 문구가 걸린 단계에 들어가면 거기서 멈추고 발송 확인창을 띄운다(자동 발송은 없다).
   */
  const advanceAll = async () => {
    if (!journeyId) return;
    try {
      let d = await fetchJourney(journeyId);
      for (let guard = 0; guard < stages.length + 3; guard += 1) {
        const cur = d.stages.find((s) => s.code === d.currentStageCode);
        if (!cur) break;
        if (cur.completionMode === 'GATED' && !cur.canComplete) break;
        const next = d.stages.find((s) => s.sequenceNo === (d.currentStageSequenceNo ?? 0) + 1);
        if (!next) break;
        const result = await changeJourneyStage(d.id, {
          toStageCode: next.code,
          version: d.version,
        });
        if (result.suggestedNotification) {
          setSuggestionTitle(`‘${result.journey.currentStageName}’ 단계로 이동했습니다`);
          setSuggestion(result.suggestedNotification);
          break;
        }
        d = await fetchJourney(journeyId);
      }
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : '단계 이동에 실패했습니다.');
    }
  };

  /**
   * 품목 완료 — 실물부터 처리하고 진행을 찍는다.
   * 여러 품목을 한 번에 누른 경우에도 차례로 보낸다(백엔드가 품목 집계 상태를 매번 다시 계산한다).
   */
  const completeMutation = useMutation({
    mutationFn: async (v: { stage: ProductionStage; rows: StageRow[]; date?: string; index: number }) => {
      let done = 0;
      const prepTargets = prepItemsQuery.data?.items ?? [];
      for (const row of v.rows) {
        setPendingKey(row.key);
        // 준비는 자동 판정이라 완료 기록이 없다 — 첫 단계를 처리할 때 그 사실을 함께 남긴다.
        if (v.index === 0) {
          const prep = prepTargets.find((t) => t.targetId === row.target.targetId);
          if (prep && !prep.completed)
            await completeStageItem(journeyId as string, PREP_STAGE_CODE, row.target.targetId);
        }
        await applyEffect(v.stage, row.item, v.date);
        if (!row.target.completed)
          await completeStageItem(journeyId as string, v.stage.code, row.target.targetId);
        done += 1;
      }
      return done;
    },
    onSuccess: async (done, v) => {
      setPendingKey(undefined);
      setDateAsk(null);
      message.success(`${done}개 품목을 ${v.stage.action} 처리했습니다.`);
      await advanceAll();
      invalidate();
    },
    onError: (e) => {
      setPendingKey(undefined);
      message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');
    },
  });

  const uncompleteMutation = useMutation({
    mutationFn: (v: { row: StageRow; stageCode: string }) =>
      uncompleteStageItem(journeyId as string, v.stageCode, v.row.target.targetId),
    onSuccess: () => {
      message.success('완료를 취소했습니다.');
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '완료 취소에 실패했습니다.'),
  });

  /** 구성품 하나만 처리 — 진행 완료는 찍지 않는다(품목이 다 끝나야 완료다). */
  const componentMutation = useMutation({
    mutationFn: async (v: { stage: ProductionStage; component: ProductionComponent; date?: string }) => {
      if (v.stage.effect === 'COMPONENT_BASTING')
        await postComponentStatusEvent(v.component.id, { toStatus: 'BASTING_RECEIVED' });
      else if (v.stage.effect === 'COMPONENT_RECEIVE')
        await receiveComponent(v.component.id, { receivedDate: v.date as string });
      else if (v.stage.effect === 'COMPONENT_RELEASE')
        await releaseComponent(v.component.id, { releasedDate: v.date as string });
    },
    onSuccess: () => {
      setPendingKey(undefined);
      setDateAsk(null);
      message.success('처리했습니다.');
      invalidate();
    },
    onError: (e) => {
      setPendingKey(undefined);
      message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');
    },
  });

  /** 일자가 필요한 단계면 창을 먼저 띄운다. */
  const runComplete = (stage: ProductionStage, index: number, rows: StageRow[]) => {
    if (rows.length === 0) return;
    if (needsDate(stage)) {
      dateForm.setFieldsValue({ date: dayjs() });
      setDateAsk({ stage, rows, index });
      return;
    }
    completeMutation.mutate({ stage, rows, index });
  };

  const runComponent = (
    stage: ProductionStage,
    index: number,
    row: StageRow,
    component: ProductionComponent,
  ) => {
    setPendingKey(`${row.key}:${component.id}`);
    if (needsDate(stage)) {
      dateForm.setFieldsValue({ date: dayjs() });
      setDateAsk({ stage, index, rows: [row], component });
      return;
    }
    componentMutation.mutate({ stage, component });
  };

  /** 작업지시서 — 출력·보기·엑셀을 팝업 하나에 모았다(줄이 길어지지 않게). */
  const workOrderExtras = (item: ProductionItem, blocked: string | null) => (
    <Tooltip title={blocked ?? ''}>
      <Button
        size="small"
        icon={<FileExcelOutlined />}
        disabled={!!blocked}
        onClick={() => setWorkOrderTarget(item)}
        style={docButtonStyle}
      >
        작업지시서
      </Button>
    </Tooltip>
  );

  /** 가봉 — 수정지시서 다운로드·첨부 업로드가 이 모달 안에 있다. */
  const fittingExtras = (item: ProductionItem, blocked: string | null) => (
    <Can permission="FITTING_EDIT">
      <Tooltip title={blocked ?? ''}>
        <Button
          size="small"
          icon={<ExperimentOutlined />}
          disabled={!!blocked}
          onClick={() => setFittingTarget(item)}
          style={docButtonStyle}
        >
          가봉 작업지시서
        </Button>
      </Tooltip>
    </Can>
  );

  // 진행이 없는 주문은 제작 대상이 아니다 — 목록·상세 모두에서 아예 내보내지 않는다.
  // (서버가 이미 걸러 내려주므로 여기까지 오면 데이터 결손이다. 빈 카드를 그리지 않는다.)
  if (!journey) return null;

  // 진행에는 이 카드에 없는 단계(상담 예약·계약 확정·준비)가 앞에 있다 — 이 화면의 단계만 센다.
  const viewOf = (code: string) => detail?.stages.find((s) => s.code === code);
  /** 그 단계를 끝낸 품목 — 진행의 완료 기록이거나, 제작 상태가 이미 지나갔거나. */
  const rowDone = (stage: ProductionStage) => (row: StageRow) =>
    row.target.completed || stageReached(stage, row.item?.itemStatus);
  const stageDone = (stage: ProductionStage, index: number) => {
    const rows = rowsOf(index);
    return rows.length > 0 ? rows.every(rowDone(stage)) : !!viewOf(stage.code)?.completed;
  };
  const doneStages = stages.filter((s, i) => stageDone(s, i)).length;
  const totalStages = stages.length;
  const currentIndex = stages.findIndex((s) => s.code === detail?.currentStageCode);

  const stepItems = stages.map((stage, i) => {
    const view = viewOf(stage.code);
    const rows = rowsOf(i);
    const done = rowDone(stage);
    const pending = rows.filter((r) => !done(r));
    const isCurrent = detail?.currentStageCode === stage.code;

    /*
      요약은 `n/m 완료` 한 형식으로만 적는다 — 단계가 세로로 나란히 서 있어
      같은 자리에서 같은 모양을 비교하는 편이 빠르다(2026-08-04 현업 확정).
      진행 기록이 없어도 제작 상태로 지나간 품목은 끝난 것으로 센다.
    */
    const summary =
      rows.length > 0
        ? `${rows.length - pending.length}/${rows.length} 완료`
        : view
          ? `${view.completedCount}/${view.targetCount} 완료`
          : '';

    // 앞 단계가 안 끝난 품목은 [전체 …] 대상에서도 빠진다 — 순서를 건너뛰지 않는다.
    const blocked = blockedReasonAt(i);
    const ready = pending.filter((r) => !blocked(r));
    /*
      전체 버튼은 단계마다 늘 같은 자리에 둔다 — 누를 수 없을 때 사라지면
      "이 단계엔 원래 없나" 하고 찾게 된다(2026-08-04 현업 지적). 잠그고 사유를 붙인다.
    */
    const bulkReason =
      pending.length === 0
        ? '남은 품목이 없습니다.'
        : ready.length === 0
          ? (blocked(pending[0]) ?? '아직 처리할 수 없습니다.')
          : null;
    const bulkButton = (
      <Button size="small" disabled={!!bulkReason} style={bulkButtonStyle}>
        전체 {stage.action} ({ready.length})
      </Button>
    );
    const bulk = stage.action ? (
      <Can permission="JOURNEY_EDIT">
        {bulkReason ? (
          <Tooltip title={bulkReason}>{bulkButton}</Tooltip>
        ) : (
          <Popconfirm
            title={`품목 ${ready.length}개를 ${stage.action} 처리합니다.`}
            okText="처리"
            cancelText="취소"
            onConfirm={() => runComplete(stage, i, ready)}
          >
            {bulkButton}
          </Popconfirm>
        )}
      </Can>
    ) : null;

    // 연락 문구는 그 단계에 들어와 있을 때만 제안된다(같은 단계는 한 번만 나간다).
    const contact =
      isCurrent && detail?.currentSuggestion ? (
        <Can permission="NOTIFICATION_SEND">
          <Button
            size="small"
            type="primary"
            ghost
            icon={<NotificationOutlined />}
            onClick={() => {
              setSuggestionTitle(`‘${view?.name ?? stage.label}’ 단계 고객 연락`);
              setSuggestion(detail.currentSuggestion);
            }}
          >
            고객연락
          </Button>
        </Can>
      ) : null;

    const body =
      rows.length > 0 ? (
        <div className="step-body" style={{ paddingLeft: STAGE_BODY_INDENT, paddingBottom: 4 }}>
          <StageProgress
            rows={rows}
            stage={stage}
            expandedKeys={expanded}
            onToggleExpand={(key) =>
              setExpanded((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))
            }
            onComplete={(row) => runComplete(stage, i, [row])}
            onUncomplete={(row) => uncompleteMutation.mutate({ row, stageCode: stage.code })}
            onComponent={(row, component) => runComponent(stage, i, row, component)}
            blockedReason={blocked}
            renderExtras={
              stage.extras === 'WORK_ORDER'
                ? workOrderExtras
                : stage.extras === 'FITTING'
                  ? fittingExtras
                  : undefined
            }
            pendingKey={pendingKey}
          />
        </div>
      ) : undefined;

    return {
      title: (
        /*
          단계 줄의 버튼은 아래 표의 [발주]와 같은 x에서 시작한다 —
          단계명 칸(STAGE_LABEL_WIDTH) + 요약 칸(품목 열과 같은 폭)이 그 자리를 만든다.
          완료 날짜는 버튼 뒤로 뺐다. 앞에 두면 길이가 들쭉날쭉해 버튼 자리가 흔들린다.
        */
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-block', minWidth: STAGE_LABEL_WIDTH }}>{stage.label}</span>
          <span style={{ display: 'inline-block', minWidth: STAGE_SUMMARY_WIDTH, fontWeight: 400 }}>
            <Typography.Text
              type={rows.length > 0 ? (pending.length === 0 ? 'success' : undefined) : view?.completed ? 'success' : undefined}
              strong
            >
              {summary}
            </Typography.Text>
          </span>
          <Space size={8} wrap>
            {bulk}
            {contact}
            {view?.completedAt && (
              <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
                {view.completedAt.slice(0, 10)}
              </Typography.Text>
            )}
          </Space>
        </div>
      ),
      status: (rows.length > 0 ? pending.length === 0 : view?.completed)
        ? ('finish' as const)
        : isCurrent
          ? ('process' as const)
          : ('wait' as const),
      description: body,
    };
  });

  return (
    <>
      <Card
        size="small"
        title={`${title} · ${items.length}품목`}
        extra={
          <Space size={8}>
            <Typography.Text type="secondary">
              {doneStages}/{totalStages} 단계
            </Typography.Text>
            <Progress
              percent={Math.round((doneStages / totalStages) * 100)}
              size="small"
              style={{ width: 120 }}
            />
          </Space>
        }
      >
        <Steps
          size="small"
          direction="vertical"
          current={currentIndex < 0 ? 0 : currentIndex}
          items={stepItems}
        />
      </Card>

      {/* 입고·출고 일자 — 품목 버튼이든 구성품 버튼이든 같은 창을 쓴다 */}
      <Modal
        title={dateAsk?.stage.effect === 'COMPONENT_RECEIVE' ? '입고 처리' : '출고 처리'}
        open={!!dateAsk}
        onCancel={() => {
          setDateAsk(null);
          setPendingKey(undefined);
        }}
        onOk={() => dateForm.submit()}
        okText={dateAsk?.stage.action ?? '처리'}
        cancelText="취소"
        confirmLoading={completeMutation.isPending || componentMutation.isPending}
        destroyOnClose
      >
        <Form
          form={dateForm}
          layout="vertical"
          onFinish={(values: { date: Dayjs }) => {
            if (!dateAsk) return;
            const date = values.date.format('YYYY-MM-DD');
            if (dateAsk.component) {
              componentMutation.mutate({ stage: dateAsk.stage, component: dateAsk.component, date });
              return;
            }
            completeMutation.mutate({
              stage: dateAsk.stage,
              rows: dateAsk.rows,
              date,
              index: dateAsk.index,
            });
          }}
        >
          <Typography.Paragraph type="secondary">
            {dateAsk?.rows.map((r) => r.target.displayName).join(' · ')}
          </Typography.Paragraph>
          <Form.Item
            name="date"
            label={dateAsk?.stage.effect === 'COMPONENT_RECEIVE' ? '실제 입고일' : '고객 출고일'}
            rules={[{ required: true, message: '일자를 선택해 주세요.' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {fittingTarget && (
        <FittingModal
          item={fittingTarget}
          open
          onClose={() => setFittingTarget(null)}
          onRequestFinal={() => {
            // 가봉 피팅 단계의 그 품목을 끝낸다 — 목록 줄의 [완성복발주]와 같은 처리다.
            const at = stages.findIndex((s) => s.extras === 'FITTING');
            const row = rowsOf(at).find((r) => r.key === fittingTarget.orderItemId);
            if (at >= 0 && row) runComplete(stages[at], at, [row]);
          }}
          requestFinalBlocked={(() => {
            const at = stages.findIndex((s) => s.extras === 'FITTING');
            const row = at >= 0 ? rowsOf(at).find((r) => r.key === fittingTarget.orderItemId) : null;
            if (!row) return '이 품목은 가봉 피팅 대상이 아닙니다.';
            if (row.target.completed) return '이미 완성복 발주를 끝냈습니다.';
            return blockedReasonAt(at)(row);
          })()}
          onPreviewForm={() => setFormPreviewItemId(fittingTarget.orderItemId)}
        />
      )}

      {workOrderTarget && (
        <WorkOrderModal
          item={workOrderTarget}
          open
          onClose={() => setWorkOrderTarget(null)}
          onPreviewForm={() => setFormPreviewItemId(workOrderTarget.orderItemId)}
        />
      )}

      <WorkOrderFormPreviewModal
        open={formPreviewItemId != null}
        onClose={() => setFormPreviewItemId(null)}
        orderItemId={formPreviewItemId ?? undefined}
      />

      {/* 발송 확인창 — 담당자가 [발송]을 누를 때만 나간다. 결과는 진행 이력에 봉합한다. */}
      <NotificationConfirmModal
        open={suggestion != null}
        title={suggestionTitle}
        suggestion={suggestion}
        onDone={async (outcome: SendOutcome, notificationHistoryId?: string) => {
          if (suggestion && journeyId) {
            await setNotificationOutcome(journeyId, suggestion.eventId, {
              outcome,
              notificationHistoryId,
            });
          }
          setSuggestion(null);
          invalidate();
        }}
        onCancel={() => setSuggestion(null)}
      />
    </>
  );
}
