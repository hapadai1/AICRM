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
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
