import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CloneMeasurementSessionDto,
  CompareMeasurementsQueryDto,
  CreateMeasurementBodyDto,
  CreateMeasurementSessionDto,
  LinkOrderItemMeasurementDto,
  MeasurementListQueryDto,
  UpdateMeasurementSessionDto,
} from './measurements.dto';
import { MeasurementsService } from './measurements.service';

@Controller()
export class MeasurementsController {
  constructor(private readonly measurementsService: MeasurementsService) {}

  /** MEAS-001 전역 채촌 검색 (:id 라우트보다 먼저 선언) */
  @Get('measurements')
  @RequirePermission('MEASUREMENT_VIEW')
  search(@Query() query: MeasurementListQueryDto) {
    return this.measurementsService.search(query);
  }

  /** MEAS-002 채촌 생성 (고객을 본문으로 지정) */
  @Post('measurements')
  @RequirePermission('MEASUREMENT_EDIT')
  createForCustomer(@Body() dto: CreateMeasurementBodyDto, @CurrentUser() actor: AuthUser) {
    const { customerId, ...rest } = dto;
    return this.measurementsService.create(customerId, rest, actor);
  }

  /** MEAS-001 고객별 채촌 이력 */
  @Get('customers/:customerId/measurements')
  @RequirePermission('MEASUREMENT_VIEW')
  listByCustomer(@Param('customerId') customerId: string) {
    return this.measurementsService.listByCustomer(customerId);
  }

  /** MEAS-002 채촌 생성 */
  @Post('customers/:customerId/measurements')
  @RequirePermission('MEASUREMENT_EDIT')
  create(
    @Param('customerId') customerId: string,
    @Body() dto: CreateMeasurementSessionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.measurementsService.create(customerId, dto, actor);
  }

  /** MEAS-003 채촌 비교 (:id 라우트보다 먼저 선언해야 한다) */
  @Get('measurements/compare')
  @RequirePermission('MEASUREMENT_VIEW')
  compare(@Query() query: CompareMeasurementsQueryDto) {
    return this.measurementsService.compare(query.left, query.right);
  }

  /** MEAS-002 채촌 상세 */
  @Get('measurements/:id')
  @RequirePermission('MEASUREMENT_VIEW')
  getDetail(@Param('id') id: string) {
    return this.measurementsService.getDetail(id);
  }

  /** MEAS-002 임시 저장 (값 UPSERT) */
  @Patch('measurements/:id')
  @RequirePermission('MEASUREMENT_EDIT')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMeasurementSessionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.measurementsService.update(id, dto, actor);
  }

  /** MEAS-002 삭제 (작업지시서 출력에 쓰인 세션은 거부) */
  @Delete('measurements/:id')
  @RequirePermission('MEASUREMENT_EDIT')
  remove(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.measurementsService.remove(id, actor);
  }

  /** MEAS-002 완료 해제 */
  @Post('measurements/:id/reopen')
  @RequirePermission('MEASUREMENT_EDIT')
  reopen(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.measurementsService.reopen(id, actor);
  }

  /** MEAS-002 완료 처리 */
  @Post('measurements/:id/complete')
  @RequirePermission('MEASUREMENT_EDIT')
  complete(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.measurementsService.complete(id, actor);
  }

  /** MEAS-001 기존 버전 복사 */
  @Post('measurements/:id/clone')
  @RequirePermission('MEASUREMENT_EDIT')
  clone(
    @Param('id') id: string,
    @Body() dto: CloneMeasurementSessionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.measurementsService.clone(id, dto, actor);
  }

  /** MEAS-001/003 품목 사용 채촌 버전 지정 */
  @Put('order-items/:id/measurement')
  @RequirePermission('MEASUREMENT_EDIT')
  linkOrderItem(
    @Param('id') id: string,
    @Body() dto: LinkOrderItemMeasurementDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.measurementsService.linkOrderItem(id, dto, actor);
  }
}
