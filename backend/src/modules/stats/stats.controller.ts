import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators';
import {
  OptionPopularityQueryDto,
  RentalPopularityQueryDto,
  StatsCountsQueryDto,
} from './stats.dto';
import { StatsService } from './stats.service';

/**
 * 건수 통계 API (STAT-001).
 * 대시보드가 "오늘 할 일"을 보는 화면이라면, 이쪽은 "얼마나 했는지"를 기간 단위로 세는 화면이다.
 */
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('counts')
  @RequirePermission('STATS_VIEW')
  counts(@Query() query: StatsCountsQueryDto) {
    return this.statsService.counts(query);
  }

  @Get('option-popularity')
  @RequirePermission('STATS_VIEW')
  optionPopularity(@Query() query: OptionPopularityQueryDto) {
    return this.statsService.optionPopularity(query);
  }

  @Get('rental-popularity')
  @RequirePermission('STATS_VIEW')
  rentalPopularity(@Query() query: RentalPopularityQueryDto) {
    return this.statsService.rentalPopularity(query);
  }
}
