import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, existsSync, mkdirSync, promises as fsp, writeFileSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import { Response } from 'express';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/** 허용 확장자 (화면·API 정의서 파일 공통 규칙) */
const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'xlsx'];

/**
 * multer 업로드 파일의 구조 타입.
 * (tsconfig.spec.json이 types를 jest/node로 제한해 Express.Multer 전역 확장을
 * 사용할 수 없으므로 필요한 필드만 구조적으로 선언한다.)
 */
export interface UploadedMulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface FileView {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  downloadUrl: string;
  createdAt: Date;
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get storageRoot(): string {
    return resolve(this.config.get<string>('FILE_STORAGE_PATH', './storage'));
  }

  /** 업로드: 확장자 검증 → sha256 → FILE_STORAGE_PATH 저장 → files 레코드. */
  async upload(file: UploadedMulterFile | undefined, actor: AuthUser): Promise<FileView> {
    if (!file)
      throw new BusinessException('VALIDATION_ERROR', '업로드할 파일(file 필드)이 필요합니다.', [
        { field: 'file', reason: 'REQUIRED' },
      ]);
    const ext = extname(file.originalname).slice(1).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext))
      throw new BusinessException(
        'FILE_TYPE_NOT_ALLOWED',
        `허용되지 않은 파일 형식입니다. (허용: ${ALLOWED_EXTENSIONS.join(', ')})`,
        [{ field: 'file', reason: 'FILE_TYPE_NOT_ALLOWED' }],
      );

    const id = randomUUID();
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const storageKey = `${yyyymm}/${id}.${ext}`;
    const absolutePath = join(this.storageRoot, storageKey);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.buffer);

    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const record = await this.prisma.file.create({
      data: {
        id,
        storageKey,
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: BigInt(file.size),
        checksumSha256: checksum,
      },
    });
    const view = this.toView(record);
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'FILE',
      entityId: id,
      after: view,
    });
    return view;
  }

  /** 스트리밍 다운로드 (인증 필요, 권한은 연결 엔티티에서 상속). */
  async download(id: string, res: Response): Promise<void> {
    const record = await this.prisma.file.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('파일이 없습니다.');
    const absolutePath = join(this.storageRoot, record.storageKey);
    if (!existsSync(absolutePath)) throw new NotFoundException('파일 원본이 저장소에 없습니다.');

    res.setHeader('Content-Type', record.mimeType);
    res.setHeader('Content-Length', record.sizeBytes.toString());
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(record.originalName)}`,
    );
    await new Promise<void>((resolvePipe, rejectPipe) => {
      const stream = createReadStream(absolutePath);
      stream.on('error', rejectPipe);
      res.on('finish', resolvePipe);
      stream.pipe(res);
    });
  }

  /** 어떤 엔티티에서도 참조하지 않는 파일만 삭제한다. */
  async remove(id: string, actor: AuthUser) {
    const record = await this.prisma.file.findUnique({
      where: { id },
      include: {
        _count: { select: { entityFiles: true, optionChoices: true, workOrderVersionOutputs: true } },
      },
    });
    if (!record) throw new NotFoundException('파일이 없습니다.');
    const referenced =
      record._count.entityFiles + record._count.optionChoices + record._count.workOrderVersionOutputs;
    if (referenced > 0)
      throw new BusinessException('VALIDATION_ERROR', '참조 중인 파일은 삭제할 수 없습니다.', undefined, {
        entityFiles: record._count.entityFiles,
        optionChoices: record._count.optionChoices,
        workOrderVersions: record._count.workOrderVersionOutputs,
      });

    await this.prisma.file.delete({ where: { id } });
    await fsp.unlink(join(this.storageRoot, record.storageKey)).catch(() => undefined);
    await this.audit.log({
      userId: actor.id,
      action: 'DELETE',
      entityType: 'FILE',
      entityId: id,
      before: this.toView(record),
    });
    return { id, deleted: true };
  }

  private toView(record: {
    id: string;
    originalName: string;
    mimeType: string;
    sizeBytes: bigint;
    checksumSha256: string | null;
    createdAt: Date;
  }): FileView {
    return {
      id: record.id,
      originalName: record.originalName,
      mimeType: record.mimeType,
      sizeBytes: Number(record.sizeBytes),
      checksumSha256: record.checksumSha256,
      downloadUrl: `/api/v1/files/${record.id}`,
      createdAt: record.createdAt,
    };
  }
}
