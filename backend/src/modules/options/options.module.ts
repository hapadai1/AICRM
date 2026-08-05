import { Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module';
import { OptionMasterController } from './option-master.controller';
import { OptionMasterService } from './option-master.service';
import { OptionProgressService } from './option-progress.service';
import { OptionSessionQueryService } from './option-session-query.service';
import { OptionSessionsController } from './option-sessions.controller';
import { OptionSessionsService } from './option-sessions.service';

/**
 * 옵션 도메인: 마스터(세트·버전·단계·선택지) + 선택 세션.
 * 세션은 목록(progress)·조회(query)·편집(sessions) 세 서비스로 나뉜다 (2026-08-05).
 */
@Module({
  // 옵션 확정 시 계약 품목의 추가금액 롤업 라인을 갱신하려고 ContractsService를 쓴다.
  imports: [ContractsModule],
  controllers: [OptionMasterController, OptionSessionsController],
  providers: [OptionMasterService, OptionSessionsService, OptionSessionQueryService, OptionProgressService],
  exports: [OptionSessionsService],
})
export class OptionsModule {}
