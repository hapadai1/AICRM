import { Controller, Get } from '@nestjs/common';
import { statusCatalogResponse } from '../../common/status-catalog';

/**
 * 상태 코드 사전 조회 — 앱 전역 하이드레이션용 (code-labels와 같은 방식).
 * 상태는 관리자가 편집하지 않으므로(코드·표시명 모두 코드 상수) 조회만 있다.
 */
@Controller()
export class StatusCatalogController {
  @Get('status-catalog')
  list() {
    return statusCatalogResponse();
  }
}
