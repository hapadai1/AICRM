import { BusinessException } from '../../common/business.exception';

/**
 * 전화번호 정규화: 숫자만 남긴다 (데이터모델설계서 5.1 phone_normalized).
 * 중복 판별은 항상 이 값으로 수행한다.
 */
export function normalizePhone(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 20) {
    throw new BusinessException('VALIDATION_ERROR', '전화번호 형식이 올바르지 않습니다.', [
      { field: 'phone', reason: 'INVALID_PHONE' },
    ]);
  }
  return digits;
}
