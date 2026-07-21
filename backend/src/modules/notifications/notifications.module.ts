import { Module } from '@nestjs/common';
import { MESSAGE_VENDOR_ADAPTER, StubMessageVendorAdapter } from './adapters/message-vendor.adapter';
import { NotificationSuggestionService } from './notification-suggestion.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationSuggestionService,
    { provide: MESSAGE_VENDOR_ADAPTER, useClass: StubMessageVendorAdapter },
  ],
  // 진행 단계·수선이 연락 제안을 만들 때 함께 쓴다.
  exports: [NotificationsService, NotificationSuggestionService],
})
export class NotificationsModule {}
