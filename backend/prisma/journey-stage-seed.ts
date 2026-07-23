import { randomUUID } from 'crypto';

/**
 * 진행 단계 마스터 + 단계 연락 템플릿 (개발설계서 05 G-11 / G-06).
 *
 * seed.ts와 테스트 헬퍼가 함께 쓴다. 테스트는 notification_templates를
 * TRUNCATE CASCADE 하는데 journey_stages가 이를 FK로 참조하므로 함께 지워진다.
 * 스위트마다 이 함수로 복원한다.
 *
 * 알림 문구는 초안이다. 알림톡 벤더 템플릿 승인 시 실문구로 교체하며,
 * 승인 전 오발송을 막기 위해 approvalStatus는 PENDING으로 둔다.
 */
export const STAGE_TEMPLATES: Array<{ code: string; name: string; body: string }> = [
  {
    code: 'JOURNEY_BASTING_RECEIVED',
    name: '가봉 입고 안내',
    body: '#{고객명}님, 주문하신 #{품목} 가봉이 준비되었습니다. 방문 일정 예약 부탁드립니다.',
  },
  {
    code: 'JOURNEY_PRODUCT_RECEIVED',
    name: '완성복 입고 안내',
    body: '#{고객명}님, 주문하신 #{품목}이 입고되었습니다. 픽업 일정 예약 부탁드립니다.',
  },
  {
    code: 'JOURNEY_RELEASED',
    name: '수령 완료 인사',
    body: '#{고객명}님, 오늘 수령해 주셔서 감사합니다. 착용 중 불편한 점이 있으면 언제든 연락 주세요.',
  },
  {
    code: 'JOURNEY_RENTAL_CHECKED_OUT',
    name: '렌탈 출고 안내',
    body: '#{고객명}님, 렌탈 상품이 출고되었습니다. 반납 예정일은 #{반납예정일}입니다.',
  },
  {
    code: 'JOURNEY_RENTAL_RETURNED',
    name: '렌탈 반납 완료 인사',
    body: '#{고객명}님, 렌탈 상품 반납이 완료되었습니다. 이용해 주셔서 감사합니다.',
  },
];

/**
 * 수선 상태 연락 (설계 PDF 1페이지 수선 — "고객연락").
 * 수선은 진행 단계 트랙을 따로 두지 않고 기존 상태 흐름에 확인창만 얹으므로,
 * 매핑은 notification_rules의 triggerType(`REPAIR:{상태}`)으로 관리한다.
 */
export const REPAIR_TEMPLATES: Array<{
  code: string;
  name: string;
  body: string;
  triggerType: string;
}> = [
  {
    code: 'REPAIR_RECEIVED_NOTICE',
    name: '수선 접수 안내',
    body: '#{고객명}님, 수선 접수가 완료되었습니다. 완료되면 다시 안내드리겠습니다.',
    triggerType: 'REPAIR:RECEIVED',
  },
  {
    code: 'REPAIR_READY_NOTICE',
    name: '수선 완료 안내',
    body: '#{고객명}님, 맡기신 수선이 완료되었습니다. 방문 수령 부탁드립니다.',
    triggerType: 'REPAIR:CUSTOMER_NOTIFIED',
  },
];

