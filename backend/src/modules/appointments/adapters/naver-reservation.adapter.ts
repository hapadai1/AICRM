import { Injectable } from '@nestjs/common';

/**
 * 네이버 예약 원본 레코드 (설계서 16.1 — 네이버 → CRM 단방향 수집).
 * 실제 연동 구현 전까지 어댑터 인터페이스로 격리한다 (구현표준 1.1).
 */
export interface NaverReservationRecord {
  /** 네이버 예약 고유번호 → appointments.external_id */
  externalId: string;
  customerName: string;
  phone: string;
  /** appointment_purposes.code (INITIAL_CONSULTATION 등) */
  purposeCode: string;
  /** ISO-8601 */
  scheduledStart: string;
  scheduledEnd?: string;
  /** 네이버 측 상태를 CRM 상태로 매핑한 값 */
  status: 'RESERVED' | 'CONFIRMED' | 'VISITED' | 'NO_SHOW' | 'CANCELLED';
  /** 네이버 최종 변경 시각 (ISO-8601) */
  naverUpdatedAt?: string;
  notes?: string;
  /** 네이버 예약 메뉴 ID·이름 원본 — 메뉴별로 나눠 보기 위해 보존한다 */
  bizItemId?: string;
  bizItemName?: string;
  /**
   * 일정 변경 전 예약번호. 네이버는 일정을 바꾸면 기존 예약을 취소로 남기지 않고 목록에서 빼버린 뒤
   * 새 예약번호를 발급한다 — 이 값이 사라진 예약을 가리키는 유일한 단서다.
   */
  previousExternalId?: string;
}

/** 조회 기간 (미지정이면 어댑터 기본 창) */
export interface NaverFetchWindow {
  lookbackDays: number;
  lookaheadDays: number;
}

/**
 * 네이버에 새로 접속할지, 저장된 수집본을 쓸지.
 * 요청이 올 때마다 스크래핑하면 차단 위험이 커지므로 기본은 "최근 저장본이 있으면 그것"이다.
 */
export interface NaverFetchOptions {
  /** 저장본만 쓴다 — 네이버에 절대 접속하지 않는다 (충돌 해소·점검용) */
  cacheOnly?: boolean;
  /**
   * 저장본이 이 분(分)보다 오래됐을 때만 새로 수집한다. 0 이면 무조건 새로 수집(명시적 적재 명령).
   * 생략하면 NAVER_BOOKING_MIN_FETCH_INTERVAL_MIN(기본 30분).
   */
  maxAgeMinutes?: number;
}

/**
 * 네이버 예약 상품(메뉴) 하나 — 예약 화면의 "메뉴별 보기" 선택지가 된다.
 *
 * 적재된 예약에서 메뉴를 뽑으면 예약이 0건인 상품은 화면에서 사라진다(렌탈처럼 예약이 드문 상품).
 * 그래서 예약과 별개로 상품 마스터를 수집해 선택지의 기준으로 쓴다.
 */
export interface NaverBizItem {
  /** 상품(메뉴) ID — appointments.naver_biz_item_id 와 같은 값 */
  id: string;
  name: string;
  /** 파트너센터 노출 순서 — 화면을 네이버와 같은 순서로 보이게 한다 */
  order: number;
}

export interface NaverFetchResult {
  records: NaverReservationRecord[];
  /** 이 레코드들을 네이버에서 실제로 받아 온 시각 (저장본이면 저장 당시 시각) */
  fetchedAt?: string;
  /** 저장본을 썼으면 true (이번에 네이버에 접속하지 않음) */
  fromCache: boolean;
}

export interface NaverReservationAdapter {
  /** 신규·변경·취소 예약 목록을 가져온다. */
  fetchReservations(window?: NaverFetchWindow, options?: NaverFetchOptions): Promise<NaverFetchResult>;
  /**
   * 파트너센터에 등록된 예약 상품(메뉴) 목록.
   * 수집 때 함께 저장해 둔 것을 읽기만 한다 — 이 호출로 네이버에 접속하지 않는다.
   */
  fetchBizItems(): Promise<NaverBizItem[]>;
}

export const NAVER_RESERVATION_ADAPTER = Symbol('NAVER_RESERVATION_ADAPTER');

/** 스텁: 네이버 연동을 끈 환경(테스트·로컬 개발)에서 빈 목록을 반환한다. */
@Injectable()
export class NaverReservationStubAdapter implements NaverReservationAdapter {
  async fetchReservations(): Promise<NaverFetchResult> {
    return { records: [], fromCache: false };
  }

  async fetchBizItems(): Promise<NaverBizItem[]> {
    return [];
  }
}
