import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { renderTemplate } from './notifications.service';

/**
 * 고객 연락 제안 생성 (개발설계서 05 G-06).
 *
 * 연락 시점은 사람이 정한다 — 진행 단계를 옮기거나 수선 상태를 바꿀 때다.
 * 이 서비스는 그 시점에 "보낼 문구"만 준비하고, 실제 발송은 화면의 확인창을
 * 거쳐 별도 요청(POST /notifications/send)으로 이뤄진다. 자동 발송은 없다.
 *
 * 진행 단계와 수선이 이 서비스를 공유한다.
 */

export interface NotificationSuggestion {
  templateId: string;
  templateCode: string;
  templateName: string;
  channel: string;
  recipientPhone: string;
  customerId: string;
  orderId: string | null;
  variables: Record<string, string>;
  renderedBody: string;
  /** 같은 트리거는 한 번만 발송된다(기존 idempotency_keys 재사용) */
  triggerKey: string;
}

/**
 * 주문에서 채우는 표준 변수의 기본값 (개발설계서 05 G-06 방안 A).
 * 주문이 있으면 orderVariables가 실제 값으로 덮어쓴다.
 */
const DEFAULT_ORDER_VARIABLES: Record<string, string> = {
  품목: '주문하신 상품',
  반납예정일: '별도 안내',
};

export interface SuggestionContext {
  templateId: string;
  customerId: string;
  orderId?: string | null;
  /** 멱등키 — 예: `journey:{id}:{stage}` / `repair:{id}:{status}` */
  triggerKey: string;
  /** 호출자가 이미 아는 값. 나머지는 여기서 주문 기준으로 채운다. */
  extraVariables?: Record<string, string>;
}

@Injectable()
export class NotificationSuggestionService {
  constructor(private readonly prisma: PrismaService) {}

  async build(ctx: SuggestionContext): Promise<NotificationSuggestion | null> {
    const [template, customer] = await Promise.all([
      this.prisma.notificationTemplate.findUnique({
        where: { id: ctx.templateId },
        select: { id: true, code: true, name: true, channel: true, body: true },
      }),
      this.prisma.customer.findUnique({
        where: { id: ctx.customerId },
        select: { id: true, name: true, phone: true },
      }),
    ]);
    if (!template || !customer) return null;

    const variables: Record<string, string> = {
      // 주문에서 채우지 못한 표준 변수의 기본값.
      // 주문 없이 시작한 진행에서도 문구에 #{품목} 같은 자리표시자가 노출되지 않게 한다.
      // (개발설계서 05 G-06 — 실제 값이 필요하면 발송 확인창에서 담당자가 수정)
      ...DEFAULT_ORDER_VARIABLES,
      고객명: customer.name,
      ...(await this.orderVariables(ctx.orderId)),
      ...(ctx.extraVariables ?? {}),
    };

    return {
      templateId: template.id,
      templateCode: template.code,
      templateName: template.name,
      channel: template.channel,
      recipientPhone: customer.phone,
      customerId: customer.id,
      orderId: ctx.orderId ?? null,
      variables,
      renderedBody: renderTemplate(template.body, variables),
      triggerKey: ctx.triggerKey,
    };
  }

  /** 주문이 있으면 품목명·렌탈 반납예정일을 채운다. */
  private async orderVariables(orderId?: string | null): Promise<Record<string, string>> {
    if (!orderId) return {};
    const variables: Record<string, string> = {};

    const items = await this.prisma.orderItem.findMany({
      where: { orderId, status: { not: 'CANCELLED' } },
      orderBy: { sequenceNo: 'asc' },
      select: { displayName: true },
    });
    if (items.length > 0) variables['품목'] = items.map((i) => i.displayName).join(', ');

    // 반납예정일 = 이 주문 배정 중 가장 늦은 반납 기한
    const allocation = await this.prisma.rentalAllocation.findFirst({
      where: {
        orderItemComponent: { orderItem: { orderId } },
        status: { not: 'CANCELLED' },
      },
      orderBy: { returnDueDate: 'desc' },
      select: { returnDueDate: true },
    });
    if (allocation) variables['반납예정일'] = allocation.returnDueDate.toISOString().slice(0, 10);

    return variables;
  }

  /**
   * 트리거 코드에 연결된 활성 규칙의 템플릿을 찾는다 (수선 등 단계 밖 트리거용).
   * 규칙이 없으면 연락 제안을 하지 않는다 — 기존 동작과 완전히 동일해진다.
   */
  async templateIdForTrigger(triggerType: string): Promise<string | null> {
    const rule = await this.prisma.notificationRule.findFirst({
      where: { triggerType, active: true },
      select: { templateId: true },
    });
    return rule?.templateId ?? null;
  }
}
