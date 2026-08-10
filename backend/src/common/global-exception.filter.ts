import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

    // Prisma 오류 매핑 — 잘못된 형식의 ID(예: UUID가 아닌 경로 파라미터)나 없는 레코드가
    // 500으로 새지 않도록 4xx로 변환한다. (P2025=없음 → 404, 그 외 형식·제약 위반 → 400)
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') {
        res.status(HttpStatus.NOT_FOUND).json({
          error: { code: 'NOT_FOUND', message: '대상을 찾을 수 없습니다.' },
          meta,
        });
        return;
      }
      res.status(HttpStatus.BAD_REQUEST).json({
        error: { code: 'VALIDATION_ERROR', message: '입력값을 확인해 주세요.' },
        meta,
      });
      return;
    }
    // 잘못된 형식의 값이 쿼리 엔진에 닿기 전에 검증 단계에서 걸린 경우.
    if (exception instanceof Prisma.PrismaClientValidationError) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: { code: 'VALIDATION_ERROR', message: '입력값을 확인해 주세요.' },
        meta,
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
      meta,
    });
  }
}
