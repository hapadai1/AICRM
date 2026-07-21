import { Module } from '@nestjs/common';
import { OptionMasterController } from './option-master.controller';
import { OptionMasterService } from './option-master.service';
import { OptionSessionsController } from './option-sessions.controller';
import { OptionSessionsService } from './option-sessions.service';

/** 옵션 도메인: 마스터(세트·버전·단계·선택지) + 선택 세션(임시저장·확정) */
@Module({
  controllers: [OptionMasterController, OptionSessionsController],
  providers: [OptionMasterService, OptionSessionsService],
  exports: [OptionSessionsService],
})
export class OptionsModule {}
