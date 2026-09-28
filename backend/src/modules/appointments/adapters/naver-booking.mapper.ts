import { NaverBizItem, NaverReservationRecord } from './naver-reservation.adapter';

/**
 * 네이버 예약 목록 API 원본 레코드 (설계서 16.1 — 네이버 → CRM 단방향 수집).
 *
 * 필드 구성은 파트너센터 예약 목록 화면이 호출하는 응답을 실제로 캡처해 확정했다
 * (정찰 도구: ops/naver-recon, 픽스처: test/backend/fixtures/naver-bookings.sample.json).
 * 네이버가 주는 필드는 이보다 많지만, CRM 수집에 쓰는 것만 선언한다.
 */
export interface NaverBookingRaw {
  /** 네이버 예약번호 (숫자) */
  bookingId: number;
  /** 예약자명 */
  name: string;
  /** 예약자 연락처 (하이픈 없는 숫자 문자열) */
  phone: string;
  /** 예약 메뉴 ID */
  bizItemId?: number | string;
  /** 예약 메뉴명 — CRM 예약 목적으로 매핑한다 */
  bizItemName: string;
  /** 예약 상태 코드 (RC02/RC03/RC04/RC08) */
  bookingStatusCode: string;
  /** 예약 인원 */
  bookingCount?: number;
  /** 고객이 남긴 요청사항 */
  requestMessage?: string | null;
  /** 취소 사유 (업체 취소 시 입력) */
  cancelledDesc?: string | null;
  /** 고객이 직접 취소한 건이면 1 이상 */
  userCancelledCount?: number;
  /** 일정 변경 전 예약번호 — 네이버는 일정 변경 시 새 예약을 발급한다 */
  previousBookingId?: number | null;
  regDateTime?: string | null;
  confirmedDateTime?: string | null;
  cancelledDateTime?: string | null;
  completedDateTime?: string | null;
  /**
   * 예약 시점 스냅샷. 실제 예약 일시(UTC)는 여기에만 있다
   * (상위 startDate/endDate 는 날짜까지만 제공).
   */
  snapshotJson?: {
    startDateTime?: string | null;
    endDateTime?: string | null;
  } | null;
}

/**
 * 네이버 예약 상태 → CRM 예약 상태 (설계서 5.2).
 * 캡처 데이터에서 확인한 코드는 RC03·RC04·RC08 세 가지이며,
 * RC02(확정 대기)는 "예약 후 업체 확인" 설정에서 나타나므로 함께 정의해 둔다.
 * 노쇼 코드는 실데이터로 확인하지 못해 넣지 않았다 — 처음 보는 코드는 건너뛰고 로그로 알린다.
 */
const STATUS_MAP: Record<string, NaverReservationRecord['status']> = {
  RC02: 'RESERVED', // 예약 신청 (업체 확정 대기)
  RC03: 'CONFIRMED', // 예약 확정
  RC04: 'CANCELLED', // 예약 취소
  RC08: 'VISITED', // 이용 완료 = 방문 완료
};

/**
 * 네이버 예약 메뉴명 → CRM 예약 목적 코드 (AppointmentPurpose.code).
 *
 * 네이버 메뉴명은 "가봉_조율의 시간"처럼 접두 키워드 + 감성 문구 형태라
 * 문구가 바뀌어도 견디도록 키워드 포함 여부로 판정한다. 위에서부터 먼저 맞는 규칙을 쓴다.
 */
const PURPOSE_RULES: Array<{ keyword: string; purposeCode: string }> = [
  { keyword: 'PICKUP', purposeCode: 'PICKUP' }, // 완성복 출고
  { keyword: '가봉', purposeCode: 'FITTING' }, // 가봉 피팅
  { keyword: '채촌', purposeCode: 'MEASUREMENT' }, // 채촌
  { keyword: '수선', purposeCode: 'REPAIR_RECEIPT' }, // 수선 접수
  { keyword: '렌탈', purposeCode: 'RENTAL_CONSULTATION' }, // 렌탈 상담
  { keyword: '대여', purposeCode: 'RENTAL_CONSULTATION' }, // 정장대여 — 메뉴명이 '렌탈' 없이 바뀌어도 잡는다
  { keyword: '예복', purposeCode: 'INITIAL_CONSULTATION' }, // 예복 상담 → 맞춤 상담
  { keyword: '상담', purposeCode: 'INITIAL_CONSULTATION' }, // 그 밖의 상담
  { keyword: '맞춤정장', purposeCode: 'INITIAL_CONSULTATION' }, // 비즈니스 맞춤정장
];

/** 규칙에 걸리지 않는 새 메뉴가 생겨도 예약을 잃지 않도록 쓰는 기본 목적. */
export const FALLBACK_PURPOSE_CODE = 'INITIAL_CONSULTATION';

/** 메뉴명으로 CRM 목적 코드를 고른다. 못 찾으면 null (호출부가 기본값 처리). */
export function resolvePurposeCode(bizItemName: string): string | null {
  const name = (bizItemName ?? '').toUpperCase();
  for (const rule of PURPOSE_RULES) {
    if (name.includes(rule.keyword.toUpperCase())) return rule.purposeCode;
  }
  return null;
}

