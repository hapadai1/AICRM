/**
 * 단계 하나에 들어가는 품목 표.
 *
 * 행은 **품목**이다(2026-08-04 현업 확정). 완료는 진행(journey)의 품목 단위 기록이고,
 * 구성품 입출고는 그 버튼이 함께 처리한다 — 담당자가 두 곳을 누르지 않게 한다.
 * 구성품별로 따로 처리해야 하는 날(자켓만 먼저 입고)에는 품목 줄을 펼쳐 구성품 버튼을 쓴다.
 */
import { DownOutlined, RightOutlined, RollbackOutlined } from '@ant-design/icons';
import { Button, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ReactNode } from 'react';
import {
  COMPONENT_STATUS_RANK,
  COMPONENT_TYPE_LABELS,
  type ProductionComponent,
  type ProductionItem,
} from '../../api/production';
import type { StageItem } from '../../api/journeys';
import { Can } from '../../shared/Can';
import { labelOf } from '../../shared/status-meta';
import type { ProductionStage } from './production-stages';

export interface StageRow {
  key: string;
  /** 진행의 단계 대상(= 주문 품목) */
  target: StageItem;
  /** 같은 품목의 제작 정보(구성품·작업지시서). 진행에만 있고 제작에 없으면 비어 있다 */
  item?: ProductionItem;
}

interface StageProgressProps {
  rows: StageRow[];
  stage: ProductionStage;
  /** 펼친 품목 — 구성품 줄을 따로 처리할 때만 연다 */
  expandedKeys: string[];
  onToggleExpand: (key: string) => void;
  /** 품목 완료 (구성품 처리까지 함께) */
  onComplete: (row: StageRow) => void;
  /** 완료 취소 — 진행 기록만 되돌린다(구성품 상태는 그대로) */
  onUncomplete: (row: StageRow) => void;
  /** 구성품 하나만 처리 */
  onComponent: (row: StageRow, component: ProductionComponent) => void;
  /**
   * 단계에 얹는 제작 고유 버튼 (작업지시서·가봉).
   * 그 단계가 아직 차례가 아니면 서류도 낼 수 없으므로 잠금 사유를 함께 넘긴다.
   */
  renderExtras?: (item: ProductionItem, blocked: string | null) => ReactNode;
  /** 처리 중인 행 key */
  pendingKey?: string;
  /**
   * 아직 이 단계를 눌러선 안 되는 품목의 사유. 앞 단계를 건너뛰고 뒤 단계를 처리하면
   * 어디까지 왔는지가 기록에서 사라지므로, 순서를 화면이 지킨다.
   */
  blockedReason?: (row: StageRow) => string | null;
}

/**
 * 구성품이 이 단계를 이미 지나왔는지 — 지난 칸은 버튼 대신 사실만 적는다.
 * 품목 단위로 처리하는 단계(발주·가봉 피팅)도 구성품이 어디까지 왔는지는 순번으로 읽을 수 있다.
 */
const ITEM_STAGE_REACHED_AT: Partial<Record<string, string>> = {
  ITEM_REQUEST: 'PRODUCTION_REQUESTED',
  ITEM_FITTING: 'PRODUCTION_COMPLETED',
};

function componentDone(stage: ProductionStage, c: ProductionComponent): boolean {
  if (stage.effect === 'COMPONENT_RECEIVE') return !!c.actualInboundAt || c.status === 'RELEASED';
  if (stage.effect === 'COMPONENT_RELEASE') return !!c.actualOutboundAt;
  if (stage.effect === 'COMPONENT_BASTING')
    return ['BASTING_RECEIVED', 'PRODUCTION_COMPLETED', 'RECEIVED', 'RELEASED'].includes(c.status);
  const need = stage.effect ? ITEM_STAGE_REACHED_AT[stage.effect] : undefined;
  if (!need) return false;
  const at = COMPONENT_STATUS_RANK[c.status];
  const target = COMPONENT_STATUS_RANK[need];
  return at !== undefined && target !== undefined && at >= target;
}

