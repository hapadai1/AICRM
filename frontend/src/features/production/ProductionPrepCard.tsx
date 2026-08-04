/**
 * 제작 관리의 `준비` — 계약에 하나뿐이다 (2026-08-04 현업 확정).
 *
 * 준비는 맞춤과 렌탈이 똑같이 밟는다. 계약을 완료하고, 스타일 컨설팅으로 옵션을 확정하고,
 * (맞춤이면) 채촌을 품목에 붙이면 준비가 끝난다. 그래서 흐름 카드마다 준비를 하나씩
 * 세우지 않고 위에 한 번만 세운다 — 좌우로 갈라 놓으면 같은 사실을 두 번 읽게 된다.
 *
 * 준비는 담당자가 누르는 단계가 아니다. 옵션 확정·채촌 연결이 곧 완료 판정이므로
 * 완료 버튼 대신 그 세 줄의 현재 상태와 이동 버튼만 둔다.
 */
import { Button, Card, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { ProductionItem } from '../../api/production';

/** 준비 세 줄의 이름 칸 — 값이 같은 자리에서 시작한다. */
const PREP_LABEL_WIDTH = 130;

interface ProductionPrepCardProps {
  /** 이 계약의 살아있는 제작 품목 (맞춤·렌탈 모두, 취소 제외) */
  items: ProductionItem[];
  /** 계약 완료일 */
  contractedAt?: string | null;
  contractId: string;
  customerId: string;
}

/** `이름  값  날짜` 한 줄 */
function PrepRow({ label, value, date }: { label: string; value: React.ReactNode; date?: string }) {
  return (
    <Space size={8}>
      <Typography.Text style={{ display: 'inline-block', minWidth: PREP_LABEL_WIDTH }}>
        {label}
      </Typography.Text>
      <span style={{ display: 'inline-block', minWidth: 110 }}>{value}</span>
      {date && <Typography.Text type="secondary">{date.slice(0, 10)}</Typography.Text>}
    </Space>
  );
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
    고객당 한 번 재지만 그 기록을 품목마다 연결해야 그 품목의 작업지시서가 열린다.
    그래서 "몇 품목에 붙었는가"로 센다.
  */
  const customItems = items.filter((i) => i.transactionType !== 'RENTAL');
  const measureDates = customItems
    .map((i) => i.workOrder.measurementLinkedAt)
    .filter((v): v is string => !!v)
    .sort();
  const measureDone = customItems.length === 0 || measureDates.length === customItems.length;

  // 준비 = 계약·스타일 컨설팅·채촌. 제작 화면에 떴다는 것이 곧 계약완료라 계약은 늘 끝나 있다.
  const checks = [true, optionDone, ...(customItems.length > 0 ? [measureDone] : [])];
  const doneCount = checks.filter(Boolean).length;
  const allDone = doneCount === checks.length;

  return (
    <Card
      size="small"
      title="준비"
      extra={
        // 기능 버튼은 카드 머리 오른쪽에 둔다 — 화면 규칙.
        <Space size={8}>
          <Typography.Text type={allDone ? 'success' : undefined} strong>
            {allDone ? '준비 완료' : `${doneCount}/${checks.length} 진행중`}
          </Typography.Text>
          <Button size="small" onClick={() => navigate(`/contracts/${contractId}/options`)}>
            스타일 컨설팅
          </Button>
          <Button size="small" onClick={() => navigate(`/measurements?customerId=${customerId}`)}>
            채촌
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <PrepRow label="계약" value="완료" date={contractedAt ?? undefined} />
        <PrepRow
          label="스타일 컨설팅"
          value={
            <Typography.Text type={optionDone ? 'success' : undefined}>
              {optionDates.length}/{items.length} 완료
            </Typography.Text>
          }
          date={optionDone ? optionDates[optionDates.length - 1] : undefined}
        />
        {/*
          채촌은 완료하면 그 고객의 미연결 품목에 자동으로 붙는다(2026-08-04 현업 확정).
          그래서 보통은 완료/미완료 둘 중 하나고, 발주 뒤에 품목이 늘어난 경우처럼
          일부만 붙은 때에만 몇 품목이 남았는지 적는다.
        */}
        {customItems.length > 0 && (
          <PrepRow
            label="채촌"
            value={
              measureDone ? (
                <Typography.Text type="success">완료</Typography.Text>
              ) : measureDates.length === 0 ? (
                <Typography.Text type="warning">미완료</Typography.Text>
              ) : (
                <Typography.Text type="warning">
                  {measureDates.length}/{customItems.length} 연결
                </Typography.Text>
              )
            }
            date={measureDates[0]}
          />
        )}
      </Space>
    </Card>
  );
}
