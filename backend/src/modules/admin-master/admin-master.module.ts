import { Module } from '@nestjs/common';
import { AdminMasterController } from './admin-master.controller';
import { AdminMasterService } from './admin-master.service';

@Module({
  controllers: [AdminMasterController],
  providers: [AdminMasterService],
})
export class AdminMasterModule {}
