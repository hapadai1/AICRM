/**
 * 한 단계에 허용하는 선택지 코드. 앞에서부터 개수만큼 쓴다(2개면 A·B, 29개면 A~Z·AA~AC).
 *
 * 정장·셔츠는 부위별로 2~5개를 고르지만, 구두는 단계를 나누지 않고 완성 스타일
 * 29종을 한 단계에 펼친다. 그래서 알파벳 한 자리(26개)로는 모자라 AA~ 두 자리까지 쓴다.
 * (option_choices.choice_code는 VARCHAR(2))
 */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const CHOICE_CODES: string[] = [...LETTERS, ...LETTERS.slice(0, 14).map((c) => `A${c}`)];

export const MIN_CHOICES = 2;
export const MAX_CHOICES = CHOICE_CODES.length;

/**
 * 코드 순서 비교자. DB의 `ORDER BY choice_code`는 사전순이라 두 자리 코드가 섞이면
 * AA가 B보다 앞에 온다. 화면에 내보내기 전 이 비교자로 다시 세운다.
 */
export function compareChoiceCodes(a: string, b: string): number {
  const rank = (code: string): number => {
    const i = CHOICE_CODES.indexOf(code);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return rank(a) - rank(b);
}
