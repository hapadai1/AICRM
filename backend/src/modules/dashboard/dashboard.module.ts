import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SharedMemosService } from './shared-memos.service';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService, SharedMemosService],
})
export class DashboardModule {}
