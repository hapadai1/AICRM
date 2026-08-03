import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { HealthController } from './common/health.controller';
import { ResponseInterceptor } from './common/response.interceptor';
import { AdminMasterModule } from './modules/admin-master/admin-master.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { FilesModule } from './modules/files/files.module';
import { JourneysModule } from './modules/journeys/journeys.module';
import { MeasurementsModule } from './modules/measurements/measurements.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OptionsModule } from './modules/options/options.module';
import { OrdersModule } from './modules/orders/orders.module';
import { ProductionModule } from './modules/production/production.module';
import { RentalsModule } from './modules/rentals/rentals.module';
import { RepairsModule } from './modules/repairs/repairs.module';
import { StatsModule } from './modules/stats/stats.module';
import { UsersModule } from './modules/users/users.module';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 렌탈 정비 완료 자동 가용 전환(매일 00:05)에 쓴다.
    ScheduleModule.forRoot(),
    PrismaModule,
    AuditModule,
    AuthModule,
    UsersModule,
    CustomersModule,
    JourneysModule,
    AppointmentsModule,
    ContractsModule,
    OrdersModule,
    OptionsModule,
    MeasurementsModule,
    WorkOrdersModule,
    ProductionModule,
    RepairsModule,
    RentalsModule,
    NotificationsModule,
    DashboardModule,
    StatsModule,
    AdminMasterModule,
    FilesModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
