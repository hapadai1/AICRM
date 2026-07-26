/**
 * 진행 단계 [전체 완료] 버튼 게이팅 (v2 설계서 02 §4).
 *
 * PDF "완료 상태 체크: 전체 품목 …완료 여부 / 완료 버튼 조건: 상태 완료시 활성화"를 코드화한다.
 * 완료 판정의 원천은 production 상태가 아니라 "담당자가 누른 품목별 완료"(JourneyStageItemCompletion)다
 * — v1 비연동 원칙과 D2 게이팅을 동시에 만족시키는 지점(설계서 02 §1.3).
 */

import type { StageCompletionMode } from './journeys.constants';

export interface GatingResult {
  stageCode: string;
  mode: StageCompletionMode;
  /** 대상 품목 수 */
  targetCount: number;
  /** revokedAt IS NULL 완료 수 */
  completedCount: number;
  /** [전체 완료] 활성 여부 */
  canComplete: boolean;
}

/**
 * 단계 [전체 완료] 활성 판정.
 * - AUTO 단계: 버튼 없음(canComplete=false, 별도 훅으로 완료)
 * - GATED 단계: 대상 품목이 1개 이상이고 전 품목이 완료되어야 활성
 */
export function computeGating(
  stageCode: string,
  mode: StageCompletionMode,
  targetIds: string[],
  completions: { targetId: string; revokedAt: Date | null }[],
): GatingResult {
  const targetSet = new Set(targetIds);
  const completed = new Set(
    completions
      .filter((c) => c.revokedAt === null && targetSet.has(c.targetId))
      .map((c) => c.targetId),
  );
  const targetCount = targetSet.size;
  const completedCount = completed.size;
  return {
    stageCode,
    mode,
    targetCount,
    completedCount,
    // 전 품목 완료 = "상태 완료" (대상 0건이면 비활성 — 완료할 게 없음)
    canComplete: mode === 'GATED' && targetCount > 0 && completedCount === targetCount,
  };
}