export function StageProgress({
  rows,
  stage,
  expandedKeys,
  onToggleExpand,
  onComplete,
  onUncomplete,
  onComponent,
  renderExtras,
  pendingKey,
  blockedReason,
}: StageProgressProps) {
  if (rows.length === 0) return null;

  /*
    구성품 줄은 그 품목에 구성품이 있을 때만 연다.
    예전에는 단계만 보고 화살표를 냈더니, 부위가 등록되지 않은 품목에서 펼치면
    '등록된 구성품이 없습니다'만 나왔다(2026-08-04 현업 지적).
    이 표가 서는 모든 단계에서 열 수 있다 — 입출고 단계는 구성품별로 처리하고,
    나머지 단계는 상의·하의·베스트가 각각 어디까지 갔는지 확인하는 용도다.
  */
  const hasComponents = (row: StageRow) => (row.item?.components ?? []).some((c) => c.active);
  /** 이 단계에서 구성품을 하나씩 처리할 수 있는가 (아니면 상태만 보여 준다) */
  const perComponent = !!stage.effect?.startsWith('COMPONENT');

  const actionCell = (row: StageRow) => {
    const { target } = row;
    if (target.completed) {
      return (
        <Space size={4}>
          <Typography.Text>
            {target.completedAt?.slice(0, 10)}
            {target.completedByName ? ` · ${target.completedByName}` : ''}
          </Typography.Text>
          <Can permission="JOURNEY_EDIT">
            <Tooltip title="완료 취소 — 진행 기록만 되돌립니다(입출고 일자는 그대로).">
              <Button
                type="text"
                size="small"
                icon={<RollbackOutlined />}
                loading={pendingKey === row.key}
                onClick={() => onUncomplete(row)}
              />
            </Tooltip>
          </Can>
        </Space>
      );
    }
    if (!stage.action) return <Typography.Text type="secondary">미완료</Typography.Text>;
    const blocked = blockedReason?.(row) ?? null;
    return (
      <Space size={6}>
        {/*
          제작 상태(발주 가능·제작 중…)를 함께 적었더니 단계마다 다른 낱말이 늘어서서
          "이 단계를 끝냈는가"가 되레 흐려졌다(2026-08-04 현업 지적). 완료/미완료만 적는다.
        */}
        <Typography.Text type="secondary">미완료</Typography.Text>
        <Can permission="JOURNEY_EDIT">
          <Tooltip title={blocked ?? ''}>
            <Button
              size="small"
              type={blocked ? 'default' : 'primary'}
              ghost={!blocked}
              disabled={!!blocked}
              loading={pendingKey === row.key}
              onClick={() => onComplete(row)}
            >
              {stage.action}
            </Button>
          </Tooltip>
        </Can>
      </Space>
    );
  };

  /** 펼친 품목의 구성품 줄 — 한 벌만 따로 처리하거나, 각 벌이 어디까지 왔는지 본다. */
  const componentRows = (row: StageRow) => {
    const components = (row.item?.components ?? []).filter((c) => c.active);
    if (components.length === 0) return null;
    /*
      구성품 이름을 품목 이름과 같은 자리에서 시작시킨다 —
      셀 여백(8) + 펼침 버튼 폭(24) + 칸 사이(4). 펼친 줄의 기본 여백은 CSS에서 0으로 눌렀다.
    */
    return (
      <Space direction="vertical" size={4} style={{ paddingLeft: 36, paddingBlock: 4 }}>
        {components.map((c) => {
          const name = `${labelOf(COMPONENT_TYPE_LABELS, c.componentType)} #${c.sequenceNo}`;
          const done = componentDone(stage, c);
          const date =
            stage.effect === 'COMPONENT_RECEIVE'
              ? c.actualInboundAt
              : stage.effect === 'COMPONENT_RELEASE'
                ? c.actualOutboundAt
                : undefined;
          return (
            <Space key={c.id} size={8}>
              <Typography.Text style={{ display: 'inline-block', minWidth: 120 }}>
                {name}
              </Typography.Text>
              {/*
                품목 단위로 처리하는 단계(발주·가봉 피팅)에서는 구성품마다 끝내고 말고가 없다.
                여기에 완료/미완료를 적었더니 품목은 '미완료'인데 구성품은 '완료'로 보여
                모순처럼 읽혔다(2026-08-04 현업 지적) — 이름만 적는다.
              */}
              {!perComponent ? null : done ? (
                <Typography.Text type="secondary">{date ?? '완료'}</Typography.Text>
              ) : c.status === 'CANCELLED' ? (
                <Typography.Text type="secondary">취소됨</Typography.Text>
              ) : blockedReason?.(row) ? (
                <Typography.Text type="secondary">대기</Typography.Text>
              ) : (
                <Can permission="PRODUCTION_EDIT">
                  <Button
                    size="small"
                    loading={pendingKey === `${row.key}:${c.id}`}
                    onClick={() => onComponent(row, c)}
                  >
                    {stage.action}
                  </Button>
                </Can>
              )}
            </Space>
          );
        })}
      </Space>
    );
  };

  const columns: ColumnsType<StageRow> = [
    {
      title: '품목',
      key: 'item',
      width: 150,
      render: (_, row) => (
        <Space size={4}>
          {hasComponents(row) && (
            <Button
              type="text"
              size="small"
              icon={expandedKeys.includes(row.key) ? <DownOutlined /> : <RightOutlined />}
              onClick={() => onToggleExpand(row.key)}
            />
          )}
          <Typography.Text strong>{row.target.displayName}</Typography.Text>
        </Space>
      ),
    },
    /*
      액션 칸은 가장 긴 버튼(완성복발주)에 맞춰 딱 그 폭만 잡는다 — 서류 버튼이 그 바로 뒤에서
      시작하도록. 짧은 버튼(발주) 줄에서는 사이가 좀 벌어지지만, 단계마다 서류 버튼이
      다른 자리에서 시작하는 것보다 낫다(2026-08-04 현업 확정).
    */
    { title: stage.label, key: 'action', width: 128, render: (_, row) => actionCell(row) },
    {
      title: '',
      key: 'extras',
      render: (_, row) =>
        renderExtras && row.item ? renderExtras(row.item, blockedReason?.(row) ?? null) : null,
    },
  ];

  return (
    <Table<StageRow>
      size="small"
      rowKey="key"
      showHeader={false}
      columns={columns}
      dataSource={rows}
      pagination={false}
      expandable={{
        showExpandColumn: false,
        expandedRowKeys: expandedKeys.filter((k) => rows.some((r) => r.key === k && hasComponents(r))),
        expandedRowRender: componentRows,
      }}
    />
  );
}
