/**
 * 제작 관리 줄 배치 — 준비 카드와 단계 품목 표가 **같은 칸 폭**을 쓴다.
 *
 * 카드마다 폭이 조금씩 다르면 위아래로 훑을 때 상태·버튼·날짜가 계단처럼 어긋나 보인다
 * (2026-08-04 현업 지적). 이름 → 상태 → 버튼 → 날짜 → 서류 순서와 폭을 여기서 한 번만 정하고
 * 두 화면이 그대로 쓴다. 버튼은 글자 수가 달라도 같은 폭으로 세운다.
 */

/*
  좌·우로 갈린 흐름 카드는 화면 절반 폭이라 칸을 넉넉히 잡으면 가로로 삐져나온다.
  아래 값은 가장 긴 글자(완성복발주 · 가봉 작업지시서)가 들어가는 최소치로 잡은 것이다.
*/

/** 품목·항목 이름 칸 */
export const NAME_WIDTH = 150;
/** 완료·미완료·지남 한 낱말 */
export const STATUS_WIDTH = 60;
/** 처리 버튼 칸 (발주·완성복발주·스타일 컨설팅 …) */
export const ACTION_WIDTH = 112;
/** 날짜 칸 (YYYY-MM-DD) */
export const DATE_WIDTH = 96;
/** 서류 버튼 칸 (작업지시서·가봉 작업지시서) */
export const DOC_WIDTH = 148;

/** 표 안에서 이름이 시작하는 x — 펼침 버튼(24)+칸 사이(4)만큼 밀린다. */
export const NAME_INDENT = 28;

/** 단계 줄(세로 Steps)의 단계명 칸 — 표의 이름 칸과 같은 x에서 시작한다. */
export const STAGE_LABEL_WIDTH = 110;
/** 표 본문 들여쓰기 — 표 셀 여백(8)을 빼서 단계명과 품목명을 같은 x에 세운다. */
export const STAGE_BODY_INDENT = STAGE_LABEL_WIDTH - 8;
/**
 * 단계 줄의 요약 칸. 단계 줄 버튼([전체 발주])이 표의 처리 버튼과 같은 x에서 시작하도록
 * 이름 칸 + 상태 칸을 합친 폭으로 둔다.
 *
 * 셀 여백을 따로 더하지 않는다 — 단계명 칸이 이미 표 여백(8)을 뺀 자리에서 시작하므로
 * (STAGE_BODY_INDENT) 여기에 또 더하면 [전체 …]만 8px 뒤로 밀린다(2026-08-05 현업 지적).
 */
export const STAGE_SUMMARY_WIDTH = NAME_WIDTH + STATUS_WIDTH;

/**
 * 흐름 카드(맞춤·렌탈) 버튼 통일 폭 — [전체 …] 전체 처리 버튼과 표 안 품목 처리 버튼을
 * 가장 긴 라벨(`전체 완성복발주 (3)`)이 들어가는 한 크기로 맞춘다(2026-08-20 현업 요청).
 * 준비 카드는 이 폭을 쓰지 않는다(ACTION_WIDTH 유지).
 */
export const FLOW_BUTTON_WIDTH = 138;
export const flowButtonStyle = { width: FLOW_BUTTON_WIDTH } as const;
/**
 * 흐름 카드 처리 칸 — 버튼 폭에 오른쪽 여백을 더해, 버튼이 완료일과 붙지 않게 띄운다
 * (2026-08-20 현업 지적: 버튼·완료일·작업지시서 간격이 좁음). 버튼은 칸 왼쪽에 붙으므로
 * 칸을 넓혀도 단계 줄의 [전체 …] 버튼과 같은 x에서 시작하는 정렬은 그대로다.
 */
export const FLOW_ACTION_COL_WIDTH = FLOW_BUTTON_WIDTH + 24;
/** 완료일 칸 왼쪽 여백 — 처리 버튼과 붙지 않게. 단계 줄 [고객 연락] 정렬도 이 값을 함께 쓴다. */
export const FLOW_DATE_PAD = 12;
/**
 * 단계 줄에서 [전체 …] 버튼이 차지하는 칸 — 처리 칸 폭 + 완료일 여백만큼 잡아,
 * 뒤따르는 [고객 연락] 버튼이 아래 표의 완료일과 같은 열에서 시작하게 한다(2026-08-20 현업 요청).
 */
export const FLOW_TITLE_ACTION_SLOT = FLOW_ACTION_COL_WIDTH + FLOW_DATE_PAD;

/**
 * 진행 요약 한 줄 — 전 품목이 끝났을 때만 `완료 n/m`, 한 건이라도 남으면 `진행중 n/m`.
 * 완료·진행중을 접두로 앞세워 상태를 먼저 읽게 한다(2026-08-20 현업 요청).
 */
export function progressLabel(done: number, total: number): string {
  const prefix = total > 0 && done >= total ? '완료' : '진행중';
  return `${prefix} ${done}/${total}`;
}

/** 버튼 하나의 고정 폭 style — 글자 수가 달라도 세로로 줄이 맞는다. */
export const actionButtonStyle = { width: ACTION_WIDTH } as const;
export const docButtonStyle = { width: DOC_WIDTH } as const;
