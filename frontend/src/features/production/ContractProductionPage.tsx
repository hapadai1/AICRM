/**
 * 계약 1:1 제작 관리 — 품목 한 줄, 펼치면 세로 단계(수선 상태 관리 화면과 같은 방식).
 *
 * 예전에는 열 열한 개짜리 표 하나에 전 단계를 담았다. 가로 스크롤이 생기고 지금 눌러야 할 칸이
 * `다음 할 일` 한 칸에 뭉쳐 있어, 무엇이 남았는지 표를 훑어야 알 수 있었다(2026-08-03 현업 지적).
 * 이제 단계가 화면의 세로 자리가 된다 — 눌러야 할 자리가 곧 그 단계의 위치다.
 *
 * 단계 줄에는 `단계명 · 날짜 · 담당자 · 단계 전체 상태`를 한 줄로 싣는다. 날짜·담당자는
 * 주문 단위 제작 이력(GET /orders/{id}/production-history)에서 그 단계의 마지막 기록을 가져온다.
 *
 * 되돌리기는 각 단계의 완료 칸 옆 ↩ 하나로 모았고(사유 필수), 건너뛰기는 따로 두지 않는다 —
 * 사입 구성품처럼 제작 단계를 밟지 않는 물건은 뒷 단계 버튼을 그냥 누르면 된다(백엔드가 순방향
 * 건너뛰기를 허용한다). 출고만 예외로, 입고 상태에서만 눌린다.
 *
 * 완성복 입고 고객 연락은 여기서 띄우지 않는다(설계서 v2 02 §8 D7 일원화 — 진행 카드로 단일화).
 */