/** 네이버가 준 여러 변경 시각 중 가장 최근 값 — 충돌 판정(naverUpdatedAt)에 쓴다. */
function latestChangedAt(raw: NaverBookingRaw): string | undefined {
  const times = [raw.regDateTime, raw.confirmedDateTime, raw.cancelledDateTime, raw.completedDateTime]
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .map((t) => ({ raw: t, ms: Date.parse(t) }))
    .filter((t) => Number.isFinite(t.ms))
    .sort((a, b) => b.ms - a.ms);
  return times[0]?.raw;
}

/** 요청사항·취소사유를 CRM 메모 한 줄로 합친다. */
function buildNotes(raw: NaverBookingRaw): string | undefined {
  const parts: string[] = [];
  const request = (raw.requestMessage ?? '').trim();
  if (request) parts.push(request);
  const cancelReason = (raw.cancelledDesc ?? '').trim();
  if (cancelReason) parts.push(`[취소사유] ${cancelReason}`);
  else if (raw.bookingStatusCode === 'RC04' && (raw.userCancelledCount ?? 0) > 0) {
    parts.push('[취소사유] 고객 직접 취소');
  }
  if (raw.previousBookingId) parts.push(`[일정변경] 이전 예약번호 ${raw.previousBookingId}`);
  return parts.length ? parts.join('\n') : undefined;
}

export interface MapResult {
  records: NaverReservationRecord[];
  /** 매핑 규칙에 없어 기본 목적으로 넣은 메뉴명 — 운영자가 규칙을 보완하도록 노출한다. */
  unmappedBizItems: string[];
  /** 필수값이 없어 건너뛴 예약 (예약번호와 사유) */
  skipped: Array<{ bookingId: unknown; reason: string }>;
}

/**
 * 네이버 예약 목록 응답을 CRM 수집 레코드로 변환한다.
 *
 * 순수 함수로 두어 저장된 캡처(픽스처)만으로 테스트할 수 있게 한다 — 파싱 검증 때문에
 * 네이버에 반복 접속하지 않기 위함이다.
 */
export function mapNaverBookings(rawList: NaverBookingRaw[]): MapResult {
  const records: NaverReservationRecord[] = [];
  const unmapped = new Set<string>();
  const skipped: MapResult['skipped'] = [];

  for (const raw of rawList ?? []) {
    const start = raw.snapshotJson?.startDateTime;
    if (!raw?.bookingId || !start) {
      skipped.push({ bookingId: raw?.bookingId, reason: '예약번호 또는 예약 일시 없음' });
      continue;
    }
    const status = STATUS_MAP[raw.bookingStatusCode];
    if (!status) {
      skipped.push({ bookingId: raw.bookingId, reason: `알 수 없는 상태 코드 ${raw.bookingStatusCode}` });
      continue;
    }
    const purposeCode = resolvePurposeCode(raw.bizItemName);
    if (!purposeCode) unmapped.add(raw.bizItemName);

    records.push({
      externalId: String(raw.bookingId),
      customerName: (raw.name ?? '').trim(),
      phone: (raw.phone ?? '').trim(),
      purposeCode: purposeCode ?? FALLBACK_PURPOSE_CODE,
      scheduledStart: new Date(start).toISOString(),
      scheduledEnd: raw.snapshotJson?.endDateTime
        ? new Date(raw.snapshotJson.endDateTime).toISOString()
        : undefined,
      status,
      naverUpdatedAt: latestChangedAt(raw),
      notes: buildNotes(raw),
      bizItemId: raw.bizItemId != null ? String(raw.bizItemId) : undefined,
      bizItemName: (raw.bizItemName ?? '').trim() || undefined,
      previousExternalId: raw.previousBookingId ? String(raw.previousBookingId) : undefined,
    });
  }

  return { records, unmappedBizItems: [...unmapped], skipped };
}

/**
 * 네이버 예약 상품(메뉴) 마스터 원본.
 *
 * 예약 목록 화면이 함께 호출하는 상품 목록 응답에서 캡처했다
 * (정찰 캡처: ops/naver-recon 의 out 폴더 안 `..._biz_items_...json` 응답).
 * 예약이 한 건도 없는 상품도 화면 선택지에 띄우기 위해 수집 때 같이 저장한다.
 */
export interface NaverBizItemRaw {
  /** 상품(메뉴) ID */
  bizItemId: number | string;
  /** 상품명 — 파트너센터에서 언제든 바뀐다 */
  name: string;
  /** 상품 유형 (현재 5종 모두 STANDARD) */
  bizItemType?: string;
  /** 파트너센터에 설정한 노출 순서 */
  order?: number;
  /** 네이버 예약에 노출 중인 상품인지 */
  isImp?: boolean;
}

/**
 * 상품 마스터 응답을 화면 선택지로 변환한다 (순수 함수).
 * 순서는 파트너센터 설정(order)을 그대로 따라가 화면이 네이버와 같은 순서로 보이게 한다.
 */
export function mapNaverBizItems(rawList: NaverBizItemRaw[]): NaverBizItem[] {
  const byId = new Map<string, NaverBizItem>();
  for (const raw of rawList ?? []) {
    if (raw?.bizItemId == null) continue;
    const name = (raw.name ?? '').trim();
    if (!name) continue; // 이름 없는 상품은 화면에 띄울 수 없다
    const order = Number(raw.order);
    byId.set(String(raw.bizItemId), {
      id: String(raw.bizItemId),
      name,
      order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
    });
  }
  return [...byId.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ko'));
}
