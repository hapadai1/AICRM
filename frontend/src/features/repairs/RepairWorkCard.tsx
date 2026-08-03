import { NotificationOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Empty, Select, Space, Steps, Typography } from 'antd';
import { useState } from 'react';
import {
  REPAIR_STATUS_FLOW,
  fetchRepairs,
  repairStatusMeta,
  repairTypeLabel,
  type Repair,
  type RepairStatus,
} from '../../api/repairs';
import { Can } from '../../shared/Can';
import { PageCard } from '../../shared/PageShell';
import { StatusBadge } from '../../shared/StatusBadge';
import {
  RepairItemProgress,
  repairStageSummary,
  type RepairProgressStage,
} from './RepairItemProgress';

/** 업무 처리 카드는 세로 Steps가 없으므로 단계 이름을 표 위에 직접 적는다. */
const STAGE_LABELS: Record<RepairProgressStage, string> = {
  REQUEST: '수선요청',
  RETURN: '수선 입고',
  RELEASE: '출고',
};

interface RepairWorkCardProps {
  customerOptions: { value: string; label: string }[];
  customerLoading: boolean;
  onCustomerSearch: (keyword: string) => void;
  /** 업무 버튼 클릭 — 목록과 같은 상태변경 확인창을 연다 */
  onWork: (repair: Repair, toStatus: RepairStatus) => void;
  /** 상태변경 처리 중인 수선 건 (버튼 로딩 표시) */
  pendingRepairId?: string;
}

/**
 * 고객 업무 처리 — 고객을 고르면 그 고객의 수선 건을 전부 펼쳐 놓고,
 * 건마다 진행 상태(전체 단계)와 대상 품목을 보여 준 뒤 업무 버튼으로 한 단계씩 넘긴다.
 *
 * 버튼은 "그 단계를 끝냈다"를 기록한다. 지난 단계는 완료 표시로 잠기고,
 * 지금 차례인 단계 하나만 눌린다(백엔드도 바로 다음 단계만 허용한다).
 */
export function RepairWorkCard({
  customerOptions,
  customerLoading,
  onCustomerSearch,
  onWork,
  pendingRepairId,
}: RepairWorkCardProps) {
  const [customerId, setCustomerId] = useState<string | undefined>();

  const repairsQuery = useQuery({
    queryKey: ['repairs', 'work', customerId],
    queryFn: () => fetchRepairs({ customerId, size: 50 }),
    enabled: !!customerId,
  });

  const repairs = repairsQuery.data?.data ?? [];

  return (
    <PageCard title="고객 업무 처리">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Select
          showSearch
          allowClear
          placeholder="고객 검색 (이름·전화)"
          style={{ width: 260 }}
          filterOption={false}
          onSearch={onCustomerSearch}
          loading={customerLoading}
          options={customerOptions}
          value={customerId}
          onChange={setCustomerId}
        />

        {!customerId ? (
          <Typography.Text type="secondary">고객을 선택하면 수선 건이 나옵니다.</Typography.Text>
        ) : repairsQuery.isLoading ? (
          <Typography.Text type="secondary">불러오는 중…</Typography.Text>
        ) : repairs.length === 0 ? (
          <Empty description="이 고객의 수선 건이 없습니다." />
        ) : (
          repairs.map((repair) => (
            <RepairWorkRow
              key={repair.id}
              repair={repair}
              pending={pendingRepairId === repair.id}
              onWork={onWork}
            />
          ))
        )}
      </Space>
    </PageCard>
  );
}

interface RepairWorkRowProps {
  repair: Repair;
  pending: boolean;
  onWork: (repair: Repair, toStatus: RepairStatus) => void;
}

function RepairWorkRow({ repair, pending, onWork }: RepairWorkRowProps) {
  const cancelled = repair.status === 'CANCELLED';
  const doneIndex = REPAIR_STATUS_FLOW.indexOf(repair.status as RepairStatus);
  // 상태 = 그 단계를 끝낸 시점이므로 진행중 표시는 다음 칸이다(출고 완료면 전부 완료).
  const current = cancelled ? -1 : doneIndex + 1;
  // 건 상태는 품목 진행에서 계산된다 — 여기서 손으로 누르는 건 고객 연락뿐이다.
  const notifiable = !cancelled && repair.status === 'RETURNED_TO_SHOP';
  const revertNotify = !cancelled && repair.status === 'CUSTOMER_NOTIFIED';

  return (
    <Space
      direction="vertical"
      size={8}
      style={{ width: '100%', borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 12 }}
    >
      <Space wrap size={8}>
        <Typography.Text strong>{repairTypeLabel(repair.repairType)}</Typography.Text>
        <StatusBadge {...repairStatusMeta(repair.status)} />
        <Typography.Text type="secondary">접수 {repair.requestDate}</Typography.Text>
        {repair.dueDate && (
          <Typography.Text type="secondary">완료 예정 {repair.dueDate}</Typography.Text>
        )}
      </Space>

      <Steps
        size="small"
        labelPlacement="vertical"
        current={current}
        status={cancelled ? 'error' : repair.status === 'RELEASED' ? 'finish' : 'process'}
        items={REPAIR_STATUS_FLOW.map((status) => ({ title: repairStatusMeta(status).label }))}
      />

      <Typography.Text>내용: {repair.description}</Typography.Text>

      {/* 수선요청은 줄마다, 입고·출고는 벌마다 — 수선 목록 상세와 같은 표를 단계별로 쓴다. */}
      {(['REQUEST', 'RETURN', 'RELEASE'] as const).map((stage) => {
        // 단계 이름과 전체 상태는 한 줄에 붙인다 (`수선요청 · 전체 수선요청 완료`).
        const summary = repairStageSummary(repair.items, stage);
        return (
          <Space key={stage} direction="vertical" size={2} style={{ width: '100%' }}>
            <Typography.Text strong style={{ fontSize: 12 }}>
              {STAGE_LABELS[stage]}
              <Typography.Text
                type={summary.done ? 'success' : 'secondary'}
                strong={summary.done}
                style={{ fontSize: 12 }}
              >
                {` · ${summary.text}`}
              </Typography.Text>
            </Typography.Text>
            <RepairItemProgress repair={repair} stage={stage} showSummary={false} />
          </Space>
        );
      })}

      <Can permission="REPAIR_EDIT">
        <Space wrap size={8}>
          {notifiable && (
            <Button
              type="primary"
              icon={<NotificationOutlined />}
              loading={pending}
              onClick={() => onWork(repair, 'CUSTOMER_NOTIFIED')}
            >
              고객 연락
            </Button>
          )}
          {revertNotify && (
            <Button loading={pending} onClick={() => onWork(repair, 'RETURNED_TO_SHOP')}>
              고객 연락 되돌리기
            </Button>
          )}
          {cancelled && <Typography.Text type="danger">취소된 건입니다.</Typography.Text>}
        </Space>
      </Can>
    </Space>
  );
}
