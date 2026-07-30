import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditNamesService } from './audit-names.service';
import { AuditService } from './audit.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditNamesService],
  exports: [AuditService],
})
export class AuditModule {}
