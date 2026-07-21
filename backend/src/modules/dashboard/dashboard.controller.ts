import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  AcknowledgeTaskDto,
  CreateSharedMemoDto,
  TaskQueryDto,
  UpdateSharedMemoDto,
} from './dashboard.dto';
import { DashboardService } from './dashboard.service';
import { SharedMemosService } from './shared-memos.service';

/** 대시보드 요약·확인사항·공유 메모 API — 화면·API 정의서 13.7 (DASH-001) */
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly sharedMemosService: SharedMemosService,
  ) {}

  @Get('dashboard/summary')
  @RequirePermission('DASHBOARD_VIEW')
  summary() {
    return this.dashboardService.summary();
  }

  @Get('dashboard/tasks')
  @RequirePermission('DASHBOARD_VIEW')
  listTasks(@Query() query: TaskQueryDto) {
    return this.dashboardService.listTasks(query.type);
  }

  @Post('dashboard/tasks/:taskId/acknowledge')
  @RequirePermission('DASHBOARD_VIEW')
  acknowledge(
    @Param('taskId') taskId: string,
    @Body() dto: AcknowledgeTaskDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.dashboardService.acknowledge(taskId, dto, actor);
  }

  @Get('shared-memos')
  @RequirePermission('DASHBOARD_VIEW')
  listMemos() {
    return this.sharedMemosService.list();
  }

  @Post('shared-memos')
  @RequirePermission('DASHBOARD_EDIT')
  createMemo(@Body() dto: CreateSharedMemoDto, @CurrentUser() actor: AuthUser) {
    return this.sharedMemosService.create(dto, actor);
  }

  @Patch('shared-memos/:id')
  @RequirePermission('DASHBOARD_EDIT')
  updateMemo(@Param('id') id: string, @Body() dto: UpdateSharedMemoDto, @CurrentUser() actor: AuthUser) {
    return this.sharedMemosService.update(id, dto, actor);
  }

  @Delete('shared-memos/:id')
  @RequirePermission('DASHBOARD_EDIT')
  removeMemo(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.sharedMemosService.remove(id, actor);
  }
}