import {
  DownloadOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileExcelOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Progress,
  Space,
  Steps,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { fetchContract } from '../../api/contracts';
import {
  COMPONENT_TYPE_LABELS,
  PRODUCTION_STATUS_META,
  canRequestProduction,
  fetchOrderProductionHistory,
  fetchProductionItems,
  historyKey,
  indexHistory,
  postComponentStatusEvent,
  postItemProductionEvent,
  productionRequestBlockReason,
  receiveComponent,
  releaseComponent,
  type ComponentStatus,
  type ProductionComponent,
  type ProductionItem,
} from '../../api/production';
import { downloadWorkOrderVersionFile } from '../../api/workorders';
import { BackButton } from '../../shared/BackButton';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { COL } from '../../shared/table-width';
import { labelOf, metaOf } from '../../shared/status-meta';
import { WorkOrderFormPreviewModal } from '../workorders/WorkOrderFormPreviewModal';
import { WORK_ORDER_STATUS_META } from '../workorders/wo-meta';
import { ComponentStageProgress } from './ComponentStageProgress';
import {
  activeComponents,
  completedStageCount,
  currentStageIndex,
  stageHasWork,
  stageSummary,
  stagesFor,
  type ProductionStage,
  type RevertTarget,
} from './component-flow';
import { FittingModal } from './FittingModal';

function statusBadge(code: string) {
  const meta = metaOf(PRODUCTION_STATUS_META, code);
  return <StatusBadge label={meta.label} color={meta.color} />;
}
function statusLabel(code: string) {
  return metaOf(PRODUCTION_STATUS_META, code).label;
}

/**
 * 단계 이름 칸 폭. 가장 긴 이름이 다섯 자(작업지시서)라 그 폭에 칸 사이 간격을 더한 값이다 —
 * 단계마다 내용이 같은 자리에서 시작한다(수선 화면 STEP_LABEL_WIDTH와 같은 뜻).
 */
const STAGE_LABEL_WIDTH = 96;

/**
 * 단계 밑 구성품 표를 들여쓰는 폭. 표를 이름 칸 폭만큼 밀면 표 테두리는 맞지만 글자는
 * 셀 여백(8px)만큼 오른쪽으로 밀린다 — 눈이 맞추는 건 테두리가 아니라 글자라 그만큼 뺀다.
 */
const STAGE_BODY_INDENT = STAGE_LABEL_WIDTH - 8;

interface InOutState {
  component: ProductionComponent;
  mode: 'receive' | 'release';
}

/** 되돌리기 확인 — 갈 상태는 이미 정해졌고 사유만 받는다(백엔드 validateTransition이 요구) */
interface RevertState {
  component: ProductionComponent;
  target: RevertTarget;
}

export function ContractProductionPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const { data: contract } = useQuery({
    queryKey: ['contracts', id],
    queryFn: () => fetchContract(id),
    enabled: !!id,
  });

  const itemsQuery = useQuery({
    queryKey: ['production', 'items', id],
    queryFn: () => fetchProductionItems(id),
    enabled: !!id,
  });

  const items = itemsQuery.data ?? [];

  // 단계 줄의 날짜·담당자는 주문 단위 이력에서 온다. 계약에 주문이 여럿이면 그만큼 부른다(대개 하나).
  const orderIds = [...new Set(items.map((i) => i.orderId))];
  const historyQueries = useQueries({
    queries: orderIds.map((orderId) => ({
      queryKey: ['production', 'history', orderId],
      queryFn: () => fetchOrderProductionHistory(orderId),
    })),
  });
  // 이벤트 수가 품목당 수십 건이라 렌더마다 색인해도 부담이 없다 — 캐시 키를 따로 만들지 않는다.
  const eventIndex = indexHistory(historyQueries.flatMap((q) => q.data ?? []));
  const eventOf = (ownerId: string, status: string) => eventIndex.get(historyKey(ownerId, status));

  const [revertTarget, setRevertTarget] = useState<RevertState | null>(null);
  const [inOutTarget, setInOutTarget] = useState<InOutState | null>(null);
  const [fittingTarget, setFittingTarget] = useState<ProductionItem | null>(null);
  /** 양식 미리보기 대상 품목 (출력 전 확인 — 버전이 생기지 않는다) */
  const [formPreviewItemId, setFormPreviewItemId] = useState<string | null>(null);
  /** 접은 품목만 기억한다 — 기본은 전 품목 펼침(계약 하나에 품목이 몇 개 안 된다) */
  const [collapsed, setCollapsed] = useState<string[]>([]);

  const [reasonForm] = Form.useForm<{ reason?: string }>();
  const [inOutForm] = Form.useForm<{ date: Dayjs }>();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['production'] });

  /** 최신 작업지시서 Excel 내려받기 — 저장된 파일을 그대로 주므로 새 버전이 생기지 않는다. */
  const downloadMutation = useMutation({
    mutationFn: (v: { versionId: string; fileName: string }) =>
      downloadWorkOrderVersionFile(v.versionId, v.fileName),
    onError: (e) =>
      message.error(e instanceof ApiError ? e.message : '작업지시서 파일을 내려받지 못했습니다.'),
  });

  const statusMutation = useMutation({
    mutationFn: (v: { componentId: string; toStatus: ComponentStatus; reason?: string }) =>
      postComponentStatusEvent(v.componentId, { toStatus: v.toStatus, reason: v.reason }),
    onSuccess: (_result, v) => {
      message.success(`${statusLabel(v.toStatus)} 상태로 변경되었습니다.`);
      setRevertTarget(null);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.'),
  });

  const inOutMutation = useMutation({
    mutationFn: (v: { componentId: string; mode: 'receive' | 'release'; date: string }) =>
      v.mode === 'receive'
        ? receiveComponent(v.componentId, { receivedDate: v.date })
        : releaseComponent(v.componentId, { releasedDate: v.date }),
    onSuccess: (_result, v) => {
      message.success(v.mode === 'receive' ? '입고 처리되었습니다.' : '출고 처리되었습니다.');
      setInOutTarget(null);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '입출고 처리에 실패했습니다.'),
  });

  // 제작요청은 작업지시서 출력과 커플링하지 않는다 — 담당자가 누르면 바로 완료 처리하는 독립 버튼.
  const requestMutation = useMutation({
    mutationFn: (orderItemId: string) =>
      postItemProductionEvent(orderItemId, { toStatus: 'PRODUCTION_REQUESTED' }),
    onSuccess: () => {
      message.success('제작요청 완료 처리되었습니다.');
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '제작요청 처리에 실패했습니다.'),
  });

  /** 처리 중인 구성품 — 버튼 하나만 돌게 한다 */
  const pendingId = statusMutation.isPending
    ? statusMutation.variables?.componentId
    : inOutMutation.isPending
      ? inOutMutation.variables?.componentId
      : undefined;

  /**
   * 단계 버튼 — 담당자가 작업을 끝내고 한 번 누르면 그대로 완료된다(확인창 없음).
   * 입고·출고만 일자를 남겨야 하므로 날짜 모달을 거친다.
   */
  const runStage = (component: ProductionComponent, stage: ProductionStage) => {
    if (stage.mode) {
      inOutForm.setFieldsValue({ date: dayjs() });
      setInOutTarget({ component, mode: stage.mode });
      return;
    }
    if (!stage.status) return;
    statusMutation.mutate({ componentId: component.id, toStatus: stage.status });
  };

  const openRevert = (component: ProductionComponent, target: RevertTarget) => {
    reasonForm.resetFields();
    setRevertTarget({ component, target });
  };

  /** 준비 단계 — 옵션·채촌이 남아 있으면 그 화면으로 보낸다(왜 출력이 잠겼는지 여기서 읽힌다). */
  const prepBody = (item: ProductionItem) =>
    item.workOrder.canIssue ? null : (
      <Space size={6} wrap>
        <Button size="small" onClick={() => navigate(`/contracts/${item.contractId}/options`)}>
          스타일 컨설팅
        </Button>
        <Button size="small" onClick={() => navigate(`/measurements?customerId=${item.customerId}`)}>
          채촌
        </Button>
      </Space>
    );

  /** 작업지시서 단계 — 출력·미리보기·최신본 내려받기 */
  const workOrderBody = (item: ProductionItem) => {
    const wo = item.workOrder;
    return (
      <Space size={6} wrap>
        <Tooltip title={wo.canIssue ? '' : '옵션 확정과 채촌 완료 후 출력할 수 있습니다.'}>
          <Button
            size="small"
            type={wo.canIssue && wo.status !== 'CURRENT' ? 'primary' : 'default'}
            ghost={wo.canIssue && wo.status !== 'CURRENT'}
            icon={<FileExcelOutlined />}
            disabled={!wo.canIssue}
            onClick={() => navigate(`/work-orders/${item.orderItemId}`)}
          >
            {wo.currentVersionNo ? '재출력' : '출력'}
          </Button>
        </Tooltip>
        {/* 출력 전 양식 확인 — 버전·파일이 생기지 않는다. */}
        <Tooltip
          title={wo.canIssue ? '작업지시서 양식 미리보기' : '옵션 확정과 채촌 완료 후 볼 수 있습니다.'}
        >
          <Button
            size="small"
            icon={<EyeOutlined />}
            disabled={!wo.canIssue}
            onClick={() => setFormPreviewItemId(item.orderItemId)}
          >
            보기
          </Button>
        </Tooltip>
        {/* 최신 출력본은 미리보기 화면을 거치지 않고 여기서 바로 받는다(버전 안 늘어남). */}
        {wo.currentVersionId && wo.currentFileName && (
          <Tooltip title={`최신 출력본 V${wo.currentVersionNo} 내려받기`}>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              loading={
                downloadMutation.isPending &&
                downloadMutation.variables?.versionId === wo.currentVersionId
              }
              onClick={() =>
                downloadMutation.mutate({
                  versionId: wo.currentVersionId as string,
                  fileName: wo.currentFileName as string,
                })
              }
            >
              Excel
            </Button>
          </Tooltip>
        )}
      </Space>
    );
  };

  /** 품목 단위 버튼은 자기 단계 안에 둔다 — 제작요청 완료는 제작요청, 가봉 기록은 가봉. */
  const itemActionOf = (item: ProductionItem, stage: ProductionStage) => {
    if (stage.key === 'PRODUCTION_REQUESTED') {
      // 작업지시서 출력과 커플링하지 않는 독립 버튼 (설계서 11 §9).
      // 이미 보낸 뒤에는 아예 내지 않는다 — 못 누르는 버튼이 남아 있으면 할 일처럼 읽힌다.
      if (!canRequestProduction(item.itemStatus)) return null;
      // 맞춤은 준비(옵션 확정 + 채촌 연결)가 끝나야 제작요청 가능 — 준비 미완이면 잠그고 사유를 보인다.
      const blockReason = productionRequestBlockReason(item);
      return (
        <Can permission="PRODUCTION_EDIT">
          <Tooltip title={blockReason ?? '품목 전체를 제작요청 완료로 표시합니다.'}>
            <Button
              size="small"
              icon={<SendOutlined />}
              disabled={!!blockReason}
              loading={requestMutation.isPending && requestMutation.variables === item.orderItemId}
              onClick={() => requestMutation.mutate(item.orderItemId)}
            >
              품목 제작요청 완료
            </Button>
          </Tooltip>
        </Can>
      );
    }
    if (stage.key === 'BASTING_RECEIVED') {
      return (
        <Can permission="FITTING_EDIT">
          <Button size="small" icon={<ExperimentOutlined />} onClick={() => setFittingTarget(item)}>
            가봉 기록
          </Button>
        </Can>
      );
    }
    return null;
  };

  const stageBody = (
    item: ProductionItem,
    stage: ProductionStage,
    stages: ProductionStage[],
    i: number,
  ) => {
    if (stage.kind === 'PREP') return prepBody(item);
    if (stage.kind === 'WORK_ORDER') return workOrderBody(item);
    const itemAction = itemActionOf(item, stage);
    /*
      아직 끝나지 않은 단계는 순서와 무관하게 전부 버튼을 낸다 (2026-08-04 현업 확정).
      "지금 차례인 단계만" 열면 작업지시서를 출력하기 전에는 제작요청 버튼이 아예 없어서,
      출력과 무관하게 제작요청을 먼저 넣는 실제 순서를 화면이 막는다.
      끝난 단계만 접는다 — 거기 남는 건 이미 지나온 일이다.
    */
    const table = stageHasWork(item, stage) ? (
      <ComponentStageProgress
        item={item}
        stage={stage}
        stages={stages}
        stageIndex={i}
        eventOf={eventOf}
        onAct={runStage}
        onRevert={openRevert}
        pendingId={pendingId}
      />
    ) : null;
    // 구성품이 없는 품목은 단계마다 빈칸이 된다 — 첫 구성품 단계에서 한 번만 이유를 적는다.
    const notice =
      activeComponents(item).length === 0 &&
      stages.find((s) => s.kind === 'COMPONENT')?.key === stage.key ? (
        <Typography.Text type="secondary">
          계약에 등록된 구성품이 없습니다 — 계약 수정에서 부위를 추가하면 생성됩니다.
        </Typography.Text>
      ) : null;
    if (!itemAction && !table && !notice) return null;
    return (
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        {notice}
        {itemAction}
        {table}
      </Space>
    );
  };

  /**
   * 단계 한 줄 — 단계명 옆에 날짜·담당자·그 단계 전체 상태를 이어 붙인다.
   * (`입고    2026-08-18 · 관리자 · 2/3 입고`)
   * 밑으로 내리면 단계마다 두 줄이 되어 여덟 단계가 화면을 한참 넘긴다.
   */
  const stageTitle = (item: ProductionItem, stage: ProductionStage) => {
    const summary = stageSummary(item, stage);
    // 작업지시서 발행자는 목록 응답에 없다 — 발행 일시만 적는다.
    const stamp =
      stage.kind === 'WORK_ORDER'
        ? item.workOrder.lastIssuedAt
        : (() => {
            const status = stage.kind === 'PREP' ? 'READY_TO_ORDER' : stage.status;
            const ev = status ? eventOf(item.orderItemId, status) : undefined;
            return ev ? `${ev.eventDate} · ${ev.actorName}` : undefined;
          })();
    return (
      <>
        {/*
          단계 이름과 내용은 쌍점이 아니라 빈칸으로 가른다 — 한 줄이지만 읽을 때는
          왼쪽(어느 단계)과 오른쪽(무슨 일이 있었나)이 다른 칸이다.
        */}
        <span style={{ display: 'inline-block', minWidth: STAGE_LABEL_WIDTH }}>{stage.label}</span>
        <span style={{ fontWeight: 400 }}>
          {stamp ?? ''}
          {summary.text && (
            <Typography.Text type={summary.done ? 'success' : undefined} strong>
              {stamp ? ' · ' : ''}
              {summary.text}
            </Typography.Text>
          )}
        </span>
      </>
    );
  };

  const expandedRow = (item: ProductionItem) => {
    const stages = stagesFor(item.transactionType);
    const cancelled = item.itemStatus === 'CANCELLED';
    const current = currentStageIndex(item, stages);
    const stepItems = stages.map((stage, i) => {
      // 취소된 품목에는 할 일이 없다 — 버튼·표를 내지 않고 어디까지 갔었는지만 남긴다.
      const body = cancelled ? null : stageBody(item, stage, stages, i);
      return {
        title: stageTitle(item, stage),
        /*
          단계마다 완료 여부를 직접 준다. antd 기본값(current 뒤는 전부 대기)에 맡기면
          작업지시서가 재출력 필요로 되밀렸을 때 이미 끝낸 제작요청·제작중까지 대기로 그려진다 —
          제작은 앞 단계가 되밀려도 뒤 단계가 살아 있는 흐름이다.
          취소는 단계별로 표시하지 않는다(여덟 줄이 모두 빨개진다) — 스텝퍼 전체 상태로만 알린다.
        */
        status: cancelled
          ? undefined
          : stageSummary(item, stage).done
            ? ('finish' as const)
            : i === current
              ? ('process' as const)
              : ('wait' as const),
        // 붙일 게 없는 단계는 설명 칸을 아예 비운다 — 빈 칸도 높이를 차지한다.
        description: body ? (
          <div className="step-body" style={{ paddingLeft: STAGE_BODY_INDENT, paddingBottom: 4 }}>
            {body}
          </div>
        ) : undefined,
      };
    });

    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Steps
          size="small"
          direction="vertical"
          current={cancelled ? -1 : current}
          status={cancelled ? 'error' : current >= stages.length ? 'finish' : 'process'}
          items={stepItems}
        />
        {cancelled && <Typography.Text type="danger">취소된 품목입니다.</Typography.Text>}
      </Space>
    );
  };

  const columns: ColumnsType<ProductionItem> = [
    {
      title: '품목',
      key: 'item',
      width: COL.code,
      render: (_, item) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{item.displayName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.orderNo}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '구성품',
      key: 'components',
      width: COL.wide,
      render: (_, item) => {
        const names = activeComponents(item).map(
          (c) => `${labelOf(COMPONENT_TYPE_LABELS, c.componentType)} #${c.sequenceNo}`,
        );
        return names.length ? (
          names.join(' · ')
        ) : (
          <Typography.Text type="secondary">구성품 없음</Typography.Text>
        );
      },
    },
    {
      title: '상태',
      key: 'status',
      width: COL.status,
      render: (_, item) => statusBadge(item.itemStatus),
    },
    {
      title: '작업지시서',
      key: 'workOrder',
      width: COL.status,
      render: (_, item) => {
        // 렌탈은 작업지시서를 내지 않는 흐름이다 — 준비 미완처럼 보이면 할 일로 읽힌다.
        if (item.transactionType === 'RENTAL') return <Typography.Text type="secondary">-</Typography.Text>;
        const wo = item.workOrder;
        const meta = metaOf(WORK_ORDER_STATUS_META, wo.status);
        return (
          <Space size={6}>
            <StatusBadge label={meta.label} color={meta.color} />
            {wo.currentVersionNo ? (
              <Typography.Text type="secondary">V{wo.currentVersionNo}</Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '완성 예정일',
      key: 'due',
      width: COL.name,
      render: (_, item) =>
        item.completionDueDate ?? <Typography.Text type="secondary">미정</Typography.Text>,
    },
    {
      title: '진행',
      key: 'progress',
      width: COL.wide,
      render: (_, item) => {
        if (item.itemStatus === 'CANCELLED') return <Typography.Text type="danger">취소됨</Typography.Text>;
        const stages = stagesFor(item.transactionType);
        const done = completedStageCount(item, stages);
        const at = currentStageIndex(item, stages);
        return (
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
            <Progress percent={Math.round((done / stages.length) * 100)} size="small" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {at >= stages.length ? '전 단계 완료' : `${stages[at].label} 진행 중`}
            </Typography.Text>
          </Space>
        );
      },
    },
  ];

  if (itemsQuery.error) {
    return (
      <Alert
        type="error"
        showIcon
        message="제작·입출고 목록을 불러오지 못했습니다."
        description={(itemsQuery.error as Error).message}
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* 화면 이동은 하단 [이전화면] 하나로 통일한다 — 계약 상세·제작 목록 양쪽에서 들어오므로 상단에 고정 목적지를 두지 않는다. */}
          <div>
            <Typography.Title level={4} style={{ marginBottom: 4 }}>
              제작 관리 — {contract?.customerName ?? ''}
            </Typography.Title>
            <Typography.Text type="secondary">
              {[contract?.customerPhone, contract?.contractNo].filter(Boolean).join(' · ')}
            </Typography.Text>
          </div>
          <Table<ProductionItem>
            rowKey="orderItemId"
            scroll={{ x: 'max-content' }}
            size="middle"
            loading={itemsQuery.isLoading}
            dataSource={items}
            columns={columns}
            pagination={false}
            expandable={{
              // 기본은 전부 펼침 — 접은 것만 기억한다(품목이 로딩된 뒤에도 규칙이 그대로 산다).
              expandedRowKeys: items
                .map((i) => i.orderItemId)
                .filter((key) => !collapsed.includes(key)),
              onExpand: (expanded, item) =>
                setCollapsed((cur) =>
                  expanded
                    ? cur.filter((key) => key !== item.orderItemId)
                    : [...cur, item.orderItemId],
                ),
              expandedRowRender: expandedRow,
            }}
            locale={{ emptyText: '이 계약에는 제작 대상 품목이 없습니다.' }}
          />
        </Space>
      </Card>

      {/* 계약 상세 등 여러 경로로 들어오므로 뒤로가기로 통일 */}
      <BackButton />

      {/* 되돌리기 확인 — 갈 상태는 단계에서 이미 정해졌고 여기서는 사유만 받는다 */}
      <Modal
        title={
          revertTarget
            ? `${labelOf(COMPONENT_TYPE_LABELS, revertTarget.component.componentType)} #${revertTarget.component.sequenceNo} — ${revertTarget.target.label} 상태로 되돌리기`
            : '되돌리기'
        }
        open={!!revertTarget}
        onCancel={() => setRevertTarget(null)}
        onOk={() => reasonForm.submit()}
        okText="되돌리기"
        cancelText="취소"
        confirmLoading={statusMutation.isPending}
        destroyOnClose
      >
        {revertTarget && (
          <Form
            form={reasonForm}
            layout="vertical"
            onFinish={(values) => {
              statusMutation.mutate({
                componentId: revertTarget.component.id,
                toStatus: revertTarget.target.status,
                reason: values.reason,
              });
            }}
          >
            <Typography.Paragraph type="secondary">
              {statusLabel(revertTarget.component.status)} → {revertTarget.target.label}
            </Typography.Paragraph>
            <Form.Item
              name="reason"
              label="되돌리는 사유"
              rules={[{ required: true, message: '상태 역행 사유를 입력해 주세요.' }]}
            >
              <Input.TextArea rows={2} placeholder="되돌리는 사유 (필수)" />
            </Form.Item>
          </Form>
        )}
      </Modal>

      {/* 입고/출고 모달 */}
      <Modal
        title={inOutTarget?.mode === 'receive' ? '구성품 입고 처리' : '구성품 출고 처리'}
        open={!!inOutTarget}
        onCancel={() => setInOutTarget(null)}
        onOk={() => inOutForm.submit()}
        okText={inOutTarget?.mode === 'receive' ? '입고' : '출고'}
        cancelText="취소"
        confirmLoading={inOutMutation.isPending}
        destroyOnClose
      >
        <Form
          form={inOutForm}
          layout="vertical"
          onFinish={(values: { date: Dayjs }) => {
            if (!inOutTarget) return;
            inOutMutation.mutate({
              componentId: inOutTarget.component.id,
              mode: inOutTarget.mode,
              date: values.date.format('YYYY-MM-DD'),
            });
          }}
        >
          <Form.Item
            name="date"
            label={inOutTarget?.mode === 'receive' ? '실제 입고일' : '고객 출고일'}
            rules={[{ required: true, message: '일자를 선택해 주세요.' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {fittingTarget && (
        <FittingModal item={fittingTarget} open onClose={() => setFittingTarget(null)} />
      )}

      <WorkOrderFormPreviewModal
        open={formPreviewItemId != null}
        onClose={() => setFormPreviewItemId(null)}
        orderItemId={formPreviewItemId ?? undefined}
      />
    </Space>
  );
}
