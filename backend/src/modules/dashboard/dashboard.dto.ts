import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export const DASHBOARD_TASK_TYPES = [
  'LATE_RETURN',
  'INBOUND_DELAY',
  'PAYMENT_DELAY',
  'UNORDERED',
  'REPRINT_NEEDED',
] as const;
export type DashboardTaskType = (typeof DASHBOARD_TASK_TYPES)[number];

export class TaskQueryDto {
  @IsOptional()
  @IsIn(DASHBOARD_TASK_TYPES as unknown as string[])
  type?: DashboardTaskType;
}

export class AcknowledgeTaskDto {
  @IsOptional()
  @IsIn(['ACKNOWLEDGED', 'DEFERRED', 'RESOLVED'])
  status?: string;

  @IsOptional()
  @IsString()
  memo?: string;
}

export class CreateSharedMemoDto {
  @IsString()
  @IsNotEmpty()
  content: string;

  @IsOptional()
  @IsUUID()
  targetUserId?: string;
}

export class UpdateSharedMemoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  content?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'COMPLETED'])
  status?: string;
}

/** 대시보드 확인사항 응답 행 (화면·API 정의서 14.8) */
export interface DashboardTaskRow {
  taskId: string;
  taskType: DashboardTaskType;
  entityType: string;
  entityId: string;
  customerId: string | null;
  customerName: string | null;
  orderId?: string | null;
  orderNo?: string | null;
  orderItemId?: string | null;
  itemLabel?: string | null;
  contractId?: string | null;
  reason: string;
  dueDate?: string | null;
  acknowledged: boolean;
  /** 최근 확인 처리자 표시명·시각 (미확인이면 null) */
  acknowledgedBy?: string | null;
  acknowledgedAt?: string | null;
}
