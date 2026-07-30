import { IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../common/pagination';

/** 발송 이력 목록 조회 필터 (MSG-001 이력 탭 — 고객 지정 없이 전체 조회). */
export class ListNotificationsQueryDto extends PageQueryDto {
  /** 특정 고객으로 좁힐 때만 지정한다(미지정이면 전체 이력). */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsIn(['REQUESTED', 'SENT', 'FAILED'])
  status?: string;

  @IsOptional()
  @IsIn(['ALIMTALK', 'SMS'])
  channel?: string;

  /** 고객명·전화번호 부분검색. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  q?: string;
}

export class CreateTemplateDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  /** 표시명. 생략 시 코드를 사용한다. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsIn(['ALIMTALK', 'SMS'])
  channel: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  approvalStatus?: string;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsIn(['ALIMTALK', 'SMS'])
  channel?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  body?: string;

  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  approvalStatus?: string;
}

/** 트리거별 문구 매핑 변경 (개발설계서 05 G-06) */
export class UpdateRuleDto {
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class PreviewNotificationDto {
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsOptional()
  @IsString()
  templateCode?: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}

export class SendNotificationDto {
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsOptional()
  @IsString()
  templateCode?: string;

  @IsUUID()
  customerId: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  /** 생략 시 고객 대표 전화번호를 사용한다. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  recipientPhone?: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  /**
   * 담당자가 직접 쓰거나 고친 최종 발송 문구. 지정하면 템플릿 렌더 결과 대신 이 문구가 나간다.
   * 승인된 템플릿 본문을 벗어나므로 알림톡이 아닌 SMS로 발송된다.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  body?: string;

  /** 알림톡 실패 시 SMS 대체 발송 여부(기본 true). */
  @IsOptional()
  @IsBoolean()
  fallbackSms?: boolean;

  /** 중복 발송 방지 키 (같은 키 재요청 시 최초 발송 결과를 반환). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  triggerKey?: string;
}
