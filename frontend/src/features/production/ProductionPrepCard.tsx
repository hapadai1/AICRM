/**
 * 제작 관리의 `준비` — 계약에 하나뿐이다 (2026-08-04 현업 확정).
 *
 * 준비는 맞춤과 렌탈이 똑같이 밟는다. 계약을 완료하고, 스타일 컨설팅으로 옵션을 확정하고,
 * (맞춤이면) 채촌을 품목에 붙이면 준비가 끝난다. 그래서 흐름 카드마다 준비를 하나씩
 * 세우지 않고 위에 한 번만 세운다 — 좌우로 갈라 놓으면 같은 사실을 두 번 읽게 된다.
 *
 * 줄 모양은 단계 품목 표(StageProgress)와 같게 맞춘다 — 이름·상태·버튼·날짜가 같은 자리에
 * 서야 위아래 카드를 같은 눈으로 읽는다(2026-08-04 현업 지적).
 * 준비는 담당자가 완료를 누르는 단계가 아니므로 완료 버튼 자리에 이동 버튼이 선다.
 */
import { Button, Card, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProductionItem } from '../../api/production';

/** 단계 표와 같은 칸 폭 — 이름 150 · 상태 128 (StageProgress와 맞춘다) */
const NAME_WIDTH = 150;
const STATUS_WIDTH = 128;
/** 단계 표의 품목 이름은 펼침 버튼(24) 뒤에서 시작한다 — 준비도 같은 x에 세운다. */
const NAME_INDENT = 28;

interface ProductionPrepCardProps {
  /** 이 계약의 살아있는 제작 품목 (맞춤·렌탈 모두, 취소 제외) */
  items: ProductionItem[];
  /** 계약 완료일 */
  contractedAt?: string | null;
  contractId: string;
  customerId: string;
}

interface PrepRow {
  key: string;
  label: string;
  /** 이 줄이 끝났는가 */
  done: boolean;
  /** 상태 칸 문구 (완료·미완료·2/6 완료) */
  status: string;
  date?: string;
  /** 상태 칸 오른쪽 이동 버튼 */
  action?: ReactNode;
}

export function ProductionPrepCard({
  items,
  contractedAt,
  contractId,
  customerId,
}: ProductionPrepCardProps) {
  const navigate = useNavigate();

  // 옵션은 품목마다 고른다 — 맞춤·렌탈 가릴 것 없이 전 품목이 대상이다.
  const optionDates = items
    .map((i) => i.workOrder.optionConfirmedAt)
    .filter((v): v is string => !!v)
    .sort();
  const optionDone = optionDates.length === items.length && items.length > 0;

  /*
    채촌은 맞춤에만 필요하다 — 렌탈은 우리 재고를 고쳐 내주는 것이라 치수를 새로 재지 않는다.
    완료하면 그 계약의 맞춤 품목에 자동으로 붙으므로 보통은 완료/미완료 둘 중 하나고,
    발주 뒤에 품목이 늘어난 경우처럼 일부만 붙은 때에만 몇 품목이 남았는지 적는다.
  */
  const customItems = items.filter((i) => i.transactionType !== 'RENTAL');
  const measureDates = customItems
    .map((i) => i.workOrder.measurementLinkedAt)
    .filter((v): v is string => !!v)
    .sort();
  const measureDone = customItems.length === 0 || measureDates.length === customItems.length;

  const rows: PrepRow[] = [
    // 제작 화면에 떴다는 것이 곧 계약완료라 계약은 늘 끝나 있다.
    { key: 'contract', label: '계약', done: true, status: '완료', date: contractedAt ?? undefined },
    {
      key: 'consulting',
      label: '스타일 컨설팅',
      done: optionDone,
      status: optionDone ? '완료' : `${optionDates.length}/${items.length} 완료`,
      date: optionDone ? optionDates[optionDates.length - 1] : undefined,
      action: (
        <Button size="small" onClick={() => navigate(`/contracts/${contractId}/options`)}>
          스타일 컨설팅
        </Button>
      ),
    },
  ];
  if (customItems.length > 0) {
    rows.push({
      key: 'measurement',
      label: '채촌',
      done: measureDone,
      status: measureDone
        ? '완료'
        : measureDates.length === 0
          ? '미완료'
          : `${measureDates.length}/${customItems.length} 연결`,
      date: measureDates[0],
      action: (
        <Button size="small" onClick={() => navigate(`/measurements?customerId=${customerId}`)}>
          채촌
        </Button>
      ),
    });
  }

  const doneCount = rows.filter((r) => r.done).length;
  const allDone = doneCount === rows.length;

  const columns: ColumnsType<PrepRow> = [
    {
      title: '항목',
      key: 'label',
      width: NAME_WIDTH,
      render: (_, row) => (
        <Typography.Text strong style={{ paddingLeft: NAME_INDENT }}>
          {row.label}
        </Typography.Text>
      ),
    },
    {
      title: '상태',
      key: 'status',
      width: STATUS_WIDTH,
      render: (_, row) => (
        <Typography.Text type={row.done ? 'success' : 'secondary'}>{row.status}</Typography.Text>
      ),
    },
    {
      title: '',
      key: 'action',
      // 단계 표의 서류 버튼과 같은 자리 — 버튼 뒤에 날짜가 붙는다(단계 줄과 같은 순서).
      render: (_, row) => (
        <Space size={8}>
          {row.action}
          {row.date && (
            <Typography.Text type="secondary">{row.date.slice(0, 10)}</Typography.Text>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="준비"
      extra={
        <Typography.Text type={allDone ? 'success' : undefined} strong>
          {allDone ? '준비 완료' : `${doneCount}/${rows.length} 진행중`}
        </Typography.Text>
      }
    >
      <Table<PrepRow>
        size="small"
        rowKey="key"
        showHeader={false}
        columns={columns}
        dataSource={rows}
        pagination={false}
      />
    </Card>
  );
}
