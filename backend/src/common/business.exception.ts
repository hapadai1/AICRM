import { HttpException } from '@nestjs/common';
import { ERROR_CODES, ErrorCode } from './error-codes';

export interface FieldError {
  field: string;
  reason: string;
}

/** 업무 규칙 위반 예외. 전역 필터가 오류 envelope로 변환한다. */
export class BusinessException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: FieldError[],
    readonly details?: Record<string, unknown>,
  ) {
    super(message, ERROR_CODES[code]);
  }
}
