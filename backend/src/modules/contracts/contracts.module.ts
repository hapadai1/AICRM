import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { ContractDocumentService } from './contract-document.service';
import { ContractItemsService } from './contract-items.service';
import { ContractMaterializeService } from './contract-materialize.service';
import { ContractTypesController } from './contract-types.controller';
import { ContractTypesService } from './contract-types.service';
import { ContractVersionsService } from './contract-versions.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

/**
 * 계약 구분 마스터·계약(버전·라인)·확정·변경계약 도메인.
 * ContractsService는 진입점(facade)이고, 물리화·품목·문서·버전 축은 각자의 서비스가 진다 (2026-08-05).
 */
@Module({
  imports: [FilesModule],
  controllers: [ContractTypesController, ContractsController],
  providers: [
    ContractTypesService,
    ContractsService,
    ContractMaterializeService,
    ContractItemsService,
    ContractDocumentService,
    ContractVersionsService,
  ],
  exports: [ContractsService],
})
export class ContractsModule {}
