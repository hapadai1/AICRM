import { Module } from '@nestjs/common';
import { AdminMasterController } from './admin-master.controller';
import { AdminMasterService } from './admin-master.service';
import { CodeLabelsController } from './code-labels.controller';
import { CodeLabelsService } from './code-labels.service';
import { StatusCatalogController } from './status-catalog.controller';

@Module({
  controllers: [AdminMasterController, CodeLabelsController, StatusCatalogController],
  providers: [AdminMasterService, CodeLabelsService],
  // 통계 계열 라벨 등 다른 모듈에서도 표시명 병합 결과를 쓴다.
  exports: [CodeLabelsService],
})
export class AdminMasterModule {}
