import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { FilesService, UploadedMulterFile } from './files.service';

/** 파일 공통 API — 화면·API 정의서 13.8 */
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post()
  @RequirePermission('FILE_UPLOAD')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: UploadedMulterFile | undefined, @CurrentUser() actor: AuthUser) {
    return this.filesService.upload(file, actor);
  }

  /** 다운로드는 인증만 요구한다 (세부 권한은 연결 화면에서 상속). */
  @Get(':id')
  download(@Param('id') id: string, @Res() res: Response) {
    return this.filesService.download(id, res);
  }

  @Delete(':id')
  @RequirePermission('FILE_DELETE')
  remove(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.filesService.remove(id, actor);
  }
}
