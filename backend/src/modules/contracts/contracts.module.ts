import { Module } from '@nestjs/common';
import { ContractTypesController } from './contract-types.controller';
import { ContractTypesService } from './contract-types.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

/** 계약 구분 마스터·계약(버전·라인)·확정·변경계약 도메인 */
@Module({
  controllers: [ContractTypesController, ContractsController],
  providers: [ContractTypesService, ContractsService],
  exports: [ContractsService],
})
export class ContractsModule {}
