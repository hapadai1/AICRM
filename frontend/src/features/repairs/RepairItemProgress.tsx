/**
 * 수선 품목 진행 표 (현업 확정 2026-08-01).
 *
 * 수선은 건이 아니라 물건 단위로 움직인다. 상의는 돌아왔는데 하의는 아직 수선집에 있는 일이
 * 흔한데, 예전에는 건 하나에 상태가 하나뿐이라 그 상황을 적을 자리가 없었다.
 *  - 수선요청은 접수 줄 단위 (상의 2벌은 한 번에 보낸다)
 *  - 입고·출고는 벌 단위 (상의 #1, 상의 #2 각각)
 *
 * 표는 단계(수선 요청·수선 입고·출고 완료) 안에 들어간다 — 한 표에 세 단계를 모두 담으니
 * 폭이 화면을 가로지르고 지금 눌러야 할 칸이 어디인지 흐려졌다(2026-08-01 현업 지적).
 * 그래서 단계마다 그 단계의 버튼만 있는 좁은 표를 그린다.
 */
import { RollbackOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiError } from '../../api/client';
import {
  REPAIR_COMPONENT_TYPE_LABELS,
  advanceRepairUnit,
  requestRepairItem,
  revertRepairItemRequest,
  revertRepairUnit,
  type Repair,
  type RepairEvent,
  type RepairItem,
  type RepairUnit,
} from '../../api/repairs';
import { Can } from '../../shared/Can';

/** 어느 단계의 버튼을 그릴지 — 수선요청(줄 단위) / 입고·출고(벌 단위) */
export type RepairProgressStage = 'REQUEST' | 'RETURN' | 'RELEASE';

interface RepairItemProgressProps {
  repair: Repair;
  stage: RepairProgressStage;
  /** 단계 전체 상태를 표 위에 그릴지. 단계 머리글에 붙여 쓰는 화면은 끄고 직접 그린다. */
  showSummary?: boolean;
}

/** 단계 안에 들어가는 표라 화면 폭을 다 쓰지 않는다 — 절반 남짓. */
const TABLE_MAX_WIDTH = 520;

interface ProgressRow {
  key: string;
  item: RepairItem;
  /** 입고·출고 단계에서만 있다(수선요청은 줄 단위) */
  unit?: RepairUnit;
}

function buildRows(items: RepairItem[], stage: RepairProgressStage): ProgressRow[] {
  if (stage === 'REQUEST') return items.map((item) => ({ key: item.id, item }));
  return items.flatMap<ProgressRow>((item) =>
    item.units.length === 0
      ? [{ key: item.id, item }]
      : item.units.map((unit) => ({ key: unit.id, item, unit })),
  );
}

/**
 * 줄은 개수(`상의(자켓) 2`), 벌은 번호(`상의(자켓) #1`)를 항상 붙인다.
 * 1개일 때 숫자를 감췄더니 몇 벌짜리 건인지 표에서 읽히지 않았다(2026-08-01 현업 지적).
 */
function productLabel(row: ProgressRow): string {
  const name = REPAIR_COMPONENT_TYPE_LABELS[row.item.targetProduct] ?? row.item.targetProduct;
  return row.unit ? `${name} #${row.unit.unitNo}` : `${name} ${row.item.quantity}`;
}

/**
 * 단계 전체 상태 — 그 단계의 품목이 전부 끝났는지 한 줄로 알려 준다.
 * 품목이 늘면 표를 훑어야 "다 됐나?"를 알 수 있어서, 단계마다 결론을 먼저 적는다.
 */
export function repairStageSummary(
  items: RepairItem[],
  stage: RepairProgressStage,
): { text: string; done: boolean } {
  const units = items.flatMap((item) => item.units);
  if (stage === 'REQUEST') {
    const done = items.length > 0 && items.every((item) => !!item.requestedAt);
    return { text: done ? '전체 수선요청 완료' : '진행중', done };
  }
  if (stage === 'RETURN') {
    // 출고된 벌도 입고를 지나왔다.
    const done = units.length > 0 && units.every((unit) => unit.status !== 'PENDING');
    return { text: done ? '전체 입고 완료' : '진행중', done };
  }
  const done = units.length > 0 && units.every((unit) => unit.status === 'RELEASED');
  return { text: done ? '전체 출고 완료' : '진행중', done };
}

/** 그 대상의 마지막 이벤트 — 되돌렸다 다시 진행해도 최신 기록이 남는다. */
function lastEvent(events: RepairEvent[], match: (event: RepairEvent) => boolean) {
  let found: RepairEvent | undefined;
  for (const event of events) if (match(event)) found = event;
  return found;
}

