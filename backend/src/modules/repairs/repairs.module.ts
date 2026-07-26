import { Module } from '@nestjs/common';
import { JourneysModule } from '../journeys/journeys.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';

@Module({
  // JourneysModule: 수선 접수 시 REPAIR 진행 자동생성(createRepairJourney)에 필요.
  imports: [NotificationsModule, JourneysModule],
  controllers: [RepairsController],
  providers: [RepairsService],
  exports: [RepairsService],
})
export class RepairsModule {}
