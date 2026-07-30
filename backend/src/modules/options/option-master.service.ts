import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { BusinessException, FieldError } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CHOICE_CODES, MAX_CHOICES, MIN_CHOICES, compareChoiceCodes } from './choice-codes';
import {
  ActivateOptionSetVersionDto,
  CreateOptionSetVersionDto,
  SaveOptionStagesDto,
  UpdateOptionChoicePriceDto,
} from './options.dto';

/** 이미지 미지정 선택지에 연결하는 placeholder 이미지 */
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="170" viewBox="0 0 240 170">
  <rect width="240" height="170" rx="10" fill="#f8f9fa" stroke="#dee2e6" stroke-dasharray="6 4"/>
  <text x="120" y="92" font-size="15" fill="#adb5bd" text-anchor="middle">이미지 없음</text>
</svg>
`;

const CHOICE_SELECT = {
  id: true,
  choiceCode: true,
  choiceName: true,
  factoryLabel: true,
  imageFileId: true,
  extraPrice: true,
  active: true,
} as const;

export { CHOICE_CODES };

const STAGE_INCLUDE = {
  choices: { select: CHOICE_SELECT, orderBy: { choiceCode: 'asc' } },
} as const;

/** 옵션 마스터: 세트·버전·단계·선택지 관리 (ADMIN-002, 설계서 §8.2) */
@Injectable()
export class OptionMasterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** GET /option-sets — 품목별 옵션 세트와 버전 목록 */
  listSets() {
    return this.prisma.optionSet.findMany({
      orderBy: { productCategory: 'asc' },
      select: {
        id: true,
        productCategory: true,
        name: true,
        activeVersionId: true,
        versions: {
          orderBy: { versionNo: 'desc' },
          select: {
            id: true,
            versionNo: true,
            status: true,
            effectiveFrom: true,
            description: true,
            createdAt: true,
          },
        },
      },
    });
  }

  /** GET /option-sets/active?category= — 활성 버전의 단계·선택지 */
  async getActiveSet(category: string) {
    const set = await this.prisma.optionSet.findUnique({
      where: { productCategory: category },
    });
    if (!set) throw new NotFoundException('해당 품목의 옵션 세트가 없습니다.');
    if (!set.activeVersionId)
      throw new BusinessException(
        'OPTION_SET_INVALID',
        `${category} 품목에 활성화된 옵션 버전이 없습니다.`,
      );
    const version = await this.prisma.optionSetVersion.findUniqueOrThrow({
      where: { id: set.activeVersionId },
      include: { stages: { orderBy: { sequenceNo: 'asc' }, include: STAGE_INCLUDE } },
    });
    return {
      optionSetId: set.id,
      productCategory: set.productCategory,
      name: set.name,
      version: this.versionDetail(version),
    };
  }

  /** POST /option-sets/:id/versions — 빈 DRAFT 또는 기존 버전 복사 */
  async createVersion(optionSetId: string, dto: CreateOptionSetVersionDto, actor: AuthUser) {
    const set = await this.prisma.optionSet.findUnique({ where: { id: optionSetId } });
    if (!set) throw new NotFoundException('옵션 세트가 없습니다.');

    let source: { stages: SourceStage[] } | null = null;
    if (dto.copyFromVersionId) {
      const from = await this.prisma.optionSetVersion.findUnique({
        where: { id: dto.copyFromVersionId },
        include: { stages: { orderBy: { sequenceNo: 'asc' }, include: { choices: true } } },
      });
      if (!from || from.optionSetId !== optionSetId)
        throw new BusinessException('VALIDATION_ERROR', '복사할 버전이 해당 옵션 세트에 없습니다.', [
          { field: 'copyFromVersionId', reason: 'NOT_IN_SET' },
        ]);
      source = from;
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const last = await tx.optionSetVersion.aggregate({
        where: { optionSetId },
        _max: { versionNo: true },
      });
      const version = await tx.optionSetVersion.create({
        data: {
          id: randomUUID(),
          optionSetId,
          versionNo: (last._max.versionNo ?? 0) + 1,
          status: 'DRAFT',
          description: dto.description ?? null,
          effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : null,
          createdBy: actor.id,
        },
      });
      if (source) {
        for (const stage of source.stages) {
          await tx.optionStage.create({
            data: {
              id: randomUUID(),
              optionSetVersionId: version.id,
              stageCode: stage.stageCode,
              stageName: stage.stageName,
              sequenceNo: stage.sequenceNo,
              required: stage.required,
              componentGroup: stage.componentGroup,
              active: stage.active,
              choices: {
                create: stage.choices.map((c) => ({
                  id: randomUUID(),
                  choiceCode: c.choiceCode,
                  choiceName: c.choiceName,
                  factoryLabel: c.factoryLabel,
                  imageFileId: c.imageFileId,
                  extraPrice: c.extraPrice,
                  active: c.active,
                })),
              },
            },
          });
        }
      }
      return version;
    });
    return this.getVersionDetail(created.id);
  }

  /** PUT /option-set-versions/:id/stages — DRAFT 버전에 단계·선택지 일괄 저장 */
  async saveStages(versionId: string, dto: SaveOptionStagesDto, actor: AuthUser) {
    const version = await this.prisma.optionSetVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundException('옵션 세트 버전이 없습니다.');
    if (version.status !== 'DRAFT')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        'DRAFT 버전만 수정할 수 있습니다. 새 버전을 만들어 수정하세요.',
        undefined,
        { status: version.status },
      );

    this.validateStageStructure(dto);
    await this.ensureFilesExist(dto);

    await this.prisma.$transaction(async (tx) => {
      await tx.optionChoice.deleteMany({
        where: { optionStage: { optionSetVersionId: versionId } },
      });
      await tx.optionStage.deleteMany({ where: { optionSetVersionId: versionId } });
      for (const stage of dto.stages) {
        const choices: Prisma.OptionChoiceCreateWithoutOptionStageInput[] = [];
        for (const c of stage.choices) {
          choices.push({
            id: randomUUID(),
            choiceCode: c.choiceCode,
            choiceName: c.choiceName,
            factoryLabel: c.factoryLabel ?? null,
            extraPrice: c.extraPrice ?? 0,
            active: c.active ?? true,
            imageFile: c.imageFileId
              ? { connect: { id: c.imageFileId } }
              : { create: this.placeholderFileData() },
          });
        }
        await tx.optionStage.create({
          data: {
            id: randomUUID(),
            optionSetVersionId: versionId,
            stageCode: stage.stageCode,
            stageName: stage.stageName,
            sequenceNo: stage.sequenceNo,
            required: stage.required ?? true,
            componentGroup: stage.componentGroup ?? null,
            active: stage.active ?? true,
            choices: { create: choices },
          },
        });
      }
      await tx.optionSetVersion.update({
        where: { id: versionId },
        data: { updatedAt: new Date() },
      });
    });
    return this.getVersionDetail(versionId);
  }

  /**
   * DELETE /option-set-versions/:id — 작성중(DRAFT) 버전을 삭제한다.
   *
   * 새 버전을 잘못 만들면 되돌릴 방법이 없어 초안이 계속 쌓였다. 아직 아무 계약도 쓰지 않는
   * DRAFT만 지운다 — 사용중·종료 버전은 확정 계약이 참조하는 과거 기록이라 삭제하지 않는다.
   */
  async deleteVersion(versionId: string, actor: AuthUser) {
    const version = await this.prisma.optionSetVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        optionSetId: true,
        versionNo: true,
        status: true,
        // 감사로그에서 "어느 옵션셋의 몇 번 버전을 지웠나"가 이름으로 읽혀야 한다 (UUID만으로는 못 읽는다).
        optionSet: { select: { name: true } },
        _count: { select: { selectionSessions: true, stages: true } },
      },
    });
    if (!version) throw new NotFoundException('옵션 세트 버전이 없습니다.');
    if (version.status !== 'DRAFT')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '작성중 버전만 삭제할 수 있습니다.',
        undefined,
        { status: version.status },
      );
    // DRAFT는 옵션 선택 화면에 뜨지 않지만, 활성화 후 되돌린 데이터가 있을 수 있어 확인한다.
    if (version._count.selectionSessions > 0)
      throw new BusinessException(
        'VALIDATION_ERROR',
        '이 버전으로 진행된 옵션 선택이 있어 삭제할 수 없습니다.',
        [{ field: 'versionId', reason: 'HAS_SELECTION_SESSIONS' }],
      );

    await this.prisma.$transaction(async (tx) => {
      await tx.optionChoice.deleteMany({
        where: { optionStage: { optionSetVersionId: versionId } },
      });
      await tx.optionStage.deleteMany({ where: { optionSetVersionId: versionId } });
      await tx.optionSetVersion.delete({ where: { id: versionId } });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'DELETE',
          entityType: 'OPTION_SET_VERSION',
          entityId: versionId,
          before: {
            optionSetName: version.optionSet.name,
            optionSetId: version.optionSetId,
            versionNo: version.versionNo,
            status: version.status,
            stageCount: version._count.stages,
          },
        },
        tx,
      );
    });

    return { versionId, optionSetId: version.optionSetId, versionNo: version.versionNo };
  }

  /**
   * PATCH /option-choices/:id/price — 선택지 추가금액만 수정한다. **작성중(DRAFT) 버전 전용.**
   *
   * 예전에는 사용중(ACTIVE) 버전의 가격을 그 자리에서 고칠 수 있었다. 버전이 늘지 않아
   * 편하지만, 같은 버전 번호가 시점에 따라 다른 금액을 뜻하게 되어 "V1로 계약했다"는 말만으로는
   * 얼마였는지 알 수 없었다. 가격도 구성과 똑같이 새 버전으로만 바꾼다.
   * - 이미 확정된 계약: option_selection_values.extra_price_snapshot 을 쓰므로 어느 쪽이든 영향 없다.
   * 변경 이력은 감사로그(OPTION_CHOICE / UPDATE)로만 남긴다 — 화면에 따로 노출하지 않는다.
   */
  async updateChoicePrice(choiceId: string, dto: UpdateOptionChoicePriceDto, actor: AuthUser) {
    const choice = await this.prisma.optionChoice.findUnique({
      where: { id: choiceId },
      select: {
        id: true,
        choiceCode: true,
        choiceName: true,
        extraPrice: true,
        optionStage: {
          select: {
            stageName: true,
            optionSetVersionId: true,
            optionSetVersion: {
              select: { status: true, versionNo: true, optionSet: { select: { name: true } } },
            },
          },
        },
      },
    });
    if (!choice) throw new NotFoundException('옵션 선택지가 없습니다.');

    const versionStatus = choice.optionStage.optionSetVersion.status;
    if (versionStatus !== 'DRAFT')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        versionStatus === 'ACTIVE'
          ? '사용중 버전의 가격은 수정할 수 없습니다. 새 버전을 만들어 수정한 뒤 활성화해 주세요.'
          : '종료된 버전의 가격은 수정할 수 없습니다.',
        undefined,
        { status: versionStatus },
      );

    const before = Number(choice.extraPrice);
    if (before === dto.extraPrice) {
      // 값이 같으면 감사로그를 남기지 않는다 — 이력이 의미 없는 줄로 지저분해진다.
      return { choiceId, extraPrice: before, changed: false };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.optionChoice.update({
        where: { id: choiceId },
        data: { extraPrice: dto.extraPrice },
        select: { extraPrice: true },
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'UPDATE',
          entityType: 'OPTION_CHOICE',
          entityId: choiceId,
          // 나중에 "이 계약 옵션 가격이 왜 이랬지"를 되짚을 때 단계·선택지 이름이 같이 보여야 한다.
          before: {
            optionSetName: choice.optionStage.optionSetVersion.optionSet.name,
            extraPrice: before,
            stageName: choice.optionStage.stageName,
            choiceName: choice.choiceName,
            versionNo: choice.optionStage.optionSetVersion.versionNo,
          },
          after: {
            optionSetName: choice.optionStage.optionSetVersion.optionSet.name,
            extraPrice: dto.extraPrice,
            stageName: choice.optionStage.stageName,
            choiceName: choice.choiceName,
            versionNo: choice.optionStage.optionSetVersion.versionNo,
          },
          reason: dto.reason,
        },
        tx,
      );
      return row;
    });

    return { choiceId, extraPrice: Number(updated.extraPrice), changed: true };
  }

  /** POST /option-set-versions/:id/activate — 검증 후 기존 ACTIVE→RETIRED, 신규 ACTIVE (단일 트랜잭션) */
  async activate(versionId: string, dto: ActivateOptionSetVersionDto, actor: AuthUser) {
    const version = await this.prisma.optionSetVersion.findUnique({
      where: { id: versionId },
      include: {
        optionSet: { select: { name: true } },
        stages: {
          where: { active: true },
          orderBy: { sequenceNo: 'asc' },
          include: { choices: { where: { active: true } } },
        },
      },
    });
    if (!version) throw new NotFoundException('옵션 세트 버전이 없습니다.');
    if (version.status !== 'DRAFT')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        'DRAFT 상태의 버전만 활성화할 수 있습니다.',
        undefined,
        { status: version.status },
      );

    if (version.stages.length === 0)
      throw new BusinessException('OPTION_SET_INVALID', '활성 단계가 없는 버전은 활성화할 수 없습니다.');
    const invalid = version.stages.filter(
      (s) => !isValidChoiceSet(s.choices.map((c) => c.choiceCode)),
    );
    if (invalid.length > 0)
      throw new BusinessException(
        'OPTION_SET_INVALID',
        `모든 활성 단계에는 선택지가 ${MIN_CHOICES}~${MAX_CHOICES}개 있어야 하며 코드는 A부터 순서대로여야 합니다.`,
        invalid.map((s) => ({ field: s.stageCode, reason: 'INVALID_CHOICE_SET' })),
      );

    const previousActive = await this.prisma.optionSetVersion.findMany({
      where: { optionSetId: version.optionSetId, status: 'ACTIVE' },
      select: { id: true, versionNo: true },
    });

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.optionSetVersion.updateMany({
        where: { optionSetId: version.optionSetId, status: 'ACTIVE' },
        data: { status: 'RETIRED' },
      });
      const activated = await tx.optionSetVersion.update({
        where: { id: versionId },
        data: {
          status: 'ACTIVE',
          effectiveFrom: dto.effectiveFrom
            ? new Date(dto.effectiveFrom)
            : (version.effectiveFrom ?? new Date()),
        },
      });
      await tx.optionSet.update({
        where: { id: version.optionSetId },
        data: { activeVersionId: versionId },
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'ACTIVATE',
          entityType: 'OPTION_SET_VERSION',
          entityId: versionId,
          before: {
            optionSetName: version.optionSet.name,
            versionNo: version.versionNo,
            status: 'DRAFT',
            previousActiveVersionIds: previousActive.map((v) => v.id),
          },
          after: {
            optionSetName: version.optionSet.name,
            versionNo: activated.versionNo,
            status: 'ACTIVE',
          },
        },
        tx,
      );
      return activated;
    });

    return {
      optionSetId: version.optionSetId,
      versionId: result.id,
      versionNo: result.versionNo,
      status: result.status,
      effectiveFrom: result.effectiveFrom,
      retiredVersionIds: previousActive.map((v) => v.id),
    };
  }

  /** 버전 상세(단계·선택지 포함) */
  async getVersionDetail(versionId: string) {
    const version = await this.prisma.optionSetVersion.findUnique({
      where: { id: versionId },
      include: { stages: { orderBy: { sequenceNo: 'asc' }, include: STAGE_INCLUDE } },
    });
    if (!version) throw new NotFoundException('옵션 세트 버전이 없습니다.');
    return this.versionDetail(version);
  }

  // -------------------------------------------------------------------------

  private versionDetail(version: {
    id: string;
    optionSetId: string;
    versionNo: number;
    status: string;
    effectiveFrom: Date | null;
    description: string | null;
    stages: Array<{
      id: string;
      stageCode: string;
      stageName: string;
      sequenceNo: number;
      required: boolean;
      componentGroup: string | null;
      active: boolean;
      choices: Array<{
        id: string;
        choiceCode: string;
        choiceName: string;
        factoryLabel: string | null;
        imageFileId: string;
        extraPrice: Prisma.Decimal;
        active: boolean;
      }>;
    }>;
  }) {
    return {
      id: version.id,
      optionSetId: version.optionSetId,
      versionNo: version.versionNo,
      status: version.status,
      effectiveFrom: version.effectiveFrom,
      description: version.description,
      stages: version.stages.map((s) => ({
        id: s.id,
        stageCode: s.stageCode,
        stageName: s.stageName,
        sequenceNo: s.sequenceNo,
        required: s.required,
        componentGroup: s.componentGroup,
        active: s.active,
        // Decimal은 JSON에서 문자열이 되므로 화면이 바로 쓰도록 숫자로 낮춘다.
        choices: [...s.choices]
          .sort((a, b) => compareChoiceCodes(a.choiceCode, b.choiceCode))
          .map((c) => ({ ...c, extraPrice: Number(c.extraPrice) })),
      })),
    };
  }

  /** 단계 코드·순서 중복, 활성 단계 선택지 2~10개(A부터 순서대로) 규칙 검증 (위반 시 OPTION_SET_INVALID) */
  private validateStageStructure(dto: SaveOptionStagesDto): void {
    const errors: FieldError[] = [];
    const codes = new Set<string>();
    const seqs = new Set<number>();
    dto.stages.forEach((stage, i) => {
      if (codes.has(stage.stageCode))
        errors.push({ field: `stages[${i}].stageCode`, reason: 'DUPLICATE_STAGE_CODE' });
      codes.add(stage.stageCode);
      if (seqs.has(stage.sequenceNo))
        errors.push({ field: `stages[${i}].sequenceNo`, reason: 'DUPLICATE_SEQUENCE_NO' });
      seqs.add(stage.sequenceNo);

      const choiceCodes = stage.choices.map((c) => c.choiceCode);
      if (new Set(choiceCodes).size !== choiceCodes.length)
        errors.push({ field: `stages[${i}].choices`, reason: 'DUPLICATE_CHOICE_CODE' });
      if (stage.active !== false) {
        const activeCodes = stage.choices.filter((c) => c.active !== false).map((c) => c.choiceCode);
        if (stage.choices.length !== activeCodes.length || !isValidChoiceSet(activeCodes))
          errors.push({ field: `stages[${i}].choices`, reason: 'INVALID_CHOICE_SET' });
      }
    });
    if (errors.length > 0)
      throw new BusinessException(
        'OPTION_SET_INVALID',
        `각 활성 단계에는 선택지가 ${MIN_CHOICES}~${MAX_CHOICES}개 있어야 하며 코드는 A부터 순서대로여야 합니다.`,
        errors,
      );
  }

  private async ensureFilesExist(dto: SaveOptionStagesDto): Promise<void> {
    const ids = [
      ...new Set(
        dto.stages.flatMap((s) =>
          s.choices.map((c) => c.imageFileId).filter((v): v is string => !!v),
        ),
      ),
    ];
    if (ids.length === 0) return;
    const found = await this.prisma.file.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const foundIds = new Set(found.map((f) => f.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0)
      throw new BusinessException('VALIDATION_ERROR', '존재하지 않는 이미지 파일이 있습니다.', [
        { field: 'imageFileId', reason: `NOT_FOUND: ${missing.join(', ')}` },
      ]);
  }

  /**
   * image_file_id는 필수 FK이므로 이미지 미지정 선택지에는 placeholder 파일을 생성해 연결한다.
   * 레코드만 만들면 다운로드가 404가 되므로 저장소에도 실제 파일을 기록한다.
   */
  private placeholderFileData(): Prisma.FileCreateWithoutOptionChoicesInput {
    const id = randomUUID();
    const storageKey = `placeholders/options/${id}.svg`;
    const buffer = Buffer.from(PLACEHOLDER_SVG, 'utf8');
    const absolutePath = join(
      resolve(process.env.FILE_STORAGE_PATH ?? './storage'),
      storageKey,
    );
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, buffer);
    return {
      id,
      storageKey,
      originalName: 'option-placeholder.svg',
      mimeType: 'image/svg+xml',
      sizeBytes: BigInt(buffer.length),
      checksumSha256: createHash('sha256').update(buffer).digest('hex'),
    };
  }
}

/** 선택지 코드 집합이 A부터 빈칸 없이 2~40개인지 (A,B / A,B,C / … / A~Z,AA~AN 만 통과) */
function isValidChoiceSet(codes: string[]): boolean {
  if (codes.length < MIN_CHOICES || codes.length > MAX_CHOICES) return false;
  // 두 자리 코드가 섞이면 사전순 정렬이 어긋난다(AA < B). 집합으로 비교한다.
  const expected = new Set(CHOICE_CODES.slice(0, codes.length));
  return new Set(codes).size === codes.length && codes.every((c) => expected.has(c));
}

interface SourceStage {
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  required: boolean;
  componentGroup: string | null;
  active: boolean;
  choices: Array<{
    choiceCode: string;
    choiceName: string;
    factoryLabel: string | null;
    imageFileId: string;
    extraPrice: Prisma.Decimal;
    active: boolean;
  }>;
}
