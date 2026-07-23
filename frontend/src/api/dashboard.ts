/** DASH-001 대시보드 API (03문서 §13.7) */
import { request } from './client';

/** 확인사항 유형 — 계약 문서 04 §10 taskCounts 키와 동일 */
export type DashboardTaskType =
  | 'LATE_RETURN'
  | 'INBOUND_DELAY'
  | 'PAYMENT_DELAY'
  | 'UNORDERED'
  | 'REPRINT_NEEDED';

export interface DashboardAppointment {
  id: string;
  customerId?: string;
  customerName: string;
  purposeCode: string;
  purposeName: string;
  startAt: string;
  endAt: string;
  status: 'RESERVED' | 'CONFIRMED' | 'VISITED' | 'CANCELLED' | 'NO_SHOW';
  source: 'NAVER' | 'CRM';
}

export interface DashboardWeekDay {
  date: string;
  count: number;
}

export interface DashboardSummary {
  date: string;
  appointments: DashboardAppointment[];
  week: DashboardWeekDay[];
  taskCounts: Record<DashboardTaskType, number>;
}

export interface DashboardTask {
  taskId: string;
  taskType: DashboardTaskType;
  customerId?: string;
  customerName: string;
  contractId?: string;
  orderId?: string;
  orderNo?: string;
  orderItemId?: string;
  /** LATE_RETURN 전용 — 렌탈 실물 상세 이동용 실물 id */
  rentalItemId?: string;
  itemLabel: string;
  reason: string;
  dueDate?: string;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
}

/** 백엔드 shared_memos 원본 행 */
interface SharedMemoApiRow {
  id: string;
  content: string;
  authorId: string;
  status: string;
  createdAt: string;
  updatedAt?: string | null;
  author?: { id: string; displayName: string } | null;
}

export interface SharedMemo {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt?: string;
  /** 백엔드 status(ACTIVE|COMPLETED) 파생 */
  completed: boolean;
  /** 생성 이후 실제로 수정된 적이 있는지 (@updatedAt은 항상 채워진다) */
  edited: boolean;
}

function toSharedMemo(row: SharedMemoApiRow): SharedMemo {
  return {
    id: row.id,
    content: row.content,
    authorId: row.authorId,
    authorName: row.author?.displayName ?? '-',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
    completed: row.status === 'COMPLETED',
    edited: !!row.updatedAt && row.updatedAt !== row.createdAt,
  };
}

export function fetchDashboardSummary(date: string): Promise<DashboardSummary> {
  return request<DashboardSummary>({ url: '/dashboard/summary', params: { date } });
}

export function fetchDashboardTasks(type?: DashboardTaskType): Promise<DashboardTask[]> {
  return request<DashboardTask[]>({ url: '/dashboard/tasks', params: type ? { type } : undefined });
}

export function acknowledgeDashboardTask(taskId: string): Promise<DashboardTask> {
  return request<DashboardTask>({
    url: `/dashboard/tasks/${encodeURIComponent(taskId)}/acknowledge`,
    method: 'POST',
  });
}

export function fetchSharedMemos(): Promise<SharedMemo[]> {
  return request<SharedMemoApiRow[]>({ url: '/shared-memos' }).then((rows) =>
    (rows ?? []).map(toSharedMemo),
  );
}

export function createSharedMemo(content: string): Promise<SharedMemo> {
  return request<SharedMemoApiRow>({ url: '/shared-memos', method: 'POST', data: { content } }).then(
    toSharedMemo,
  );
}

export function updateSharedMemo(
  id: string,
  payload: { content?: string; completed?: boolean },
): Promise<SharedMemo> {
  return request<SharedMemoApiRow>({
    url: `/shared-memos/${id}`,
    method: 'PATCH',
    // 백엔드는 completed 불리언이 아니라 status 코드를 받는다.
    data: {
      ...(payload.content !== undefined ? { content: payload.content } : {}),
      ...(payload.completed !== undefined
        ? { status: payload.completed ? 'COMPLETED' : 'ACTIVE' }
        : {}),
    },
  }).then(toSharedMemo);
}

export function deleteSharedMemo(id: string): Promise<{ id: string; deleted: boolean }> {
  return request<{ id: string; deleted: boolean }>({ url: `/shared-memos/${id}`, method: 'DELETE' });
}
