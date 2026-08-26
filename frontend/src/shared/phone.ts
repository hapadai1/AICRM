/**
 * 전화번호 표시 포맷 — 전 화면 공용.
 *
 * 관리자 화면의 전화번호는 어디서나 하이픈을 넣어 같은 형식으로 보여준다(010-5555-5566).
 * 고객모드의 마스킹 표기는 app/mode-store 의 maskPhone 이 따로 담당한다(정보 보호).
 */

/** 전화번호에 하이픈을 넣어 표기 (010-5555-5566). 자릿수가 안 맞으면 원문 그대로, 값이 없으면 '-'. */
export function formatPhone(phone?: string | null): string {
  if (!phone) return '-';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return phone;
}