export function RepairItemProgress({ repair, stage, showSummary = true }: RepairItemProgressProps) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (action: { key: string; done: string; run: () => Promise<Repair> }) => action.run(),
    onSuccess: (_result, action) => {
      void queryClient.invalidateQueries({ queryKey: ['repairs'] });
      void queryClient.invalidateQueries({ queryKey: ['journeys'] });
      message.success(action.done);
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.'),
  });

  const pendingKey = mutation.isPending ? mutation.variables?.key : undefined;
  const cancelled = repair.status === 'CANCELLED';
  const rows = buildRows(repair.items, stage);
  const summary = repairStageSummary(repair.items, stage);

  /** 되돌리기 아이콘 버튼 — 단계마다 같은 모양이라 한곳에서 만든다. */
  const revertButton = (key: string, tooltip: string, run: () => Promise<Repair>) => (
    <Can permission="REPAIR_EDIT">
      <Tooltip title={tooltip}>
        <Button
          type="text"
          size="small"
          icon={<RollbackOutlined />}
          loading={pendingKey === key}
          onClick={() => mutation.mutate({ key, done: '한 단계 되돌렸습니다.', run })}
        />
      </Tooltip>
    </Can>
  );

  /** 수선요청 칸 (줄 단위) */
  const renderRequest = (row: ProgressRow) => {
    const item = row.item;
    const key = `item:${item.id}`;
    const event = lastEvent(
      repair.events,
      (e) => e.itemId === item.id && e.newStatus === 'REQUESTED',
    );
    if (item.requestedAt)
      return (
        <Space size={4}>
          <Typography.Text>{event?.eventDate ?? item.requestedAt}</Typography.Text>
          {!cancelled &&
            revertButton(key, '수선요청 되돌리기', () =>
              revertRepairItemRequest(repair.id, item.id),
            )}
        </Space>
      );
    if (cancelled) return <Typography.Text type="secondary">-</Typography.Text>;
    return (
      <Can permission="REPAIR_EDIT">
        <Button
          size="small"
          loading={pendingKey === key}
          onClick={() =>
            mutation.mutate({
              key,
              done: '수선요청을 완료했습니다.',
              run: () => requestRepairItem(repair.id, item.id),
            })
          }
        >
          수선요청
        </Button>
      </Can>
    );
  };

  /** 입고·출고 칸 (벌 단위) */
  const renderUnit = (row: ProgressRow) => {
    const unit = row.unit;
    if (!unit) return <Typography.Text type="secondary">대상 벌 정보 없음</Typography.Text>;
    const key = `unit:${unit.id}`;
    const returning = stage === 'RETURN';
    // 입고 단계에서는 출고된 벌도 '입고 완료'로 본다 — 이미 지나온 칸이다.
    const done = returning ? unit.status !== 'PENDING' : unit.status === 'RELEASED';
    const event = lastEvent(
      repair.events,
      (e) => e.unitId === unit.id && e.newStatus === (returning ? 'RETURNED' : 'RELEASED'),
    );

    if (done) {
      // 출고된 벌의 입고는 출고를 먼저 되돌려야 풀 수 있다 — 그 단계에서만 되돌리기를 준다.
      const revertable = returning ? unit.status === 'RETURNED' : true;
      return (
        <Space size={4}>
          <Typography.Text>
            {returning ? '입고 완료' : '출고 완료'}
            {event ? ` (${event.eventDate})` : ''}
          </Typography.Text>
          {!cancelled &&
            revertable &&
            revertButton(key, returning ? '입고 되돌리기' : '출고 되돌리기', () =>
              revertRepairUnit(repair.id, unit.id),
            )}
        </Space>
      );
    }
    if (cancelled) return <Typography.Text type="secondary">-</Typography.Text>;
    return (
      <Space size={8}>
        <Typography.Text type="secondary">대기</Typography.Text>
        <Can permission="REPAIR_EDIT">
          <Button
            size="small"
            type="primary"
            ghost
            loading={pendingKey === key}
            // 수선요청 전에는 물건이 아직 매장에 있고, 입고 전에는 내줄 것이 없다.
            disabled={returning ? !row.item.requestedAt : unit.status !== 'RETURNED'}
            onClick={() =>
              mutation.mutate({
                key,
                done: returning ? '입고 처리했습니다.' : '출고 처리했습니다.',
                run: () => advanceRepairUnit(repair.id, unit.id, returning ? 'RETURNED' : 'RELEASED'),
              })
            }
          >
            {returning ? '입고' : '출고'}
          </Button>
        </Can>
      </Space>
    );
  };

  const columns: ColumnsType<ProgressRow> = [
    { title: '품목', key: 'product', width: 180, render: (_, row) => productLabel(row) },
    {
      title: stage === 'REQUEST' ? '수선요청' : stage === 'RETURN' ? '입고' : '출고',
      key: 'action',
      render: (_, row) => (stage === 'REQUEST' ? renderRequest(row) : renderUnit(row)),
    },
  ];

  return (
    <Space direction="vertical" size={4} style={{ maxWidth: TABLE_MAX_WIDTH, width: '100%' }}>
      {showSummary && (
        <Typography.Text type={summary.done ? 'success' : 'secondary'} strong={summary.done}>
          {summary.text}
        </Typography.Text>
      )}
      <Table<ProgressRow>
        size="small"
        rowKey="key"
        showHeader={false}
        columns={columns}
        dataSource={rows}
        pagination={false}
      />
    </Space>
  );
}
