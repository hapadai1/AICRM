/**
 * 상태·코드 라벨 조회 공용 헬퍼.
 *
 * 백엔드가 프론트 맵에 없는 코드를 보내도 화면이 죽지 않도록,
 * 라벨 맵은 반드시 이 헬퍼를 통해 조회한다. 미등록 코드는 코드값을 그대로 노출해
 * "빈 화면" 대신 "낯선 코드"로 드러나게 한다. (구현표준 §2 — 상태는 텍스트+색 병기)
 */

export interface StatusMeta {
  label: string;
  color: string;
}

const UNKNOWN_COLOR = 'default';

/**
 * `META[code].label` 직접 인덱싱 금지 — 이 함수를 쓴다.
 * 키를 제네릭으로 받아 `Record<'A'|'B', StatusMeta>` 형태의 좁은 맵도 그대로 넘길 수 있다.
 */
export function metaOf<T extends StatusMeta, K extends string>(
  map: Record<K, T>,
  code: string | undefined | null,
): T {
  // 맵이 label·color 외 필드(예: hex)를 가질 수 있어 반환 타입은 T로 맞춘다.
  // 미등록 코드의 폴백에는 그 부가 필드가 없으므로(undefined) 표시용으로만 쓴다.
  if (!code) return { label: '-', color: UNKNOWN_COLOR } as T;
  return (map as Record<string, T>)[code] ?? ({ label: code, color: UNKNOWN_COLOR } as T);
}

/** 색 없이 라벨만 쓰는 맵(Record<string, string>)용 */
export function labelOf<K extends string>(
  map: Record<K, string>,
  code: string | undefined | null,
): string {
  if (!code) return '-';
  return (map as Record<string, string>)[code] ?? code;
}
