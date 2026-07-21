import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { BusinessException } from './business.exception';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest();
    const meta = { requestId: req.requestId, timestamp: new Date().toISOString() };

    if (exception instanceof BusinessException) {
      res.status(exception.getStatus()).json({
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.fieldErrors ? { fieldErrors: exception.fieldErrors } : {}),
          ...(exception.details ? { details: exception.details } : {}),
        },
        meta,
      });
      return;
    }

    if (exception instanceof BadRequestException) {
      // ValidationPipe 오류 → 필드 오류 목록으로 변환
      const body = exception.getResponse() as { message?: string | string[] };
      const messages = Array.isArray(body.message) ? body.message : [body.message ?? '잘못된 요청입니다.'];
      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: '입력값을 확인해 주세요.',
          fieldErrors: messages.map((m) => ({ field: String(m).split(' ')[0] ?? '', reason: String(m) })),
        },
        meta,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        status === HttpStatus.UNAUTHORIZED ? 'AUTH_REQUIRED'
        : status === HttpStatus.FORBIDDEN ? 'PERMISSION_DENIED'
        : status === HttpStatus.NOT_FOUND ? 'NOT_FOUND'
        : 'INTERNAL_ERROR';
      res.status(status).json({ error: { code, message: exception.message }, meta });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
      meta,
    });
  }
}