/** 단계 정의. templateCode가 있는 단계에서만 고객 연락을 제안한다. */
export const JOURNEY_STAGES: Array<{
  trackType: string;
  code: string;
  name: string;
  templateCode?: string;
}> = [
  // CUSTOM — 비즈니스 맞춤 (설계 PDF 1페이지 상담·계약·제작/출고)
  { trackType: 'CUSTOM', code: 'CONSULT_RESERVED', name: '상담 예약' },
  { trackType: 'CUSTOM', code: 'CONSULT_DONE', name: '초도 상담' },
  { trackType: 'CUSTOM', code: 'CONTRACT_CONFIRMED', name: '계약 확정' },
  { trackType: 'CUSTOM', code: 'STYLE_CONSULTING', name: '스타일 컨설팅' },
  { trackType: 'CUSTOM', code: 'ORDER_REQUESTED', name: '발주 요청' },
  {
    trackType: 'CUSTOM',
    code: 'BASTING_RECEIVED',
    name: '가봉 입고',
    templateCode: 'JOURNEY_BASTING_RECEIVED',
  },
  { trackType: 'CUSTOM', code: 'FITTING_DONE', name: '가봉 완료' },
  {
    trackType: 'CUSTOM',
    code: 'PRODUCT_RECEIVED',
    name: '완성복 입고',
    templateCode: 'JOURNEY_PRODUCT_RECEIVED',
  },
  {
    trackType: 'CUSTOM',
    code: 'RELEASED',
    name: '완성복 출고/완료',
    templateCode: 'JOURNEY_RELEASED',
  },
  // RENTAL — 웨딩패키지 렌탈 (설계 PDF 1페이지 렌탈)
  { trackType: 'RENTAL', code: 'CONSULT_RESERVED', name: '렌탈 상담 예약' },
  { trackType: 'RENTAL', code: 'CONSULT_DONE', name: '렌탈 상담·채촌' },
  { trackType: 'RENTAL', code: 'CONTRACT_CONFIRMED', name: '계약 확정' },
  { trackType: 'RENTAL', code: 'RENTAL_CONSULTING', name: '렌탈 컨설팅' },
  { trackType: 'RENTAL', code: 'RENTAL_REQUESTED', name: '렌탈 요청' },
  {
    trackType: 'RENTAL',
    code: 'RENTAL_CHECKED_OUT',
    name: '렌탈 출고',
    templateCode: 'JOURNEY_RENTAL_CHECKED_OUT',
  },
  {
    trackType: 'RENTAL',
    code: 'RENTAL_RETURNED',
    name: '렌탈 반납',
    templateCode: 'JOURNEY_RENTAL_RETURNED',
  },
];

/** PrismaClient 또는 PrismaService 어느 쪽으로도 호출할 수 있게 최소 형태만 요구한다. */
interface JourneySeedClient {
  notificationTemplate: {
    upsert(args: unknown): Promise<{ id: string }>;
  };
  journeyStage: {
    upsert(args: unknown): Promise<unknown>;
  };
  notificationRule: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
}

export async function seedJourneyStages(prisma: JourneySeedClient): Promise<void> {
  const templateIdsByCode = new Map<string, string>();
  for (const t of STAGE_TEMPLATES) {
    const row = await prisma.notificationTemplate.upsert({
      where: { code: t.code },
      // 운영 중 수정한 문구를 시드 재실행이 덮어쓰지 않도록 update는 비운다.
      update: {},
      create: {
        id: randomUUID(),
        code: t.code,
        name: t.name,
        channel: 'ALIMTALK',
        body: t.body,
        approvalStatus: 'PENDING',
      },
    });
    templateIdsByCode.set(t.code, row.id);
  }

  // sequenceNo는 트랙별 정의 순서를 그대로 쓴다.
  const seqByTrack = new Map<string, number>();
  for (const s of JOURNEY_STAGES) {
    const seq = (seqByTrack.get(s.trackType) ?? 0) + 1;
    seqByTrack.set(s.trackType, seq);
    const templateId = s.templateCode ? (templateIdsByCode.get(s.templateCode) ?? null) : null;
    await prisma.journeyStage.upsert({
      where: { trackType_code: { trackType: s.trackType, code: s.code } },
      update: { name: s.name, sequenceNo: seq, templateId, active: true },
      create: {
        id: randomUUID(),
        trackType: s.trackType,
        code: s.code,
        name: s.name,
        sequenceNo: seq,
        templateId,
        active: true,
      },
    });
  }

  // 수선 상태 연락: 템플릿 + triggerType 규칙.
  // autoSend는 항상 false다 — 발송은 화면의 확인창을 거친다.
  for (const t of REPAIR_TEMPLATES) {
    const template = await prisma.notificationTemplate.upsert({
      where: { code: t.code },
      update: {},
      create: {
        id: randomUUID(),
        code: t.code,
        name: t.name,
        channel: 'ALIMTALK',
        body: t.body,
        approvalStatus: 'PENDING',
      },
    });
    const existing = await prisma.notificationRule.findFirst({
      where: { triggerType: t.triggerType },
    });
    if (existing) {
      await prisma.notificationRule.update({
        where: { id: existing.id },
        data: { templateId: template.id, active: true },
      });
    } else {
      await prisma.notificationRule.create({
        data: {
          id: randomUUID(),
          templateId: template.id,
          triggerType: t.triggerType,
          autoSend: false,
          active: true,
        },
      });
    }
  }
}
