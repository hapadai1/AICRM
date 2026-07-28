/**
 * 코드 상수로 정의된 기준정보(품목·구성품·수선구분)의 도메인·코드·기본 표시명.
 * - **코드 집합·표시 순서·기본 표시명의 단일 출처(single source)**다. 다른 모듈은 여기서 파생시킨다
 *   (수선 유형 검증 `repairs.dto`, REPAIR 트랙 라벨 `journeys.service`).
 * - 관리자 화면에서 코드 추가·삭제는 불가하며 표시명만 편집한다.
 *   편집값은 master_code_labels 오버라이드로 저장되고 `CodeLabelsService.listAll()`이 병합한다.
 * - 프런트엔드는 `GET /code-labels` 응답으로 코드 집합·순서·표시명을 받아 쓴다
 *   (frontend api/code-labels의 기본값은 하이드레이션 전 폴백일 뿐이다).
 */
export const CODE_LABEL_DOMAINS = {
  'product-category': [
    { code: 'SUIT', label: '정장' },
    { code: 'SHIRT', label: '셔츠' },
    { code: 'SHOES', label: '구두' },
  ],
  'component-type': [
    { code: 'JACKET', label: '상의(자켓)' },
    { code: 'TROUSERS', label: '하의(바지)' },
    { code: 'VEST', label: '베스트' },
    { code: 'SHIRT', label: '셔츠' },
    { code: 'SHOES', label: '구두' },
  ],
  // 렌탈 수선은 수선 도메인이 아니라 렌탈 진행(RENTAL 트랙 수선요청·입고·출고)에서 관리한다.
  'repair-type': [
    { code: 'CUSTOM_DURING', label: '제작 중 수선' },
    { code: 'AFTER_SALE', label: '사후 수선' },
    { code: 'GENERAL', label: '일반 수선' },
  ],
} as const;

export type CodeLabelDomain = keyof typeof CODE_LABEL_DOMAINS;

export function isCodeLabelDomain(value: string): value is CodeLabelDomain {
  return Object.prototype.hasOwnProperty.call(CODE_LABEL_DOMAINS, value);
}

/** 도메인의 코드 집합(정의 순서). 검증·선택지 구성에 쓴다. */
export function codesOf(domain: CodeLabelDomain): string[] {
  return CODE_LABEL_DOMAINS[domain].map((d) => d.code);
}

/**
 * 도메인의 기본 표시명 맵. 관리자 오버라이드는 반영되지 않으므로
 * 화면 응답에는 `CodeLabelsService.listAll()`을, 서버 내부 표기에는 이 맵을 쓴다.
 */
export function defaultLabelsOf(domain: CodeLabelDomain): Record<string, string> {
  return Object.fromEntries(CODE_LABEL_DOMAINS[domain].map((d) => [d.code, d.label]));
}
