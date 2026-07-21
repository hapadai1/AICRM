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
  itemLabel: string;
  reason: string;
  dueDate?: string;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
}

export interface SharedMemo {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt?: string;
  completed: boolean;
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
  return request<SharedMemo[]>({ url: '/shared-memos' });
}

export function createSharedMemo(content: string): Promise<SharedMemo> {
  return request<SharedMemo>({ url: '/shared-memos', method: 'POST', data: { content } });
}

export function updateSharedMemo(
  id: string,
  payload: { content?: string; completed?: boolean },
): Promise<SharedMemo> {
  return request<SharedMemo>({ url: `/shared-memos/${id}`, method: 'PATCH', data: payload });
}

export function deleteSharedMemo(id: string): Promise<{ id: string; deleted: boolean }> {
  return request<{ id: string; deleted: boolean }>({ url: `/shared-memos/${id}`, method: 'DELETE' });
}
