/**
 * 단계 하나에 들어가는 구성품 표 (수선 RepairItemProgress와 같은 자리·같은 규칙).
 *
 * 예전에는 열 열한 개짜리 표 하나에 전 단계를 담았다. 그러면 지금 눌러야 할 칸이
 * `다음 할 일` 한 칸에 뭉쳐 있어 "무엇이 남았는지"가 읽히지 않았다.
 * 단계마다 그 단계의 버튼만 있는 좁은 표를 그리면, 눌러야 할 자리가 곧 단계 위치가 된다.
 *
 * 이 컴포넌트는 그리기만 한다 — 입출고 일자 모달과 되돌리기 사유 모달은 화면(페이지)이 갖고 있다.
 */
import { RollbackOutlined } from '@ant-design/icons';
import { Button, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  COMPONENT_TYPE_LABELS,
  type ProductionComponent,
  type ProductionHistoryEvent,
  type ProductionItem,
} from '../../api/production';
import { Can } from '../../shared/Can';
import { labelOf } from '../../shared/status-meta';
import {
  hasPassed,
  immediateNextStatus,
  revertTargetOf,
  type ProductionStage,
  type RevertTarget,
} from './component-flow';

/** 단계 안에 들어가는 표라 화면 폭을 다 쓰지 않는다 — 절반 남짓(수선과 같은 규격). */
const TABLE_MAX_WIDTH = 560;

interface ComponentStageProgressProps {
  item: ProductionItem;
  stage: ProductionStage;
  /** 그 품목이 밟는 전체 단계 — 되돌릴 곳을 앞 단계에서 찾는다 */
  stages: ProductionStage[];
  stageIndex: number;
  /** 주체(구성품·품목) id와 상태로 그 단계의 마지막 기록을 찾는다 */
  eventOf: (ownerId: string, status: string) => ProductionHistoryEvent | undefined;
  onAct: (component: ProductionComponent, stage: ProductionStage) => void;
  onRevert: (component: ProductionComponent, target: RevertTarget) => void;
  /** 처리 중인 구성품 id */
  pendingId?: string;
}

function componentLabel(c: ProductionComponent): string {
  return `${labelOf(COMPONENT_TYPE_LABELS, c.componentType)} #${c.sequenceNo}`;
}

export function ComponentStageProgress({
  item,
  stage,
  stages,
  stageIndex,
  eventOf,
  onAct,
  onRevert,
  pendingId,
}: ComponentStageProgressProps) {
  // 비활성 구성품은 계약에서 빠진 것이라 그리지 않는다. 취소는 남겨 사실만 알린다.
  const rows = item.components.filter((c) => c.active);
  if (rows.length === 0) return null;

  const actionCell = (c: ProductionComponent) => {
    if (c.status === 'CANCELLED') return <Typography.Text type="secondary">취소됨</Typography.Text>;

    const event = stage.status ? eventOf(c.id, stage.status) : undefined;

    if (hasPassed(c.status, stage)) {
      // 지금 그 단계에 서 있는 구성품만 한 칸 되돌릴 수 있다 —
      // 출고된 구성품의 입고를 되돌리려면 출고를 먼저 되돌려야 한다(수선과 같은 규칙).
      const revert =
        c.status === stage.status
          ? revertTargetOf(stages, stageIndex, (s) => !!eventOf(c.id, s), item.transactionType)
          : null;
      return (
        <Space size={4}>
          {/*
            기록이 없는 지난 단계 — 선택 단계(가봉)는 실제로 건너뛴 것이지만,
            필수 단계는 어느 경로로든 지나온 것이라 단정 없이 완료로만 적는다.
          */}
          {event ? (
            <Typography.Text>
              {event.eventDate} · {event.actorName}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">{stage.optional ? '건너뜀' : '완료'}</Typography.Text>
          )}
          {revert && (
            <Can permission="PRODUCTION_EDIT">
              <Tooltip title={`${revert.label} 상태로 되돌리기`}>
                <Button
                  type="text"
                  size="small"
                  icon={<RollbackOutlined />}
                  loading={pendingId === c.id}
                  onClick={() => onRevert(c, revert)}
                />
              </Tooltip>
            </Can>
          )}
        </Space>
      );
    }

    if (!stage.action) return <Typography.Text type="secondary">대기</Typography.Text>;

    // 출고는 백엔드가 입고 상태만 받는다(releaseComponent) — 건너뛰기가 통하지 않는 유일한 단계다.
    const blocked = stage.mode === 'release' && c.status !== 'RECEIVED';
    const primary = immediateNextStatus(c.status) === stage.status;
    return (
      <Space size={8}>
        {/* 입고 예정일은 입고 단계에서만 뜻이 있다 — 그 칸에서 바로 읽히도록 버튼 옆에 붙인다. */}
        {stage.mode === 'receive' && c.expectedInboundDate && (
          <Typography.Text type="secondary">예정 {c.expectedInboundDate}</Typography.Text>
        )}
        <Can permission="PRODUCTION_EDIT">
          <Tooltip title={blocked ? '입고 상태의 구성품만 출고할 수 있습니다.' : ''}>
            <Button
              size="small"
              type={primary ? 'primary' : 'default'}
              ghost={primary}
              disabled={blocked}
              loading={pendingId === c.id}
              onClick={() => onAct(c, stage)}
            >
              {stage.action}
            </Button>
          </Tooltip>
        </Can>
      </Space>
    );
  };

  const columns: ColumnsType<ProductionComponent> = [
    { title: '구성품', key: 'component', width: 160, render: (_, c) => componentLabel(c) },
    { title: stage.label, key: 'action', render: (_, c) => actionCell(c) },
  ];

  return (
    <Table<ProductionComponent>
      size="small"
      rowKey="id"
      showHeader={false}
      columns={columns}
      dataSource={rows}
      pagination={false}
      style={{ maxWidth: TABLE_MAX_WIDTH }}
    />
  );
}
