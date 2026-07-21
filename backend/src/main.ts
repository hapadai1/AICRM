import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  app.enableCors();
  app.use((req: Request & { requestId?: string }, _res: Response, next: NextFunction) => {
    req.requestId = (req.headers['x-request-id'] as string) ?? `req_${randomUUID()}`;
    next();
  });
  // forbidNonWhitelisted: DTO에 없는 필드가 오면 조용히 버리지 않고 400으로 막는다.
  // (프론트 요청 필드명이 어긋나 데이터가 소리 없이 유실되는 것을 방지 — docs/dev/08 §2.3)
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
