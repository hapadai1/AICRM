import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { GlobalExceptionFilter } from './common/global-exception.filter';
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
import { PaymentsModule } from './modules/payments/payments.module';
import { ProductionModule } from './modules/production/production.module';
import { RentalsModule } from './modules/rentals/rentals.module';
import { RepairsModule } from './modules/repairs/repairs.module';
import { UsersModule } from './modules/users/users.module';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
    PaymentsModule,
    NotificationsModule,
    DashboardModule,
    AdminMasterModule,
    FilesModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
