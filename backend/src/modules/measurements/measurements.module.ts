import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { MeasurementsController } from './measurements.controller';
import { MeasurementsService } from './measurements.service';

@Module({
  // 채촌 이미지 첨부(EntityFile)에 FilesService(업로드·파일정리)를 재사용한다 (설계서 05 §4).
  imports: [FilesModule],
  controllers: [MeasurementsController],
  providers: [MeasurementsService],
  exports: [MeasurementsService],
})
export class MeasurementsModule {}
