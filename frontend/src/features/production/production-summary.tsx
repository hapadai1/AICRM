/**
 * 제작 계약 한 건의 요약 — 목록의 한 행과 상세 화면 머리글이 **같은 값**을 쓰도록 한곳에서 계산한다.
 * 목록에서 고른 행이 상세 상단에 그대로 나와야 하는데, 계산이 화면마다 따로면
 * 같은 계약의 진행률이 목록과 상세에서 다르게 보인다.
 */
import { Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import type { ProductionItem } from '../../api/production';
import { ITEM_STATUS_FLOW } from '../../api/status-catalog';
import { metaOf } from '../../shared/status-meta';
import { WORK_ORDER_STATUS_META } from '../workorders/wo-meta';

/** 진행률 — 품목 제작 흐름(중앙 사전 ITEM_STATUS_FLOW)에서 지금 어디까지 왔는가. */
function itemProgress(status: string): number {
  if (status === 'COMPLETED' || status === 'RELEASED') return 1;
  const i = ITEM_STATUS_FLOW.indexOf(status);
  return i < 0 ? 0 : i / (ITEM_STATUS_FLOW.length - 1);
}

export interface ContractSummary {
  itemCount: number;
  /** 카테고리별 품목 수 (품목 구성 요약) */
  categoryCounts: Record<string, number>;
  /** 카테고리별 맞춤 품목 수 — 목록의 품목 구성 열이 맞춤/렌탈을 나눠 쓴다(계약 목록과 같은 규칙) */
  customCounts: Record<string, number>;
  /** 카테고리별 렌탈 품목 수 */
  rentalCounts: Record<string, number>;
  /** 완성 예정일(납기) — 계약 내 가장 이른 납기 (YYYY-MM-DD). 없으면 null */
  dueDate: string | null;
  receivedCount: number;
  releasedCount: number;
  /** 제작 진행률 % (취소 품목 제외) */
  progressPct: number;
  /** 작업지시서를 내는 품목 수 — 렌탈은 작업지시서가 없는 흐름이라 빠진다 */
  woItemCount: number;
  /** 작업지시서 미출력(옵션·채촌 준비됐으나 미출력) 건수 */
  woUnorderedCount: number;
  /** 옵션·채촌이 남아 아직 출력할 수 없는 건수 */
  woWaitingCount: number;
  woCurrentCount: number;
  cancelledCount: number;
}

export function summarizeContract(items: ProductionItem[]): ContractSummary {
  const s: ContractSummary = {
    itemCount: 0,
    categoryCounts: {},
    customCounts: {},
    rentalCounts: {},
    dueDate: null,
    receivedCount: 0,
    releasedCount: 0,
    progressPct: 0,
    woItemCount: 0,
    woUnorderedCount: 0,
    woWaitingCount: 0,
    woCurrentCount: 0,
    cancelledCount: 0,
  };
  let progressSum = 0;
  let progressCount = 0;
  for (const it of items) {
    s.itemCount += 1;
    s.categoryCounts[it.productCategory] = (s.categoryCounts[it.productCategory] ?? 0) + 1;
    const byType = it.transactionType === 'RENTAL' ? s.rentalCounts : s.customCounts;
    byType[it.productCategory] = (byType[it.productCategory] ?? 0) + 1;
    if (it.itemStatus === 'RECEIVED' || it.itemStatus === 'RELEASED' || it.itemStatus === 'COMPLETED')
      s.receivedCount += 1;
    if (it.itemStatus === 'RELEASED' || it.itemStatus === 'COMPLETED') s.releasedCount += 1;
    if (it.itemStatus === 'CANCELLED') s.cancelledCount += 1;
    else {
      progressSum += itemProgress(it.itemStatus);
      progressCount += 1;
    }
    // 렌탈은 작업지시서를 내지 않는다 — 세면 안 낸 서류가 밀린 일처럼 잡힌다.
    if (it.transactionType !== 'RENTAL') {
      s.woItemCount += 1;
      if (it.workOrder.status === 'UNORDERED') s.woUnorderedCount += 1;
      if (it.workOrder.status === 'WAITING') s.woWaitingCount += 1;
      if (it.workOrder.status === 'CURRENT') s.woCurrentCount += 1;
    }
    const due = it.completionDueDate?.slice(0, 10) ?? null;
    if (due && (!s.dueDate || due < s.dueDate)) s.dueDate = due;
  }
  s.progressPct = progressCount ? Math.round((progressSum / progressCount) * 100) : 0;
  return s;
}

// 품목 구성 문자열은 계약·컨설팅 목록과 같은 규칙을 써야 한다 — 공유본을 그대로 재노출한다.
export { itemComposition } from '../contracts/ItemCompositionCell';

/** 납기 D-day 태그 */
export function DdayTag({ due }: { due: string }) {
  const days = dayjs(due).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (days < 0) return <Tag color="red">D+{-days} 지남</Tag>;
  if (days === 0) return <Tag color="volcano">D-day</Tag>;
  if (days <= 3) return <Tag color="orange">D-{days}</Tag>;
  return <Tag color="default">D-{days}</Tag>;
}

/**
 * 작업지시서 현황 한 칸.
 * '전체 최신'은 낼 서류가 전부 최신일 때만 쓴다 — 예전에는 미출력만 세어서
 * 옵션·채촌이 안 끝나 아직 못 내는 품목(준비 미완)이 있어도 '전체 최신'으로 보였다.
 */
export function WorkOrderCell({ summary }: { summary: ContractSummary }) {
  if (summary.woItemCount === 0) return <Typography.Text type="secondary">-</Typography.Text>;
  if (summary.woCurrentCount === summary.woItemCount) return <Tag color="green">전체 최신</Tag>;
  const parts: { status: string; label: string; count: number }[] = [
    { status: 'UNORDERED', label: '미출력', count: summary.woUnorderedCount },
    { status: 'WAITING', label: '준비 미완', count: summary.woWaitingCount },
    { status: 'CURRENT', label: '최신', count: summary.woCurrentCount },
  ].filter((p) => p.count > 0);
  return (
    <Space size={[6, 6]} wrap>
      {parts.map((p) => (
        <Tag key={p.status} color={metaOf(WORK_ORDER_STATUS_META, p.status).color}>
          {p.label} {p.count}
        </Tag>
      ))}
    </Space>
  );
}

/** 입고 현황 한 칸 — 전체 출고·전체 입고면 태그로, 아니면 건수로 */
export function ReceivedCell({ summary }: { summary: ContractSummary }) {
  if (summary.itemCount > 0 && summary.releasedCount === summary.itemCount)
    return <Tag color="green">전체 출고</Tag>;
  if (summary.itemCount > 0 && summary.receivedCount === summary.itemCount)
    return <Tag color="gold">전체 입고</Tag>;
  return (
    <Typography.Text>
      {summary.receivedCount}/{summary.itemCount}
    </Typography.Text>
  );
}
