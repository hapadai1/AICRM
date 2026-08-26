import { CheckOutlined } from '@ant-design/icons';
import { Button, Card, Divider, Space, Steps, Typography } from 'antd';
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
 * 완료/진행중은 앞의 단계 동그라미(체크/번호)와 글자색이 나타내므로 여기서는 칩을 두지 않고
 * 상세만 적는다 — 완료는 "완료일 …", 진행중은 넘겨받은 상세를 그대로 비춘다.
 * (색은 부모 Steps가 done 여부로 회색/파랑을 입힌다 — 제작 관리 단계 표시와 같은 위계.)
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
  if (done) return <span>완료일 {doneDate ?? '-'}</span>;
  return <>{ongoing}</>;
}

/**
 * 계약 1건에 스코프된 진행 요약 행(계약·스타일 컨설팅·채촌·제작 관리)을 만든다.
 * 고객의 모든 데이터를 통째로 집계하지 않고, 이 계약의 주문(contractNo)에 딸린
 * 품목·구성품만 골라 계산·이동시킨다 — 계약이 여러 건이어도 서로 섞이지 않는다.
 *
 * @param opts.includeUnlinkedMeasures 아직 품목에 연결되지 않은 '작성중' 채촌 세션을
 *   이 계약에 귀속시킬지. 진행중인 현재 계약에만 true로 넘긴다.
 * @param opts.productionStage 제작 관리 행을 진행(journey)의 현재 단계로 표시한다
 *   (제작관리 페이지와 같은 데이터·형식: "가봉 피팅 진행중 2/4"). 넘기지 않으면 이 계약의
 *   맞춤 구성품 상태로 계산한다(진행 데이터가 없는 호출부 호환).
 */
export function buildContractTrackRows(
  data: CustomerAggregate,
  contract: CustomerContractRow,
  opts?: {
    includeUnlinkedMeasures?: boolean;
    productionStage?: { text: ReactNode; done: boolean } | null;
  },
): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const contractOrders = data.orders.filter((o) => o.contractNo === contract.contractNo);
  const orderNos = new Set(contractOrders.map((o) => o.orderNo));

  // 계약 — 완료는 완료일/완료예정일, 진행중은 임시저장/서명완료. 상태 구분은 단계 동그라미가 한다.
  rows.push({
    key: 'contract',
    label: '계약',
    status:
      contract.status === 'COMPLETED' ? (
        <Space size={10} wrap>
          <span>완료일 {contract.contractedAt ?? '-'}</span>
          <span>완료예정일 {contract.completionDueDate ?? '-'}</span>
        </Space>
      ) : contract.status === 'CANCELLED' ? (
        <span>취소</span>
      ) : (
        <span>{contract.status === 'SIGNED' ? '서명완료' : '임시저장'}</span>
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

  // 채촌 — 이 계약 품목에 연결된(usedByItemIds) 세션. 완료 판정은 "연결된 세션 존재" 기준.
  // usedByItems는 이름(표시용)이라 매칭에 쓰면 계약 품목 id와 어긋난다 — id 배열로 붙인다.
  const itemIds = new Set(contractOrders.flatMap((o) => (o.items ?? []).map((i) => i.id)));
  const linkedMeasures = data.measurements.filter((m) =>
    (m.usedByItemIds ?? []).some((id) => itemIds.has(id)),
  );
  const contractMeasures = opts?.includeUnlinkedMeasures
    ? [...linkedMeasures, ...data.measurements.filter((m) => (m.usedByItemIds?.length ?? 0) === 0)]
    : linkedMeasures;
  if (contractMeasures.length) {
    // data.measurements는 versionNo 내림차순이라 필터해도 [0]이 최신 세션.
    const latest = contractMeasures[0];
    const linked = contractMeasures.find((m) => (m.usedByItemIds?.length ?? 0) > 0);
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
          <span>{`총 ${contractMeasures.length}회`}</span>
        </Space>
      ),
      done: !!linked,
      to: `/measurements/${latest.id}`,
    });
  }

  // 제작 관리 — 진행(journey)의 현재 단계가 넘어오면 그것으로 표시한다(제작관리 페이지와 동일).
  // 진행 데이터가 없는 호출부는 이 계약의 맞춤(CUSTOM) 구성품 상태로 폴백한다.
  if (opts?.productionStage) {
    rows.push({
      key: 'production',
      label: '제작 관리',
      status: <span>{opts.productionStage.text}</span>,
      done: opts.productionStage.done,
      to: `/contracts/${contract.id}/production`,
    });
  } else {
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
            <span>{`출고 ${released}/${total}`}</span>
          </Space>
        ) : (
          // 전 구성품이 취소된 경우
          <span>취소</span>
        ),
        // 취소만 남았거나 전량 출고면 완료로 간주해 이동 버튼을 가라앉힌다.
        done: !leastStatus || released === total,
        to: `/contracts/${contract.id}/production`,
      });
    }
  }

  return rows;
}

