import { Button, Card, List, Space, Tag, Typography } from 'antd';
import type { ButtonProps } from 'antd';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CustomerAggregate, CustomerContractRow } from '../../api/customers';
import { COMPONENT_STATUS_RANK } from '../../api/production';
import { COMPONENT_STATUS_META } from '../../api/status-catalog';
import { metaOf } from '../../shared/status-meta';

/**
 * 진행 요약 한 줄. 계약 1건에 스코프된 계약·컨설팅·채촌·제작 상태를 표현한다.
 * (고객 상세는 현재 계약, 계약 상세는 해당 계약을 넘겨 같은 표시를 재사용한다.)
 */
export interface SummaryRow {
  key: string;
  label: string;
  status: ReactNode;
  /** 완료된 단계인지. 완료 행은 이동 버튼을 눈에 덜 띄게(검은색) 출력한다. */
  done: boolean;
  to: string;
}

/**
 * 진행 요약 한 줄의 상태 표기.
 * 진행중 단계가 사용자 눈에 먼저 들어와야 하므로 진행중은 초록 칩으로 강조하고,
 * 완료는 회색 칩으로 가라앉힌다. ongoing에는 "진행중 ·" 접두 없이 상세만 넘긴다.
 */
function ProgressStatus({
  done,
  doneDate,
  ongoing,
}: {
  done: boolean;
  doneDate?: string | null;
  ongoing: ReactNode;
}) {
  if (done) {
    return (
      <Space size={6}>
        <Tag>완료</Tag>
        <Typography.Text>완료일 {doneDate ?? '-'}</Typography.Text>
      </Space>
    );
  }
  return (
    <Space size={6}>
      <Tag color="success">진행중</Tag>
      {ongoing}
    </Space>
  );
}

/**
 * 계약 1건에 스코프된 진행 요약 행(계약·스타일 컨설팅·채촌·제작 관리)을 만든다.
 * 고객의 모든 데이터를 통째로 집계하지 않고, 이 계약의 주문(contractNo)에 딸린
 * 품목·구성품만 골라 계산·이동시킨다 — 계약이 여러 건이어도 서로 섞이지 않는다.
 *
 * @param opts.includeUnlinkedMeasures 아직 품목에 연결되지 않은 '작성중' 채촌 세션을
 *   이 계약에 귀속시킬지. 진행중인 현재 계약에만 true로 넘긴다.
 */
