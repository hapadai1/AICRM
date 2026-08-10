/**
 * 채촌 입력 폼 모델 (2026-08-05 MeasurementEditPage에서 분리).
 * 폼 상태 모양·저장 payload 변환 같은 순수 헬퍼만 둔다 — 화면 상태 없음.
 */
import dayjs from 'dayjs';
import type { MeasurementType, MeasurementValues } from '../../api/measurements';
import { MEASUREMENT_FIELDS } from '../../api/measurements';

export interface FormState {
  measurementDate: string;
  measurementType: MeasurementType;
  /** 화면 입력은 문자열로 다루고 저장 시 숫자/문자로 나눈다 */
  values: Record<string, string>;
  fitPreference: string;
  bodyNotes: string;
  notes: string;
}

/** 채촌 구분 = 채촌을 하게 된 업무 단계 */
export const TYPE_OPTIONS: { label: string; value: MeasurementType }[] = [
  { label: '스타일 컨설팅', value: 'INITIAL' },
  { label: '가봉', value: 'FITTING' },
  { label: '수선', value: 'REMEASURE' },
  { label: '기타', value: 'OTHER' },
];

export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  MEASUREMENT_FIELDS.map((f) => [f.key, f.label]),
);

/**
 * 화면 표시 단위. 입력·저장은 항상 CM이고 INCH는 보기 전용이다 (설계서 v2 05 §3.2).
 * 매장 확인(2026-07-29): 인치는 소수가 아니라 1/8 단위 분수로 읽으므로 되돌려 입력받지 않는다.
 */
export type Unit = 'CM' | 'INCH';

/**
 * 저장 payload: 빈 값은 null로 보내 해당 항목을 삭제한다 (설계서 09 §3.3).
 * 폼 값은 언제나 CM이므로 단위 환산은 없다.
 */
export function toPayloadValues(values: Record<string, string>): MeasurementValues {
  const out: MeasurementValues = {};
  MEASUREMENT_FIELDS.forEach((f) => {
    const raw = (values[f.key] ?? '').trim();
    if (raw === '' || raw === '.') {
      out[f.key] = null;
      return;
    }
    if (f.kind !== 'number') {
      out[f.key] = raw;
      return;
    }
    const n = Number(raw);
    out[f.key] = Number.isFinite(n) ? n : null;
  });
  return out;
}

export function emptyForm(): FormState {
  return {
    measurementDate: dayjs().format('YYYY-MM-DD'),
    measurementType: 'INITIAL',
    values: {},
    fitPreference: '',
    bodyNotes: '',
    notes: '',
  };
}
