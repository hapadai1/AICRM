import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { JourneysController } from './journeys.controller';
import { JourneysService } from './journeys.service';

@Module({
  imports: [NotificationsModule],
  controllers: [JourneysController],
  providers: [JourneysService],
  exports: [JourneysService],
})
export class JourneysModule {}
