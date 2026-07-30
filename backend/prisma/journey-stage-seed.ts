import { randomUUID } from 'crypto';

/**
 * 진행 단계 마스터 + 단계 연락 템플릿 (개발설계서 05 G-11 / G-06).
 *
 * seed.ts와 테스트 헬퍼가 함께 쓴다. 테스트는 notification_templates를
 * TRUNCATE CASCADE 하는데 journey_stages가 이를 FK로 참조하므로 함께 지워진다.
 * 스위트마다 이 함수로 복원한다.
 *
 * 연락 문구는 매장이 확정한 고정메시지 3종(완성복 입고 / 가봉 입고 / 수선 입고)이다
 * (docs/data/질문list_0728.Txt 5번, 수선 입고는 2026-07-30 현업 요청). 초안 문구는
 * 두지 않는다 — 나머지 단계는 템플릿 없이 두고, 필요하면 관리자 화면에서 문구를 만들어
 * 단계에 매핑한다.
 *
 * 원문에는 없던 `#{고객명}`만 첫 인사에 넣는다(2026-07-29 매장 요청) — 서버가 발송할 때
 * 고객 이름으로 채운다. 그 밖의 본문은 매장이 준 원문 그대로 나가야 하므로, 시드는
 * 이름·본문을 매 실행마다 이 원문으로 되돌린다.
 *
 * 알림톡 벤더 템플릿 승인 전이라 approvalStatus는 PENDING으로 둔다(승인 전에는 SMS로 나간다).
 */
export const STAGE_TEMPLATES: Array<{ code: string; name: string; body: string }> = [
  {
    code: 'JOURNEY_BASTING_RECEIVED',
    name: '가봉 입고 안내',
    body: `안녕하세요, #{고객명} 고객님🤗
고객님만을 위해 세심하게 제작중인 소중한 수트가
가봉이 되어 본점에 입고되었습니다.

네이버 통해서 금일 제외 편하신 시간에 ‘가봉-조율의순간’ 으로 예약주시고 방문해 주시면 됩니다.

◆카톡 및 문자는 답변을 드릴수 없으니 꼭!’꼭! 카톡 채널’을 통해 문의 부탁드립니다🥹◆
◆평일은 건물주차가 불가하니 꼭! 참고 부탁 드립니다.

[방문 예약]
https://naver.me/Grgxhtqs

💡 안내 드립니다
❖업무폰의 경우 실시간 확인을 할수 없어서 카톡 및 문자 답변이 불가합니다...
카카오 채널을 추가해 주시면 전직원 실시간 상담은 물론,
완벽한 실루엣을 위한 가봉 및 출고, 수선 등 모든 소통은 카카오채널을 통해 신속하게 도와드리고 있습니다!!

❖슈트에이전시 쇼룸 : 02-6409-4799

❖슈트에이전시 카카오 채널: http://pf.kakao.com/_VUxaAX

📢[주말 예약 관련 당부의 말씀]
❖주말은 많은 고객님이 집중되는 시간대입니다.
원활한 서비스 운영과 다른 고객님들의 대기 시간을 최소화하기 위해,
주말 예약은 신중한 결정 부탁드립니다.
약속된 주말 당일 예약 취소 및 변경 시,
이후 주말 예약 이용에 제한이 있을 수 있음을 양해 부탁드립니다.

🙏한 분 한 분께 정성을 다하기 위한 약속이오니
너그러운 마음으로 배려해 주시면 감사하겠습니다.

고객님의 기다림이 설렘이 될 수 있도록 정성을 다해 제작하겠습니다.
감사합니다.

-슈트에이전시 드림-`,
  },
  {
    code: 'JOURNEY_PRODUCT_RECEIVED',
    name: '완성복 입고 안내',
    body: `안녕하세요, #{고객명} 고객님🤗
고객님만을 위해 세심하게 제작된 소중한 수트가
드디어 완성 되어 본점에 입고되었습니다.

네이버 통해서 금일 제외 편하신 시간에 ‘완성-pick up순간’ 으로 예약주시고 방문해 주시면 됩니다.

◆카톡 및 문자는 답변을 드릴수 없으니 꼭!’꼭! 카톡 채널’을 통해 문의 부탁드립니다🥹◆
◆평일은 건물주차가 불가하니 꼭! 참고 부탁 드립니다.

[방문 예약]
https://naver.me/Grgxhtqs

💡 안내 드립니다
❖업무폰의 경우 실시간 확인을 할수 없어서 카톡 및 문자 답변이 불가합니다...
카카오 채널을 추가해 주시면 전직원 실시간 상담은 물론,
완벽한 실루엣을 위한 가봉 및 출고, 수선 등 모든 소통은 카카오채널을 통해 신속하게 도와드리고 있습니다!!

❖슈트에이전시 쇼룸 : 02-6409-4799

❖슈트에이전시 카카오 채널: http://pf.kakao.com/_VUxaAX

📢[주말 예약 관련 당부의 말씀]
❖주말은 많은 고객님이 집중되는 시간대입니다.
원활한 서비스 운영과 다른 고객님들의 대기 시간을 최소화하기 위해,
주말 예약은 신중한 결정 부탁드립니다.
약속된 주말 당일 예약 취소 및 변경 시,
이후 주말 예약 이용에 제한이 있을 수 있음을 양해 부탁드립니다.

🙏한 분 한 분께 정성을 다하기 위한 약속이오니
너그러운 마음으로 배려해 주시면 감사하겠습니다.

고객님의 기다림이 설렘이 될 수 있도록 정성을 다해 제작하겠습니다.
감사합니다.

-슈트에이전시 드림-`,
  },
  {
    code: 'JOURNEY_REPAIR_CHECKED_IN',
    name: '수선 입고 안내',
    body: `안녕하세요, #{고객명} 고객님🤗
맡겨주신 수선이 완료되어 본점에 입고되었습니다.

네이버 통해서 금일 제외 편하신 시간에 예약주시고 방문해 주시면 됩니다.

◆카톡 및 문자는 답변을 드릴수 없으니 꼭!’꼭! 카톡 채널’을 통해 문의 부탁드립니다🥹◆
◆평일은 건물주차가 불가하니 꼭! 참고 부탁 드립니다.

[방문 예약]
https://naver.me/Grgxhtqs

❖슈트에이전시 쇼룸 : 02-6409-4799

❖슈트에이전시 카카오 채널: http://pf.kakao.com/_VUxaAX

감사합니다.

-슈트에이전시 드림-`,
  },
];

