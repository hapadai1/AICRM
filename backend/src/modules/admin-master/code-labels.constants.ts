/**
 * 코드 상수로 정의된 기준정보(품목·구성품·수선구분)의 도메인·코드·기본 표시명.
 * - 코드 집합은 여기서 고정된다. 관리자 화면에서 추가·삭제 불가.
 * - 표시명은 기본값이며, master_code_labels 테이블에 오버라이드가 있으면 그 값을 쓴다.
 * - 프런트엔드 기본 표시명(frontend api/code-labels)과 반드시 일치시켜야 한다.
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
  'repair-type': [
    { code: 'CUSTOM_DURING', label: '제작 중 수선' },
    { code: 'AFTER_SALE', label: '사후 수선' },
    { code: 'RENTAL_PRE', label: '렌탈 출고 전' },
    { code: 'RENTAL_POST', label: '렌탈 반납 후' },
    { code: 'GENERAL', label: '일반 수선' },
  ],
} as const;

export type CodeLabelDomain = keyof typeof CODE_LABEL_DOMAINS;

export function isCodeLabelDomain(value: string): value is CodeLabelDomain {
  return Object.prototype.hasOwnProperty.call(CODE_LABEL_DOMAINS, value);
}
