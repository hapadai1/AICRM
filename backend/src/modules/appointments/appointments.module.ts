import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import {
  NAVER_RESERVATION_ADAPTER,
  NaverReservationStubAdapter,
} from './adapters/naver-reservation.adapter';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';

@Module({
  imports: [CustomersModule],
  controllers: [AppointmentsController],
  providers: [
    AppointmentsService,
    { provide: NAVER_RESERVATION_ADAPTER, useClass: NaverReservationStubAdapter },
  ],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
