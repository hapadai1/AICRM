import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationSuggestionService } from '../notifications/notification-suggestion.service';
import { CreateAllocationContactDto, CreateAllocationNoteDto } from './rentals.dto';
import { RENTAL_NOTICE_TEMPLATE_CODE, toDateOnlyString, todayDateOnly } from './rentals.constants';

const NOTE_SELECT = {
  id: true,
  kind: true,
  body: true,
  createdAt: true,
  notificationHistoryId: true,
  actor: { select: { id: true, displayName: true } },
} as const;

const CHANNEL_LABELS: Record<string, string> = { ALIMTALK: '알림톡', SMS: 'SMS' };

/** 목록 한 줄에 얹을 요약 — 연락 횟수와 가장 최근 비고 한 줄 */
export interface AllocationNoteSummary {
  contactCount: number;
  lastNote: { kind: string; body: string; createdAt: Date; actorName: string } | null;
}

/**
 * 대여 건 비고 (RENT-004).
 *
 * 연락·회신·변경·메모가 한 줄에 시간순으로 쌓인다. 발송 이력은 고객·주문까지만 엮여 있어
 * "이 대여 건에 몇 번 연락했나"를 셀 수 없었고, 전화로 받은 답을 적을 곳도 없었다.
 */
@Injectable()
export class RentalNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly suggestions: NotificationSuggestionService,
  ) {}

  /**
   * 연락 문구 제안 — 화면이 확인창에 채워 넣을 값. 발송은 확인창에서 따로 요청한다.
   *
   * 문구는 상황별로 가르지 않고 하나만 쓴다(현업 확정 2026-08-03). 픽업 안내든 반납 독촉이든
   * 담당자가 그 자리에서 고쳐 보내는 편이 템플릿 네 벌을 관리하는 것보다 낫다.
   * 멱등키에 날짜를 넣어 같은 날 두 번은 안 나가고 다음 날은 다시 보낼 수 있게 한다.
   */
  async contactSuggestion(allocationId: string) {
    const allocation = await this.prisma.rentalAllocation.findUnique({
      where: { id: allocationId },
      select: {
        id: true,
        pickupDate: true,
        returnDueDate: true,
        rentalInventoryItem: { select: { rentalSku: { select: { color: true, size: true } } } },
        orderItemComponent: {
          select: {
            orderItem: {
              select: {
                displayName: true,
                order: { select: { id: true, contract: { select: { customerId: true } } } },
              },
            },
          },
        },
      },
    });
    if (!allocation) throw new NotFoundException('렌탈 배정이 없습니다.');

    const template = await this.prisma.notificationTemplate.findUnique({
      where: { code: RENTAL_NOTICE_TEMPLATE_CODE },
      select: { id: true },
    });
    if (!template)
      throw new BusinessException(
        'VALIDATION_ERROR',
        '렌탈 연락 문구가 없습니다. 관리자 → 연락 문구에서 등록해 주세요.',
        [{ field: 'template', reason: 'NOT_FOUND' }],
      );

    const orderItem = allocation.orderItemComponent.orderItem;
    const sku = allocation.rentalInventoryItem.rentalSku;
    return this.suggestions.build({
      templateId: template.id,
      customerId: orderItem.order.contract.customerId,
      orderId: orderItem.order.id,
      triggerKey: `rental:${allocationId}:CONTACT:${todayDateOnly()}`,
      extraVariables: {
        품목: orderItem.displayName,
        규격: `${sku.color} / ${sku.size}`,
        픽업일: toDateOnlyString(allocation.pickupDate),
        반납예정일: toDateOnlyString(allocation.returnDueDate),
      },
    });
  }

  /** 한 건의 비고 전체 — 최근 것부터 */
  async list(allocationId: string) {
    await this.assertAllocation(allocationId);
    return this.prisma.rentalAllocationNote.findMany({
      where: { rentalAllocationId: allocationId },
      orderBy: { createdAt: 'desc' },
      select: NOTE_SELECT,
    });
  }

  /**
   * 회신·변경·메모 추가.
   * CHANGE는 배정의 반납 예정일을 고치지 않는다 — 원래 기간으로 걸어 둔 기간 잠금을
   * 흔들면 그 기간에 잡힌 다음 예약이 깨진다. 사정은 기록으로만 남기고 지연 표시는 그대로 둔다
   * (현업 확정 2026-08-03).
   */
  async create(allocationId: string, dto: CreateAllocationNoteDto, actor: AuthUser) {
    const allocation = await this.assertAllocation(allocationId);
    const body = this.composeBody(dto, allocation.returnDueDate);
    const note = await this.prisma.rentalAllocationNote.create({
      data: {
        id: randomUUID(),
        rentalAllocationId: allocationId,
        kind: dto.kind,
        body,
        actorId: actor.id,
      },
      select: NOTE_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'RENTAL_ALLOCATION_NOTE',
      entityId: note.id,
      after: { allocationId, kind: dto.kind, body },
    });
    return note;
  }

  /**
   * 발송 결과 봉합 — 화면이 실제로 보낸 뒤에만 부른다. 이 기록만 연락 횟수에 잡힌다.
   *
   * 보낸 문구는 여기 담지 않는다. 렌탈 연락은 문구가 하나뿐이라 건마다 같은 글이 쌓여
   * 비고를 덮어 버린다 — 실제 발송 본문은 알림 이력(notification_history)에 있고
   * notificationHistoryId로 이어 둔다 (현업 확정 2026-08-04).
   */
  async createContact(allocationId: string, dto: CreateAllocationContactDto, actor: AuthUser) {
    await this.assertAllocation(allocationId);
    const note = await this.prisma.rentalAllocationNote.create({
      data: {
        id: randomUUID(),
        rentalAllocationId: allocationId,
        kind: 'CONTACT',
        body: dto.channel ? `연락 발송 · ${CHANNEL_LABELS[dto.channel] ?? dto.channel}` : '연락 발송',
        actorId: actor.id,
        notificationHistoryId: dto.notificationHistoryId ?? null,
      },
      select: NOTE_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'RENTAL_ALLOCATION_NOTE',
      entityId: note.id,
      after: { allocationId, kind: 'CONTACT', notificationHistoryId: dto.notificationHistoryId },
    });
    return note;
  }

  /**
   * 목록용 요약 — 배정 id 여럿을 한 번에 센다.
   * 행마다 조회하면 목록 한 장에 수십 번 왕복한다.
   */
  async summarize(allocationIds: string[]): Promise<Map<string, AllocationNoteSummary>> {
    const out = new Map<string, AllocationNoteSummary>();
    if (allocationIds.length === 0) return out;

    const [counts, notes] = await Promise.all([
      this.prisma.rentalAllocationNote.groupBy({
        by: ['rentalAllocationId'],
        where: { rentalAllocationId: { in: allocationIds }, kind: 'CONTACT' },
        _count: { _all: true },
      }),
      // 최근 것부터 받아 배정별 첫 줄만 남긴다 — 건별 최신 1건을 SQL로 뽑으려면
      // 윈도우 함수가 필요한데, 목록 한 장 분량이라 여기서 추리는 편이 단순하다.
      //
      // 연락(CONTACT)은 비고에 올리지 않는다. 몇 번 보냈는지는 연락 칸이 이미 말하고,
      // 비고는 "그래서 뭐라던가"를 보는 자리다 — 발송 기록이 회신·변경을 덮으면 안 된다.
      this.prisma.rentalAllocationNote.findMany({
        where: { rentalAllocationId: { in: allocationIds }, kind: { not: 'CONTACT' } },
        orderBy: { createdAt: 'desc' },
        select: {
          rentalAllocationId: true,
          kind: true,
          body: true,
          createdAt: true,
          actor: { select: { displayName: true } },
        },
      }),
    ]);

    for (const id of allocationIds) out.set(id, { contactCount: 0, lastNote: null });
    for (const c of counts) {
      const row = out.get(c.rentalAllocationId);
      if (row) row.contactCount = c._count._all;
    }
    for (const n of notes) {
      const row = out.get(n.rentalAllocationId);
      if (row && !row.lastNote)
        row.lastNote = {
          kind: n.kind,
          body: n.body,
          createdAt: n.createdAt,
          actorName: n.actor.displayName,
        };
    }
    return out;
  }

  /** CHANGE는 "무엇이 어떻게 바뀌는가"를 서버가 문장으로 만든다 — 화면마다 표기가 갈리지 않게. */
  private composeBody(dto: CreateAllocationNoteDto, returnDueDate: Date): string {
    if (dto.kind !== 'CHANGE') {
      const body = dto.body?.trim();
      if (!body)
        throw new BusinessException('VALIDATION_ERROR', '내용을 입력해 주세요.', [
          { field: 'body', reason: 'REQUIRED' },
        ]);
      return body;
    }
    if (!dto.newReturnDueDate)
      throw new BusinessException('VALIDATION_ERROR', '바뀐 반납 예정일을 입력해 주세요.', [
        { field: 'newReturnDueDate', reason: 'REQUIRED' },
      ]);
    const reason = dto.body?.trim();
    const head = `반납 예정일 ${toDateOnlyString(returnDueDate)} → ${dto.newReturnDueDate}`;
    return reason ? `${head} · ${reason}` : head;
  }

  private async assertAllocation(id: string) {
    const allocation = await this.prisma.rentalAllocation.findUnique({
      where: { id },
      select: { id: true, returnDueDate: true },
    });
    if (!allocation) throw new NotFoundException('렌탈 배정이 없습니다.');
    return allocation;
  }
}
