import { Module } from '@nestjs/common';
import { AdminMasterController } from './admin-master.controller';
import { AdminMasterService } from './admin-master.service';
import { CodeLabelsController } from './code-labels.controller';
import { CodeLabelsService } from './code-labels.service';

@Module({
  controllers: [AdminMasterController, CodeLabelsController],
  providers: [AdminMasterService, CodeLabelsService],
})
export class AdminMasterModule {}
