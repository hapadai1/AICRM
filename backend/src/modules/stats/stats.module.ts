import { Module } from '@nestjs/common';
import { AdminMasterModule } from '../admin-master/admin-master.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  // 품목·수선구분 표시명(관리자 오버라이드 포함)을 계열 라벨로 쓴다.
  imports: [AdminMasterModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