/**
 * 고정메시지 2종만 남기기로 하면서 걷어낸 초안 문구.
 * 관리자 화면 '연락 문구' 목록에 초안이 남지 않도록 시드가 지운다(단계 매핑·규칙 정리 후 삭제).
 * 발송 이력은 보존한다 — 본문·수신번호가 이력 자체에 남아 있어 템플릿 링크만 끊으면 된다.
 */
export const RETIRED_TEMPLATE_CODES: string[] = [
  'JOURNEY_RELEASED',
  'JOURNEY_RENTAL_CHECKED_OUT',
  'JOURNEY_RENTAL_RETURNED',
  'JOURNEY_RENTAL_REPAIR_RECEIVED',
  'REPAIR_RECEIVED_NOTICE',
  'REPAIR_READY_NOTICE',
];

/**
 * 단계 정의 (v2 재정의, 설계서 02 §2.2·§4.1). templateCode가 있는 단계에서만 고객 연락을 제안한다.
 * - completionMode: AUTO(자동완료·수동버튼 없음) | GATED(품목 전수완료 후 [전체완료] 활성)
 * - targetScope: ORDER_ITEMS(주문 품목) | REPAIR_ITEMS(수선요청) | NONE(AUTO)
 */
export const JOURNEY_STAGES: Array<{
  trackType: string;
  code: string;
  name: string;
  completionMode: 'AUTO' | 'GATED';
  targetScope: 'ORDER_ITEMS' | 'REPAIR_ITEMS' | 'NONE';
  templateCode?: string;
}> = [
  // CUSTOM — 비즈니스 맞춤 (설계 PDF 1페이지)
  { trackType: 'CUSTOM', code: 'CONSULT_RESERVED', name: '상담 예약', completionMode: 'AUTO', targetScope: 'NONE' },
  { trackType: 'CUSTOM', code: 'CONTRACT_CONFIRMED', name: '계약 확정', completionMode: 'AUTO', targetScope: 'NONE' },
  { trackType: 'CUSTOM', code: 'STYLE_CONSULTING', name: '스타일 컨설팅', completionMode: 'GATED', targetScope: 'ORDER_ITEMS' },
  { trackType: 'CUSTOM', code: 'ORDER_REQUESTED', name: '발주 요청', completionMode: 'GATED', targetScope: 'ORDER_ITEMS' },
  {
    trackType: 'CUSTOM',
    code: 'BASTING_RECEIVED',
    name: '가봉 입고',
    completionMode: 'GATED',
    targetScope: 'ORDER_ITEMS',
    templateCode: 'JOURNEY_BASTING_RECEIVED',
  },
  { trackType: 'CUSTOM', code: 'FITTING_DONE', name: '가봉 피팅', completionMode: 'GATED', targetScope: 'ORDER_ITEMS' },
  {
    trackType: 'CUSTOM',
    code: 'PRODUCT_RECEIVED',
    name: '완성복 입고',
    completionMode: 'GATED',
    targetScope: 'ORDER_ITEMS',
    templateCode: 'JOURNEY_PRODUCT_RECEIVED',
  },
  { trackType: 'CUSTOM', code: 'RELEASED', name: '완성복 출고/완료', completionMode: 'GATED', targetScope: 'ORDER_ITEMS' },
  // RENTAL — 웨딩패키지 렌탈 = "렌탈 수선" 흐름 (설계 PDF 1페이지 렌탈)
  { trackType: 'RENTAL', code: 'CONSULT_RESERVED', name: '렌탈 상담 예약', completionMode: 'AUTO', targetScope: 'NONE' },
  { trackType: 'RENTAL', code: 'CONTRACT_CONFIRMED', name: '계약 확정', completionMode: 'AUTO', targetScope: 'NONE' },
  { trackType: 'RENTAL', code: 'STYLE_CONSULTING', name: '스타일 컨설팅', completionMode: 'GATED', targetScope: 'ORDER_ITEMS' },
  { trackType: 'RENTAL', code: 'RENTAL_REPAIR_REQUESTED', name: '렌탈 수선 요청', completionMode: 'GATED', targetScope: 'ORDER_ITEMS' },
  { trackType: 'RENTAL', code: 'RENTAL_REPAIR_RECEIVED', name: '렌탈 수선 입고', completionMode: 'GATED', targetScope: 'ORDER_ITEMS' },
  { trackType: 'RENTAL', code: 'RENTAL_REPAIR_CHECKED_OUT', name: '렌탈 수선 출고', completionMode: 'GATED', targetScope: 'ORDER_ITEMS' },
  { trackType: 'RENTAL', code: 'RENTAL_RETURNED', name: '렌탈 수선 반납/완료', completionMode: 'GATED', targetScope: 'ORDER_ITEMS' },
  // REPAIR — 수선 (설계 PDF 2페이지, v2 신규 트랙)
  { trackType: 'REPAIR', code: 'REPAIR_RECEIVED', name: '수선 접수', completionMode: 'AUTO', targetScope: 'NONE' },
  { trackType: 'REPAIR', code: 'REPAIR_REQUESTED', name: '수선 요청', completionMode: 'GATED', targetScope: 'REPAIR_ITEMS' },
  {
    trackType: 'REPAIR',
    code: 'REPAIR_CHECKED_IN',
    name: '수선 입고',
    completionMode: 'GATED',
    targetScope: 'REPAIR_ITEMS',
    // 수선 입고 = 고객 연락 시점. 수선 메뉴의 '고객연락'(CUSTOMER_NOTIFIED)과 같은 문구를 공유한다.
    templateCode: 'JOURNEY_REPAIR_CHECKED_IN',
  },
  { trackType: 'REPAIR', code: 'REPAIR_RELEASED', name: '수선 출고/완료', completionMode: 'GATED', targetScope: 'REPAIR_ITEMS' },
];

