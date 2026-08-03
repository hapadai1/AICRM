import { Body, Controller, Get, Patch } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { RentalPolicyService } from './rental-policy.service';
import { UpdateRentalReturnPolicyDto } from './rentals.dto';

/** 렌탈 반납 후 정비 기준 (ADMIN-001 "렌탈 정비 기준") */
@Controller('admin/rental-return-policy')
export class RentalPolicyController {
  constructor(private readonly service: RentalPolicyService) {}

  @Get()
  @RequirePermission('ADMIN_MASTER_EDIT')
  get() {
    return this.service.get();
  }

  @Patch()
  @RequirePermission('ADMIN_MASTER_EDIT')
  update(@Body() dto: UpdateRentalReturnPolicyDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(dto, actor);
  }
}
