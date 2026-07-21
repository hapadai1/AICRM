import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  MESSAGE_VENDOR_ADAPTER,
  MessageVendorAdapter,
} from './adapters/message-vendor.adapter';
import {
  CreateTemplateDto,
  PreviewNotificationDto,
  SendNotificationDto,
  UpdateRuleDto,
  UpdateTemplateDto,
} from './notifications.dto';

/** `#{변수}` 또는 `{{변수}}` 자리를 변수 값으로 치환한다. 값이 없으면 원문을 유지한다. */
export function renderTemplate(body: string, variables: Record<string, string> = {}): string {
  return body.replace(/#\{([^}]+)\}|\{\{([^}]+)\}\}/g, (match, kakao?: string, curly?: string) => {
    const key = (kakao ?? curly ?? '').trim();
    return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match;
  });
}

const TRIGGER_KEY_PREFIX = 'notification-send:';
const SEND_ENDPOINT = 'POST /notifications/send';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(MESSAGE_VENDOR_ADAPTER) private readonly vendor: MessageVendorAdapter,
  ) {}

  // ---------------------------------------------------------------------------
  // 템플릿 CRUD
  // ---------------------------------------------------------------------------

  listTemplates() {
    return this.prisma.notificationTemplate.findMany({ orderBy: { code: 'asc' } });
  }

  // ---------------------------------------------------------------------------
  // 트리거별 문구 매핑 (수선 상태 등 진행 단계 밖의 연락 — 개발설계서 05 G-06)
  // ---------------------------------------------------------------------------

  listRules() {
    return this.prisma.notificationRule.findMany({
      orderBy: { triggerType: 'asc' },
      select: {
        id: true,
        triggerType: true,
        templateId: true,
        active: true,
        template: { select: { id: true, code: true, name: true, channel: true } },
      },
    });
  }

  /** 규칙의 문구·사용 여부만 바꾼다. autoSend는 쓰지 않는다(발송은 항상 확인창을 거친다). */
  async updateRule(id: string, dto: UpdateRuleDto, actor: AuthUser) {
    const before = await this.prisma.notificationRule.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('알림 규칙이 없습니다.');
    if (dto.templateId) {
      const template = await this.prisma.notificationTemplate.findUnique({
        where: { id: dto.templateId },
      });
      if (!template)
        throw new BusinessException('VALIDATION_ERROR', '알림 템플릿이 없습니다.', [
          { field: 'templateId', reason: 'NOT_FOUND' },
        ]);
    }
    const rule = await this.prisma.notificationRule.update({
      where: { id },
      data: {
        ...(dto.templateId ? { templateId: dto.templateId } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
      select: {
        id: true,
        triggerType: true,
        templateId: true,
        active: true,
        template: { select: { id: true, code: true, name: true, channel: true } },
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'NOTIFICATION_RULE',
      entityId: id,
      before: { templateId: before.templateId, active: before.active },
      after: { templateId: rule.templateId, active: rule.active },
    });
    return rule;
  }

  async createTemplate(dto: CreateTemplateDto, actor: AuthUser) {
    const exists = await this.prisma.notificationTemplate.findUnique({ where: { code: dto.code } });
    if (exists)
      throw new BusinessException('VALIDATION_ERROR', '이미 존재하는 템플릿 코드입니다.', [
        { field: 'code', reason: 'DUPLICATE' },
      ]);
    const template = await this.prisma.notificationTemplate.create({
      data: {
        id: randomUUID(),
        code: dto.code.trim(),
        name: dto.name?.trim() || dto.code.trim(),
        channel: dto.channel,
        body: dto.body,
        approvalStatus: dto.approvalStatus ?? 'PENDING',
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'NOTIFICATION_TEMPLATE',
      entityId: template.id,
      after: template,
    });
    return template;
  }

  async updateTemplate(id: string, dto: UpdateTemplateDto, actor: AuthUser) {
    const before = await this.prisma.notificationTemplate.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('템플릿이 없습니다.');
    const template = await this.prisma.notificationTemplate.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.channel ? { channel: dto.channel } : {}),
        ...(dto.body ? { body: dto.body } : {}),
        ...(dto.approvalStatus ? { approvalStatus: dto.approvalStatus } : {}),
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'NOTIFICATION_TEMPLATE',
      entityId: id,
      before,
      after: template,
    });
    return template;
  }

  // ---------------------------------------------------------------------------
  // 미리보기·발송·재시도·이력
  // ---------------------------------------------------------------------------

  async preview(dto: PreviewNotificationDto) {
    const template = await this.resolveTemplate(dto.templateId, dto.templateCode);
    return {
      templateId: template.id,
      templateCode: template.code,
      channel: template.channel,
      body: template.body,
      renderedBody: renderTemplate(template.body, dto.variables ?? {}),
    };
  }

  /**
   * 메시지 발송. triggerKey가 있으면 idempotency_keys로 중복 발송을 방지하고
   * 최초 발송 결과를 그대로 반환한다.
   */
  async send(dto: SendNotificationDto, actor: AuthUser) {
    const template = await this.resolveTemplate(dto.templateId, dto.templateCode);
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');

    if (dto.triggerKey) {
      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { key: TRIGGER_KEY_PREFIX + dto.triggerKey },
      });
      if (existing?.responseJson) return { ...(existing.responseJson as object), duplicated: true };
    }

    const recipientPhone = dto.recipientPhone ?? customer.phone;
    const renderedBody = renderTemplate(template.body, dto.variables ?? {});

    const record = async (channel: string, retryOfId: string | null) => {
      const result = await this.vendor.send({
        channel,
        recipientPhone,
        body: renderedBody,
        templateCode: template.code,
      });
      return this.prisma.notificationHistory.create({
        data: {
          id: randomUUID(),
          templateId: template.id,
          customerId: customer.id,
          orderId: dto.orderId ?? null,
          recipientPhone,
          channel,
          body: renderedBody,
          status: result.success ? 'SENT' : 'FAILED',
          sentAt: result.success ? new Date() : null,
          errorMessage: result.success ? null : (result.errorMessage ?? '발송 실패'),
          retryOfId,
        },
      });
    };

    const history = await record(template.channel, null);

    // 알림톡 실패 시 SMS 대체 발송(fallbackSms=false로 비활성화 가능).
    const fallback =
      history.status === 'FAILED' && template.channel === 'ALIMTALK' && dto.fallbackSms !== false
        ? await record('SMS', history.id)
        : null;

    const toResult = (h: typeof history) => ({
      id: h.id,
      templateId: template.id,
      templateCode: template.code,
      templateName: template.name,
      channel: h.channel,
      customerId: customer.id,
      orderId: h.orderId,
      recipientPhone,
      status: h.status,
      errorMessage: h.errorMessage,
      sentAt: h.sentAt,
      retryOfId: h.retryOfId,
      renderedBody,
    });

    // 최상위 필드는 최초(템플릿 채널) 발송 결과, results는 대체 발송까지 포함한 전체 결과.
    const response = {
      ...toResult(history),
      results: fallback ? [toResult(history), toResult(fallback)] : [toResult(history)],
    };

    if (dto.triggerKey) {
      // 동시 요청 경합 시 unique 충돌은 무시한다(최초 기록 유지).
      try {
        await this.prisma.idempotencyKey.create({
          data: {
            id: randomUUID(),
            key: TRIGGER_KEY_PREFIX + dto.triggerKey,
            userId: actor.id,
            endpoint: SEND_ENDPOINT,
            responseJson: response as unknown as Prisma.InputJsonValue,
          },
        });
      } catch {
        /* noop */
      }
    }

    // 변수·치환 본문은 이력 테이블에 컬럼이 없어 감사로그로 보존한다.
    await this.audit.log({
      userId: actor.id,
      action: 'SEND',
      entityType: 'NOTIFICATION',
      entityId: history.id,
      after: { ...response, variables: dto.variables ?? {}, triggerKey: dto.triggerKey ?? null },
    });
    return response;
  }

  /** 실패 건 재시도: 기존 이력은 보존하고 새 이력 레코드를 만든다. */
  async retry(historyId: string, actor: AuthUser) {
    const failed = await this.prisma.notificationHistory.findUnique({
      where: { id: historyId },
      include: { template: true },
    });
    if (!failed) throw new NotFoundException('발송 이력이 없습니다.');
    if (failed.status !== 'FAILED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '실패한 발송만 재시도할 수 있습니다.');

    // 발송 당시 본문을 그대로 재사용한다(없으면 템플릿 원문).
    const body = failed.body ?? failed.template?.body ?? '';
    const channel = failed.channel ?? failed.template?.channel ?? 'SMS';
    const result = await this.vendor.send({
      channel,
      recipientPhone: failed.recipientPhone,
      body,
      templateCode: failed.template?.code,
    });

    const history = await this.prisma.notificationHistory.create({
      data: {
        id: randomUUID(),
        templateId: failed.templateId,
        customerId: failed.customerId,
        orderId: failed.orderId,
        recipientPhone: failed.recipientPhone,
        channel,
        body,
        status: result.success ? 'SENT' : 'FAILED',
        sentAt: result.success ? new Date() : null,
        errorMessage: result.success ? null : (result.errorMessage ?? '발송 실패'),
        retryOfId: failed.id,
      },
      include: { template: { select: { code: true, name: true, channel: true } } },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'SEND',
      entityType: 'NOTIFICATION',
      entityId: history.id,
      after: { retryOf: historyId, status: history.status },
      reason: '발송 재시도',
    });
    return history;
  }

  /** 고객 연락 이력(시간 역순). */
  async listByCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');
    return this.prisma.notificationHistory.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: { template: { select: { code: true, name: true, channel: true } } },
    });
  }

  private async resolveTemplate(templateId?: string, templateCode?: string) {
    if (!templateId && !templateCode)
      throw new BusinessException('VALIDATION_ERROR', 'templateId 또는 templateCode가 필요합니다.', [
        { field: 'templateId', reason: 'REQUIRED' },
      ]);
    const template = templateId
      ? await this.prisma.notificationTemplate.findUnique({ where: { id: templateId } })
      : await this.prisma.notificationTemplate.findUnique({ where: { code: templateCode as string } });
    if (!template) throw new NotFoundException('템플릿이 없습니다.');
    return template;
  }
}