/**
 * v1 → v2 재정의로 은퇴하는 단계 코드 (물리삭제 금지 → active:false).
 * 데모는 seed:demo로 재생성되므로 소급 이관 불필요.
 */
export const RETIRED_JOURNEY_STAGE_CODES: Array<{ trackType: string; code: string }> = [
  { trackType: 'CUSTOM', code: 'CONSULT_DONE' },
  { trackType: 'RENTAL', code: 'CONSULT_DONE' },
  { trackType: 'RENTAL', code: 'RENTAL_CONSULTING' },
  { trackType: 'RENTAL', code: 'RENTAL_REQUESTED' },
  { trackType: 'RENTAL', code: 'RENTAL_CHECKED_OUT' },
];

/** PrismaClient 또는 PrismaService 어느 쪽으로도 호출할 수 있게 최소 형태만 요구한다. */
interface JourneySeedClient {
  notificationTemplate: {
    upsert(args: unknown): Promise<{ id: string }>;
    findMany(args: unknown): Promise<Array<{ id: string }>>;
    deleteMany(args: unknown): Promise<unknown>;
  };
  journeyStage: {
    upsert(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  notificationRule: {
    deleteMany(args: unknown): Promise<unknown>;
  };
  notificationHistory: {
    updateMany(args: unknown): Promise<unknown>;
  };
}

export async function seedJourneyStages(prisma: JourneySeedClient): Promise<void> {
  await removeRetiredTemplates(prisma);

  const templateIdsByCode = new Map<string, string>();
  for (const t of STAGE_TEMPLATES) {
    const row = await prisma.notificationTemplate.upsert({
      where: { code: t.code },
      // 매장 확정 고정메시지라 원문을 유지한다(운영 중 수정분도 시드 재실행 시 원문으로 되돌아간다).
      update: { name: t.name, body: t.body },
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

  // 은퇴 단계를 먼저 비활성화하고 sequenceNo를 음수로 밀어낸다.
  // @@unique([trackType, sequenceNo]) 제약상, 재정의로 자리가 바뀐 신규 단계와
  // 구 단계의 sequenceNo가 충돌하지 않도록 미리 자리를 비운다(물리삭제 금지).
  let retiredSeq = -1;
  for (const r of RETIRED_JOURNEY_STAGE_CODES) {
    await prisma.journeyStage.updateMany({
      where: { trackType: r.trackType, code: r.code },
      data: { active: false, sequenceNo: retiredSeq, templateId: null },
    });
    retiredSeq -= 1;
  }

  // sequenceNo는 트랙별 정의 순서를 그대로 쓴다.
  const seqByTrack = new Map<string, number>();
  for (const s of JOURNEY_STAGES) {
    const seq = (seqByTrack.get(s.trackType) ?? 0) + 1;
    seqByTrack.set(s.trackType, seq);
    const templateId = s.templateCode ? (templateIdsByCode.get(s.templateCode) ?? null) : null;
    await prisma.journeyStage.upsert({
      where: { trackType_code: { trackType: s.trackType, code: s.code } },
      update: {
        name: s.name,
        sequenceNo: seq,
        templateId,
        active: true,
        completionMode: s.completionMode,
        targetScope: s.targetScope,
      },
      create: {
        id: randomUUID(),
        trackType: s.trackType,
        code: s.code,
        name: s.name,
        sequenceNo: seq,
        templateId,
        active: true,
        completionMode: s.completionMode,
        targetScope: s.targetScope,
      },
    });
  }

}

/**
 * 걷어낸 초안 문구를 지운다. 참조를 먼저 끊어야 FK에 걸리지 않는다:
 * 단계 매핑 해제 → 트리거 규칙 삭제 → 발송 이력 링크 해제 → 템플릿 삭제.
 */
async function removeRetiredTemplates(prisma: JourneySeedClient): Promise<void> {
  const retired = await prisma.notificationTemplate.findMany({
    where: { code: { in: RETIRED_TEMPLATE_CODES } },
    select: { id: true },
  });
  if (retired.length === 0) return;
  const ids = retired.map((t) => t.id);

  await prisma.journeyStage.updateMany({ where: { templateId: { in: ids } }, data: { templateId: null } });
  await prisma.notificationRule.deleteMany({ where: { templateId: { in: ids } } });
  await prisma.notificationHistory.updateMany({
    where: { templateId: { in: ids } },
    data: { templateId: null },
  });
  await prisma.notificationTemplate.deleteMany({ where: { id: { in: ids } } });
}