export function buildContractTrackRows(
  data: CustomerAggregate,
  contract: CustomerContractRow,
  opts?: { includeUnlinkedMeasures?: boolean },
): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const contractOrders = data.orders.filter((o) => o.contractNo === contract.contractNo);
  const orderNos = new Set(contractOrders.map((o) => o.orderNo));

  // 계약 — 완료는 회색 '완료' 칩 + 완료일/완료예정일, 진행중은 초록 칩 + 임시저장/서명완료.
  rows.push({
    key: 'contract',
    label: '계약',
    status:
      contract.status === 'COMPLETED' ? (
        <Space size={10} wrap>
          <Tag>완료</Tag>
          <Typography.Text>완료일 {contract.contractedAt ?? '-'}</Typography.Text>
          <Typography.Text>완료예정일 {contract.completionDueDate ?? '-'}</Typography.Text>
        </Space>
      ) : contract.status === 'CANCELLED' ? (
        <span>취소</span>
      ) : (
        <Space size={6}>
          <Tag color="success">진행중</Tag>
          <span>{contract.status === 'SIGNED' ? '서명완료' : '임시저장'}</span>
        </Space>
      ),
    done: contract.status === 'COMPLETED' || contract.status === 'CANCELLED',
    to: `/contracts/${contract.id}`,
  });

  // 스타일 컨설팅 — 이 계약의 맞춤(CUSTOM) 품목 옵션 확정 진척.
  const customItems = contractOrders
    .filter((o) => o.transactionType === 'CUSTOM')
    .flatMap((o) => o.items ?? []);
  if (customItems.length) {
    const confirmed = customItems.filter((i) => i.optionStatus === 'CONFIRMED').length;
    const allConfirmed = confirmed === customItems.length;
    const confirmedDates = customItems
      .map((i) => i.optionConfirmedAt)
      .filter((d): d is string => !!d)
      .sort();
    rows.push({
      key: 'option',
      label: '스타일 컨설팅',
      status: (
        <ProgressStatus
          done={allConfirmed}
          doneDate={confirmedDates[confirmedDates.length - 1]}
          ongoing={<span>{`옵션 확정 ${confirmed}/${customItems.length} 품목`}</span>}
        />
      ),
      done: allConfirmed,
      to: `/contracts/${contract.id}/options`,
    });
  }

  // 채촌 — 이 계약 품목에 연결된(usedByItems) 세션. 완료 판정은 "연결된 세션 존재" 기준.
  const itemIds = new Set(contractOrders.flatMap((o) => (o.items ?? []).map((i) => i.id)));
  const linkedMeasures = data.measurements.filter((m) =>
    (m.usedByItems ?? []).some((id) => itemIds.has(id)),
  );
  const contractMeasures = opts?.includeUnlinkedMeasures
    ? [...linkedMeasures, ...data.measurements.filter((m) => (m.usedByItems?.length ?? 0) === 0)]
    : linkedMeasures;
  if (contractMeasures.length) {
    // data.measurements는 versionNo 내림차순이라 필터해도 [0]이 최신 세션.
    const latest = contractMeasures[0];
    const linked = contractMeasures.find((m) => (m.usedByItems?.length ?? 0) > 0);
    rows.push({
      key: 'measure',
      label: '채촌',
      status: (
        <Space size={6} wrap>
          <ProgressStatus
            done={!!linked}
            doneDate={linked?.completedAt ?? linked?.date}
            ongoing={<span>작성중</span>}
          />
          <Typography.Text>{`총 ${contractMeasures.length}회`}</Typography.Text>
        </Space>
      ),
      done: !!linked,
      to: `/measurements/${latest.id}`,
    });
  }

  // 제작 관리 — 이 계약의 맞춤(CUSTOM) 구성품만. 렌탈은 제작 관리 상세에서 확인.
  const customComponents = data.components.filter(
    (c) => orderNos.has(c.orderNo) && c.transactionType !== 'RENTAL',
  );
  if (customComponents.length) {
    // 취소 구성품은 진행률·대표 상태 계산에서 제외한다(분모 왜곡·병목 오인 방지).
    const active = customComponents.filter((c) => c.status !== 'CANCELLED');
    const total = active.length;
    const released = active.filter((c) => c.status === 'RELEASED').length;
    const outboundDates = active
      .map((c) => c.actualOutboundAt)
      .filter((d): d is string => !!d)
      .sort();
    // 진행중 대표 상태 = 가장 덜 진행된 구성품(병목)의 상태.
    const leastStatus = [...active].sort(
      (a, b) => (COMPONENT_STATUS_RANK[a.status] ?? 0) - (COMPONENT_STATUS_RANK[b.status] ?? 0),
    )[0]?.status;
    rows.push({
      key: 'production',
      label: '제작 관리',
      status: leastStatus ? (
        <Space size={6} wrap>
          <ProgressStatus
            done={released === total}
            doneDate={outboundDates[outboundDates.length - 1]}
            ongoing={<span>{metaOf(COMPONENT_STATUS_META, leastStatus).label}</span>}
          />
          <Typography.Text>{`출고 ${released}/${total}`}</Typography.Text>
        </Space>
      ) : (
        // 전 구성품이 취소된 경우
        <Typography.Text>취소</Typography.Text>
      ),
      // 취소만 남았거나 전량 출고면 완료로 간주해 이동 버튼을 가라앉힌다.
      done: !leastStatus || released === total,
      to: `/contracts/${contract.id}/production`,
    });
  }

  return rows;
}

/**
 * 진행 요약 카드 — 넘겨받은 행을 그대로 비추고 각 행의 작업화면으로 이동만 시킨다.
 * 행이 없으면(진행중 트랙 없음) 아무것도 렌더하지 않는다.
 */
export function ProgressSummaryCard({
  rows,
  title = '진행 요약',
}: {
  rows: SummaryRow[];
  title?: string;
}) {
  const navigate = useNavigate();
  if (rows.length === 0) return null;
  return (
    <Card title={title} size="small">
      <List
        size="small"
        dataSource={rows}
        renderItem={(r) => {
          // 진행중 행은 파란 버튼으로 눈에 띄게, 완료 행은 검은 버튼으로 가라앉힌다.
          const goProps: ButtonProps = r.done
            ? { style: { color: 'rgba(0, 0, 0, 0.88)', borderColor: 'rgba(0, 0, 0, 0.88)' } }
            : { type: 'primary', ghost: true };
          return (
          <List.Item
            actions={[
              <Button
                key="go"
                shape="round"
                size="small"
                onClick={() => navigate(r.to)}
                {...goProps}
              >
                작업화면으로 이동하기
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={r.label}
              // 상태·날짜 글자는 굵기는 그대로 두고 색만 진하게(어둡게) 출력한다.
              description={<span style={{ color: 'rgba(0, 0, 0, 0.88)' }}>{r.status}</span>}
            />
          </List.Item>
          );
        }}
      />
    </Card>
  );
}
