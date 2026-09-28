import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomersModule } from '../customers/customers.module';
import { NaverBookingAdapter } from './adapters/naver-booking.adapter';
import {
  NAVER_RESERVATION_ADAPTER,
  NaverReservationStubAdapter,
} from './adapters/naver-reservation.adapter';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { NaverSyncScheduler } from './naver-sync.scheduler';

@Module({
  imports: [CustomersModule],
  controllers: [AppointmentsController],
  providers: [
    AppointmentsService,
    NaverSyncScheduler,
    {
      /**
       * 실수집은 명시적으로 켰을 때만 한다 (NAVER_BOOKING_SYNC_ENABLED=true + 업체 ID).
       * 그 외(테스트·로컬 개발)에는 스텁이 붙어 네이버에 접속하지 않는다.
       */
      provide: NAVER_RESERVATION_ADAPTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const enabled =
          config.get('NAVER_BOOKING_SYNC_ENABLED') === 'true' && !!config.get('NAVER_BOOKING_BIZ_ID');
        if (!enabled) {
          new Logger('NaverReservationAdapter').log('네이버 예약 수집 비활성 — 스텁 어댑터 사용');
          return new NaverReservationStubAdapter();
        }
        return new NaverBookingAdapter(config);
      },
    },
  ],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
