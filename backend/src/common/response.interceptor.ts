import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { Paginated } from './pagination';

/** 모든 성공 응답을 { data, (page), meta } envelope으로 감싼다. */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const meta = { requestId: req.requestId, timestamp: new Date().toISOString() };

    return next.handle().pipe(
      map((result) => {
        if (result instanceof Paginated) {
          return {
            ...(result.extra ?? {}),
            data: result.items,
            page: {
              number: result.number,
              size: result.size,
              totalElements: result.totalElements,
              totalPages: result.totalPages,
            },
            meta,
          };
        }
        return { data: result ?? null, meta };
      }),
    );
  }
}