/**
 * 한 그룹(계약 트랙 또는 수선)을 제작관리 페이지와 같은 세로 Steps로 그린다.
 * 완료는 체크 동그라미, 진행중은 번호 동그라미가 앞에 서고, 완료/진행중이 세로로 나란히 비교된다.
 * 각 행은 서로 독립이라 여러 개가 동시에 진행중일 수 있으므로 done만 보고 status를 정한다
 * (현재 단계 하나만 강조하는 current는 쓰지 않는다).
 */
function TrackSteps({ rows }: { rows: SummaryRow[] }) {
  const navigate = useNavigate();
  return (
    <Steps
      size="small"
      direction="vertical"
      items={rows.map((r) => {
        // 완료는 체크·회색으로 가라앉히고, 진행중은 파랑 번호·파랑 글자·파랑 버튼으로 강조한다.
        // 완료 행 버튼은 완료 텍스트와 같은 회색(secondary)으로 맞춰 함께 가라앉힌다.
        const goProps: ButtonProps = r.done
          ? { style: { color: 'rgba(0, 0, 0, 0.45)', borderColor: 'rgba(0, 0, 0, 0.45)' } }
          : { type: 'primary', ghost: true };
        return {
          key: r.key,
          status: r.done ? ('finish' as const) : ('process' as const),
          title: (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                columnGap: 12,
                rowGap: 4,
              }}
            >
              {/* 완료 트랙명은 회색 보통, 진행중 트랙명은 검정 굵게 — 진행중이 먼저 눈에 든다. */}
              <Typography.Text
                strong={!r.done}
                type={r.done ? 'secondary' : undefined}
                style={{ display: 'inline-block', minWidth: 100 }}
              >
                {r.label}
              </Typography.Text>
              {/* 상태·상세: 완료는 회색, 진행중은 파랑(제작 관리 요약 열과 같은 색). */}
              <span style={{ fontWeight: 400, color: r.done ? 'rgba(0, 0, 0, 0.45)' : '#1677ff' }}>
                {r.status}
              </span>
              <Button shape="round" size="small" onClick={() => navigate(r.to)} {...goProps}>
                작업화면으로 이동하기
              </Button>
            </div>
          ),
        };
      })}
    />
  );
}

/**
 * 수선 그룹 — 순차 진행이 아니라 건별 독립이므로 번호 동그라미 Steps를 쓰지 않는다.
 * 앞 마커로만 상태를 구분한다: 진행중은 '-', 완료는 체크(동그라미 없이). 색 위계는 계약 트랙과 같다.
 */
function RepairRows({ rows }: { rows: SummaryRow[] }) {
  const navigate = useNavigate();
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {rows.map((r) => {
        const goProps: ButtonProps = r.done
          ? { style: { color: 'rgba(0, 0, 0, 0.45)', borderColor: 'rgba(0, 0, 0, 0.45)' } }
          : { type: 'primary', ghost: true };
        const color = r.done ? 'rgba(0, 0, 0, 0.45)' : '#1677ff';
        return (
          <div
            key={r.key}
            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 12, rowGap: 4 }}
          >
            {/* 번호 동그라미 대신 마커만 — 진행중은 '-', 완료는 체크. */}
            <span style={{ display: 'inline-flex', justifyContent: 'center', minWidth: 20, color }}>
              {r.done ? <CheckOutlined /> : '-'}
            </span>
            <Typography.Text
              strong={!r.done}
              type={r.done ? 'secondary' : undefined}
              style={{ display: 'inline-block', minWidth: 100 }}
            >
              {r.label}
            </Typography.Text>
            <span style={{ fontWeight: 400, color }}>{r.status}</span>
            <Button shape="round" size="small" onClick={() => navigate(r.to)} {...goProps}>
              작업화면으로 이동하기
            </Button>
          </div>
        );
      })}
    </Space>
  );
}

/**
 * 진행 요약 카드 — 계약 트랙(맞춤·렌탈: 계약·컨설팅·채촌·제작)과 수선을 별개 그룹으로 비춘다.
 * 수선은 맞춤·렌탈과 분리해 다루기로 해(2026-08-20 현업), 계약 트랙 아래 가로줄로 구획하고
 * 번호 없는 마커 목록으로 세운다. 양쪽 다 비어 있으면 아무것도 렌더하지 않는다.
 */
export function ProgressSummaryCard({
  rows,
  repairRows = [],
  title = '진행 요약',
  header,
}: {
  rows: SummaryRow[];
  repairRows?: SummaryRow[];
  title?: string;
  /** 진행 스텝 위에 얹는 정보 블록(무슨 계약의 요약인지). 있으면 구분선으로 스텝과 나눈다. */
  header?: ReactNode;
}) {
  if (rows.length === 0 && repairRows.length === 0) return null;
  return (
    <Card title={title} size="small">
      {header}
      {header && (rows.length > 0 || repairRows.length > 0) && (
        <Divider style={{ margin: '12px 0' }} />
      )}
      {rows.length > 0 && <TrackSteps rows={rows} />}
      {repairRows.length > 0 && (
        <>
          {rows.length > 0 && <Divider style={{ margin: '12px 0' }} />}
          <RepairRows rows={repairRows} />
        </>
      )}
    </Card>
  );
}
