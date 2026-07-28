import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FilesService } from '../files/files.service';
import { COMPONENT_GROUP_LABELS, componentGroupsFor } from '../options/option-component-groups';
import { buildContractExcel, ContractExcelLine } from './contract-excel';
import {
  CancelContractDto,
  ConfirmContractDto,
  ConfirmRevisionDto,
  CONTRACT_SORT_FIELDS,
  ContractLineDto,
  ContractListQueryDto,
  CreateContractDto,
  CreateRevisionDto,
  SaveSignatureDto,
  UpdateContractDto,
} from './contracts.dto';

/** 품목 대분류 → 기본 구성품 (설계서 7.2). 베스트는 주문 화면에서 선택 추가. */
const COMPONENT_MAP: Record<string, string[]> = {
  SUIT: ['JACKET', 'TROUSERS'],
  SHIRT: ['SHIRT'],
  SHOES: ['SHOES'],
};

const CATEGORY_LABEL: Record<string, string> = {
  SUIT: '정장',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/** 구성품(부위) 한글 라벨 (설계서 03 §5.3) */
const COMPONENT_LABEL: Record<string, string> = {
  JACKET: '상의',
  TROUSERS: '하의',
  VEST: '베스트',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/** 계약서 웹 표시용 주문품목 계층 (품목 → 부위 → 유료 옵션) */
interface ContractDocumentItem {
  orderItemId: string;
  orderNo: string;
  displayName: string;
  sequenceNo: number;
  components: Array<{
    group: string;
    groupLabel: string;
    options: Array<{ stageName: string; optionName: string; extraPrice: number }>;
  }>;
  optionTotal: number;
}

/** 서명 이미지 디코드 버퍼 상한 (설계서 03 §2.3) */
const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;

const VERSION_INCLUDE = {
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ContractVersionInclude;

const DETAIL_INCLUDE = {
  customer: {
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      customerStatus: true,
      contractedAt: true,
      registeredAt: true,
    },
  },
  contractType: { select: { id: true, code: true, name: true } },
  currentVersion: { include: VERSION_INCLUDE },
  versions: { include: VERSION_INCLUDE, orderBy: { versionNo: 'asc' } },
  orders: {
    include: {
      items: {
        include: { components: { orderBy: { componentType: 'asc' } } },
        orderBy: [{ productCategory: 'asc' }, { sequenceNo: 'asc' }],
      },
    },
    orderBy: { transactionType: 'asc' },
  },
} satisfies Prisma.ContractInclude;

/** 목록 행 include (개편계획 06 §2.2 컬럼 기준) */
const LIST_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  contractType: { select: { id: true, code: true, name: true } },
  currentVersion: {
    select: {
      versionNo: true,
      versionStatus: true,
      totalAmount: true,
      completionDueDate: true,
    },
  },
} satisfies Prisma.ContractInclude;

/** 정렬·집계에 쓰는 목록 행의 최소 형태 */
interface ContractListRow {
  contractedAt: Date | null;
  createdAt: Date;
  currentVersion: { totalAmount: Prisma.Decimal; completionDueDate: Date | null } | null;
}

type OrderSummary = { id: string; orderNo: string; tradeType: string };

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  // ---------------------------------------------------------------------------
  // 초안 생성·조회·수정
  // ---------------------------------------------------------------------------

  async create(dto: CreateContractDto, actor: AuthUser) {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');

    let lines: ContractLineDto[] = dto.lines ?? [];
    if (dto.contractTypeId) {
      const contractType = await this.prisma.contractType.findUnique({
        where: { id: dto.contractTypeId },
        include: { lines: { where: { active: true }, orderBy: { sortOrder: 'asc' } } },
      });
      if (!contractType) throw new NotFoundException('계약 구분이 없습니다.');
      if (!contractType.active)
        throw new BusinessException('VALIDATION_ERROR', '사용 중지된 계약 구분입니다.', [
          { field: 'contractTypeId', reason: 'RETIRED' },
        ]);
      if (!dto.lines) {
        // 계약 구분 선택 시 기본 품목을 복사한다. 이후 마스터 변경은 이 계약에 영향 없음.
        lines = contractType.lines.map((l) => ({
          transactionType: l.transactionType,
          productCategory: l.productCategory,
          quantity: l.defaultQuantity,
          sortOrder: l.sortOrder,
        }));
      }
    }

    const contract = await this.prisma.$transaction(async (tx) => {
      const contractId = randomUUID();
      const versionId = randomUUID();
      await tx.contract.create({
        data: {
          id: contractId,
          contractNo: await this.nextNo(tx, 'CTR'),
          customerId: dto.customerId,
          contractTypeId: dto.contractTypeId ?? null,
          status: 'DRAFT',
        },
      });
      await tx.contractVersion.create({
        data: {
          id: versionId,
          contractId,
          versionNo: 1,
          versionStatus: 'DRAFT',
          totalAmount: dto.totalAmount ?? 0,
          completionDueDate: toDate(dto.completionDueDate),
          photoDate: toDate(dto.photoDate),
          weddingDate: toDate(dto.weddingDate),
          createdBy: actor.id,
          lines: { create: lines.map((l, i) => this.toLineData(l, i)) },
        },
      });
      return tx.contract.update({
        where: { id: contractId },
        data: { currentVersionId: versionId },
        include: DETAIL_INCLUDE,
      });
    });

    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'CONTRACT',
      entityId: contract.id,
      after: {
        contractNo: contract.contractNo,
        customerId: contract.customerId,
        totalAmount: dto.totalAmount ?? 0,
        lines: lines.map(lineSummary),
      },
    });
    return contract;
  }

  /**
   * 계약 목록 (개편계획 06).
   * 필터에 맞는 계약을 모두 읽고 메모리에서 정렬·페이징한다. (온프레미스 단일 매장 규모 전제)
   */
  async list(query: ContractListQueryDto) {
    const where = this.buildListWhere(query);
    const rows = await this.prisma.contract.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    const sorted = this.sortList(rows, query.sort);
    const page = sorted.slice(query.skip, query.skip + query.size);

    // 요약은 페이지가 아니라 필터 전체 기준이다.
    const totals = sorted.reduce(
      (acc, row) => {
        acc.count += 1;
        acc.totalAmount += Number(row.currentVersion?.totalAmount ?? 0);
        return acc;
      },
      { count: 0, totalAmount: 0 },
    );

    return new Paginated(page, query.page, query.size, sorted.length, { totals });
  }

  /** 목록 검색 조건 (개편계획 06 §3.1) */
  private buildListWhere(query: ContractListQueryDto): Prisma.ContractWhereInput {
    const search = (query.search ?? query.q)?.trim(); // q는 search 별칭 (연동정합화 계약 §3)
    const digits = search?.replace(/\D/g, '') ?? '';
    const range = this.buildDateRange(query.dateFrom, query.dateTo);

    return {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.contractTypeId ? { contractTypeId: query.contractTypeId } : {}),
      ...(search
        ? {
            OR: [
              { contractNo: { contains: search, mode: 'insensitive' } },
              { customer: { name: { contains: search, mode: 'insensitive' } } },
              // 전화번호는 하이픈 없이 저장되므로 숫자만 남겨 비교한다.
              ...(digits ? [{ customer: { phoneNormalized: { contains: digits } } }] : []),
              { contractType: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
      // 검색어 조건이 OR를 이미 쓰므로 기간 조건은 AND로 감싸 키 충돌을 피한다.
      ...(range ? { AND: [this.buildDateFilter(query.dateField ?? 'contractedAt', range)] } : {}),
    };
  }

  /** 날짜만 주어지면 종료일 전체를 포함한다(lt = 다음 날 00:00) */
  private buildDateRange(
    dateFrom: string | undefined,
    dateTo: string | undefined,
  ): { gte?: Date; lt?: Date } | null {
    if (!dateFrom && !dateTo) return null;
    const range: { gte?: Date; lt?: Date } = {};
    if (dateFrom) range.gte = new Date(dateFrom);
    if (dateTo) {
      const to = new Date(dateTo);
      to.setDate(to.getDate() + 1);
      range.lt = to;
    }
    if (range.gte && range.lt && range.gte > range.lt) {
      throw new BusinessException('VALIDATION_ERROR', '조회 기간이 올바르지 않습니다.', [
        { field: 'dateFrom', reason: 'INVALID_DATE_RANGE' },
      ]);
    }
    return range;
  }

  private buildDateFilter(
    dateField: string,
    range: { gte?: Date; lt?: Date },
  ): Prisma.ContractWhereInput {
    if (dateField === 'completionDueDate') {
      return { currentVersion: { completionDueDate: range } };
    }
    // 계약일이 없는 초안(임시저장)은 등록일로 갈음한다 — 정렬(sortList)과 같은 규칙.
    return {
      OR: [{ contractedAt: range }, { contractedAt: null, createdAt: range }],
    };
  }

  /** `필드,방향` 정렬. 허용 밖 필드는 기본값(계약일 내림차순)으로 되돌린다. */
  private sortList<T extends ContractListRow>(rows: T[], sort: string | undefined): T[] {
    const [field, direction = 'desc'] = (sort ?? 'contractedAt,desc').split(',');
    const key = (CONTRACT_SORT_FIELDS as readonly string[]).includes(field) ? field : 'contractedAt';
    const sign = direction === 'asc' ? 1 : -1;

    const valueOf = (row: T): number | string => {
      switch (key) {
        case 'totalAmount':
          return Number(row.currentVersion?.totalAmount ?? 0);
        case 'completionDueDate':
          return row.currentVersion?.completionDueDate?.getTime() ?? 0;
        default:
          // 계약일이 없는 초안은 등록일로 갈음한다.
          return (row.contractedAt ?? row.createdAt).getTime();
      }
    };

    return [...rows].sort((a, b) => {
      const av = valueOf(a);
      const bv = valueOf(b);
      if (av === bv) return 0;
      return av > bv ? sign : -sign;
    });
  }

  async getDetail(id: string) {
    const contract = await this.prisma.contract.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!contract) throw new NotFoundException('계약이 없습니다.');
    return contract;
  }

  async getVersions(id: string) {
    await this.getContractOrThrow(id);
    return this.prisma.contractVersion.findMany({
      where: { contractId: id },
      include: VERSION_INCLUDE,
      orderBy: { versionNo: 'asc' },
    });
  }

  /** 초안 수정. DRAFT 상태가 아니면 CONTRACT_NOT_DRAFT — 확정본은 계약 변경으로만 수정한다. */
  async update(id: string, dto: UpdateContractDto, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    if (contract.status !== 'DRAFT')
      throw new BusinessException('CONTRACT_NOT_DRAFT', '확정된 계약은 계약 변경 기능으로만 수정할 수 있습니다.', undefined, {
        status: contract.status,
      });
    this.assertVersionMatch(contract.rowVersion, dto.version);

    const draft = await this.prisma.contractVersion.findFirst({
      where: { contractId: id, versionStatus: 'DRAFT' },
      orderBy: { versionNo: 'desc' },
    });
    if (!draft) throw new BusinessException('CONTRACT_NOT_DRAFT', '수정할 초안 버전이 없습니다.');

    // 감사로그 전/후 비교용 — 초안 버전의 금액·일정·서명 상태와 품목 목록을 스냅샷으로 남긴다.
    const beforeLines = await this.prisma.contractLine.findMany({
      where: { contractVersionId: draft.id },
      orderBy: { sortOrder: 'asc' },
    });

    await this.prisma.$transaction(async (tx) => {
      if (dto.lines) {
        await tx.contractLine.deleteMany({ where: { contractVersionId: draft.id } });
        await tx.contractLine.createMany({
          data: dto.lines.map((l, i) => ({ ...this.toLineData(l, i), contractVersionId: draft.id })),
        });
      }
      const updatedDraft = await tx.contractVersion.update({
        where: { id: draft.id },
        data: {
          ...(dto.totalAmount !== undefined ? { totalAmount: dto.totalAmount } : {}),
          ...(dto.completionDueDate !== undefined ? { completionDueDate: toDate(dto.completionDueDate) } : {}),
          ...(dto.photoDate !== undefined ? { photoDate: toDate(dto.photoDate) } : {}),
          ...(dto.weddingDate !== undefined ? { weddingDate: toDate(dto.weddingDate) } : {}),
          // 서명 후 내용 수정 시 서명 무효화 (설계서 03 §2.6) — 재서명 강제.
          ...(draft.signatureFileId
            ? { signatureFileId: null, signedAt: null, signerName: null }
            : {}),
        },
      });
      const updatedContract = await tx.contract.update({
        where: { id },
        data: {
          ...(dto.contractTypeId !== undefined ? { contractTypeId: dto.contractTypeId } : {}),
          rowVersion: { increment: 1 },
        },
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'UPDATE',
          entityType: 'CONTRACT',
          entityId: id,
          before: this.draftSnapshot(contract, draft, beforeLines),
          after: this.draftSnapshot(
            updatedContract,
            updatedDraft,
            dto.lines ?? beforeLines,
          ),
        },
        asAuditClient(tx),
      );
    });

    return this.getDetail(id);
  }

  // ---------------------------------------------------------------------------
  // 확정 (설계서 18.2: 단일 트랜잭션 / API 정의서 14.1)
  // ---------------------------------------------------------------------------

  async confirm(id: string, dto: ConfirmContractDto, actor: AuthUser, headerKey?: string) {
    const idempotencyKey = headerKey ?? dto.idempotencyKey;
    const endpoint = `POST /contracts/${id}/confirm`;
    const replayed = await this.findIdempotentResponse(idempotencyKey, endpoint);
    if (replayed !== undefined) return replayed;

    const contract = await this.getContractOrThrow(id);
    if (contract.status !== 'DRAFT')
      throw new BusinessException('CONTRACT_NOT_DRAFT', '초안 상태의 계약만 확정할 수 있습니다.', undefined, {
        status: contract.status,
      });
    this.assertVersionMatch(contract.rowVersion, dto.version);

    return this.runWithIdempotency(idempotencyKey, async () =>
      this.prisma.$transaction(async (tx) => {
        const draft = await tx.contractVersion.findFirst({
          where: { contractId: id, versionStatus: 'DRAFT' },
          orderBy: { versionNo: 'desc' },
        });
        if (!draft) throw new BusinessException('CONTRACT_NOT_DRAFT', '확정할 초안 버전이 없습니다.');
        this.assertSigned(draft.signatureFileId);

        const confirmedAt = dto.confirmedDate ? new Date(dto.confirmedDate) : new Date();
        await tx.contractVersion.update({
          where: { id: draft.id },
          data: { versionStatus: 'CONFIRMED', confirmedBy: actor.id, confirmedAt },
        });
        await this.updateContractGuarded(tx, id, dto.version, {
          status: 'CONFIRMED',
          currentVersionId: draft.id,
          contractedAt: confirmedAt,
        });
        const customer = await tx.customer.update({
          where: { id: contract.customerId },
          data: {
            customerStatus: 'CONTRACTED',
            contractedAt: contract.customer?.contractedAt ?? confirmedAt,
            // 등록 절차를 거치지 않고 계약까지 온 경우를 보정한다 (계약 고객은 반드시 고객 목록에 있어야 한다)
            ...(contract.customer?.registeredAt ? {} : { registeredAt: confirmedAt }),
            rowVersion: { increment: 1 },
          },
        });

        const orders = await this.syncOrdersToVersion(tx, id, draft.id, {
          completionDueDate: draft.completionDueDate,
          photoDate: draft.photoDate,
          weddingDate: draft.weddingDate,
          cancelReason: null,
        });

        // AUTO 진행단계 훅 (설계서 02 §9.2 / 03 §6 / 07 §7.1).
        // (1) 주문별 진행을 보장하고 — 없으면 계약 확정 단계에서 시작시킨다.
        // (2) 그 밖에 남은 ACTIVE 진행을 계약 확정 단계로 전진시킨다.
        await this.ensureJourneysForOrders(tx, contract.customerId, orders, confirmedAt, actor.id);
        await this.advanceJourneysToContractConfirmed(tx, contract.customerId, confirmedAt, actor.id);

        const response = {
          contractId: id,
          contractNo: contract.contractNo,
          status: 'CONFIRMED',
          customerStatus: customer.customerStatus,
          orders,
        };
        await this.audit.log(
          {
            userId: actor.id,
            action: 'CONFIRM',
            entityType: 'CONTRACT',
            entityId: id,
            before: { status: contract.status },
            after: response,
          },
          asAuditClient(tx),
        );
        await this.saveIdempotencyKey(tx, idempotencyKey, endpoint, actor.id, response);
        return response;
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // 변경계약 (설계서 6.3, 데이터 규칙 15.2)
  // ---------------------------------------------------------------------------

  /** 현재 확정 버전을 복사한 신규 DRAFT 버전을 만든다. body로 라인·금액을 함께 수정할 수 있다. */
  async createRevision(id: string, dto: CreateRevisionDto, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    if (!['CONFIRMED', 'CHANGED'].includes(contract.status))
      throw new BusinessException('INVALID_STATUS_TRANSITION', '확정된 계약만 변경할 수 있습니다.', undefined, {
        status: contract.status,
      });
    const existingDraft = await this.prisma.contractVersion.findFirst({
      where: { contractId: id, versionStatus: 'DRAFT' },
    });
    if (existingDraft)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 작성 중인 변경계약 초안이 있습니다.', undefined, {
        revisionId: existingDraft.id,
      });
    const base = await this.prisma.contractVersion.findFirst({
      where: { contractId: id, versionStatus: 'CONFIRMED' },
      orderBy: { versionNo: 'desc' },
      include: VERSION_INCLUDE,
    });
    if (!base) throw new BusinessException('INVALID_STATUS_TRANSITION', '확정 버전이 없어 변경계약을 만들 수 없습니다.');

    const lines: ContractLineDto[] =
      dto.lines ??
      base.lines.map((l) => ({
        transactionType: l.transactionType,
        productCategory: l.productCategory,
        itemDescription: l.itemDescription ?? undefined,
        quantity: l.quantity,
        unitPrice: l.unitPrice === null ? undefined : Number(l.unitPrice),
        lineAmount: Number(l.lineAmount),
        notes: l.notes ?? undefined,
        sortOrder: l.sortOrder,
      }));

    const revision = await this.prisma.contractVersion.create({
      data: {
        id: randomUUID(),
        contractId: id,
        versionNo: base.versionNo + 1,
        versionStatus: 'DRAFT',
        changeReason: dto.changeReason ?? null,
        totalAmount: dto.totalAmount ?? base.totalAmount,
        completionDueDate: dto.completionDueDate !== undefined ? toDate(dto.completionDueDate) : base.completionDueDate,
        photoDate: dto.photoDate !== undefined ? toDate(dto.photoDate) : base.photoDate,
        weddingDate: dto.weddingDate !== undefined ? toDate(dto.weddingDate) : base.weddingDate,
        createdBy: actor.id,
        lines: { create: lines.map((l, i) => this.toLineData(l, i)) },
      },
      include: VERSION_INCLUDE,
    });

    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'CONTRACT_VERSION',
      entityId: revision.id,
      // 변경계약은 직전 확정본(base)과의 차이가 곧 "무엇이 바뀌었나"이므로 양쪽을 함께 남긴다.
      before: {
        contractId: id,
        versionNo: base.versionNo,
        totalAmount: base.totalAmount,
        lines: base.lines.map(lineSummary),
      },
      after: {
        contractId: id,
        versionNo: revision.versionNo,
        totalAmount: revision.totalAmount,
        lines: revision.lines.map(lineSummary),
      },
      reason: dto.changeReason,
    });
    return revision;
  }

  /**
   * 변경계약 확정: 수량 증가는 다음 sequence_no 신규 품목, 감소는 뒤 순번부터 CANCELLED(물리 삭제 금지),
   * 이전 확정 버전은 SUPERSEDED. 변경 사유 필수.
   */
  async confirmRevision(id: string, revisionId: string, dto: ConfirmRevisionDto, actor: AuthUser, headerKey?: string) {
    const idempotencyKey = headerKey ?? dto.idempotencyKey;
    const endpoint = `POST /contracts/${id}/revisions/${revisionId}/confirm`;
    const replayed = await this.findIdempotentResponse(idempotencyKey, endpoint);
    if (replayed !== undefined) return replayed;

    const contract = await this.getContractOrThrow(id);
    this.assertVersionMatch(contract.rowVersion, dto.version);

    const revision = await this.prisma.contractVersion.findUnique({ where: { id: revisionId } });
    if (!revision || revision.contractId !== id) throw new NotFoundException('변경계약 버전이 없습니다.');
    if (revision.versionStatus !== 'DRAFT')
      throw new BusinessException('CONTRACT_NOT_DRAFT', '초안 상태의 변경계약만 확정할 수 있습니다.', undefined, {
        versionStatus: revision.versionStatus,
      });
    // 재계약도 서명이 전제조건 (설계서 03 §2.5) — 재서명 강제.
    this.assertSigned(revision.signatureFileId);

    const changeReason = dto.changeReason ?? revision.changeReason;
    if (!changeReason)
      throw new BusinessException('VALIDATION_ERROR', '변경 사유는 필수입니다.', [
        { field: 'changeReason', reason: 'REQUIRED' },
      ]);

    return this.runWithIdempotency(idempotencyKey, async () =>
      this.prisma.$transaction(async (tx) => {
        const confirmedAt = new Date();

        // 확정 직전 revision 반영: 라인 교체·금액 갱신 (연동정합화 계약 §3)
        if (dto.lines) {
          await tx.contractLine.deleteMany({ where: { contractVersionId: revisionId } });
          await tx.contractLine.createMany({
            data: dto.lines.map((l, i) => ({ ...this.toLineData(l, i), contractVersionId: revisionId })),
          });
        }
        const amountData: Prisma.ContractVersionUncheckedUpdateInput = {};
        if (dto.totalAmount !== undefined) amountData.totalAmount = dto.totalAmount;

        await tx.contractVersion.update({
          where: { id: revisionId },
          data: { ...amountData, versionStatus: 'CONFIRMED', changeReason, confirmedBy: actor.id, confirmedAt },
        });
        // 이전 확정 버전 보존: SUPERSEDED (설계서 6.3)
        await tx.contractVersion.updateMany({
          where: { contractId: id, versionStatus: 'CONFIRMED', id: { not: revisionId } },
          data: { versionStatus: 'SUPERSEDED' },
        });
        await this.updateContractGuarded(tx, id, dto.version, {
          status: 'CHANGED',
          currentVersionId: revisionId,
        });

        const orders = await this.syncOrdersToVersion(tx, id, revisionId, {
          completionDueDate: revision.completionDueDate,
          photoDate: revision.photoDate,
          weddingDate: revision.weddingDate,
          cancelReason: changeReason,
        });

        const response = {
          contractId: id,
          contractNo: contract.contractNo,
          status: 'CHANGED',
          versionNo: revision.versionNo,
          changeReason,
          orders,
        };
        await this.audit.log(
          {
            userId: actor.id,
            action: 'REVISE',
            entityType: 'CONTRACT',
            entityId: id,
            before: { currentVersionId: contract.currentVersionId },
            after: response,
            reason: changeReason,
          },
          asAuditClient(tx),
        );
        await this.saveIdempotencyKey(tx, idempotencyKey, endpoint, actor.id, response);
        return response;
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // 취소·계약서 출력
  // ---------------------------------------------------------------------------

  /** 계약 취소: 사유 필수, 미진행(CREATED) 품목만 CANCELLED. 물리 삭제 금지. */
  async cancel(id: string, dto: CancelContractDto, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    if (contract.status === 'CANCELLED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 취소된 계약입니다.');
    this.assertVersionMatch(contract.rowVersion, dto.version);

    await this.prisma.$transaction(async (tx) => {
      const cancelledAt = new Date();
      await this.updateContractGuarded(tx, id, dto.version ?? contract.rowVersion, { status: 'CANCELLED' });
      const orders = await tx.order.findMany({ where: { contractId: id }, select: { id: true } });
      const orderIds = orders.map((o) => o.id);
      if (orderIds.length > 0) {
        await tx.order.updateMany({
          where: { id: { in: orderIds } },
          data: { status: 'CANCELLED', rowVersion: { increment: 1 } },
        });
        // 미진행 품목만 취소, 진행 중 품목은 업무 판단 대상으로 상태 유지
        const targets = await tx.orderItem.findMany({
          where: { orderId: { in: orderIds }, status: 'CREATED' },
          select: { id: true },
        });
        const targetIds = targets.map((t) => t.id);
        await tx.orderItem.updateMany({
          where: { id: { in: targetIds } },
          data: { status: 'CANCELLED', cancelledReason: dto.reason, cancelledAt, rowVersion: { increment: 1 } },
        });
        await tx.orderItemComponent.updateMany({
          where: { orderItemId: { in: targetIds }, status: 'CREATED' },
          data: { status: 'CANCELLED' },
        });
      }
      await this.audit.log(
        {
          userId: actor.id,
          action: 'CANCEL',
          entityType: 'CONTRACT',
          entityId: id,
          before: { status: contract.status },
          after: { status: 'CANCELLED' },
          reason: dto.reason,
        },
        asAuditClient(tx),
      );
    });
    return this.getDetail(id);
  }

  /**
   * 계약 삭제 — 임시저장(DRAFT)·취소(CANCELLED) 한정.
   *
   * 확정된 계약은 취소로만 정리한다(이력 보존). 취소된 계약이라도 작업지시서·렌탈 배정처럼
   * 실제 진행 산출물이 남아 있으면 지우지 않고 거부한다. 지울 수 있는 건 계약이 만든 것들
   * (버전·라인·주문·주문품목·구성품)뿐이고, 고객의 기록인 연락 이력·진행 단계는 링크만 끊고 남긴다.
   */
  async remove(id: string, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    if (contract.status !== 'DRAFT' && contract.status !== 'CANCELLED')
      throw new BusinessException(
        'CONTRACT_NOT_DELETABLE',
        '임시저장·취소 상태의 계약만 삭제할 수 있습니다. 확정된 계약은 [계약 취소]로 처리해 주세요.',
        undefined,
        { status: contract.status },
      );

    const orders = await this.prisma.order.findMany({
      where: { contractId: id },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    const items = orderIds.length
      ? await this.prisma.orderItem.findMany({
          where: { orderId: { in: orderIds } },
          select: { id: true },
        })
      : [];
    const itemIds = items.map((i) => i.id);

    const blockers = await this.findDeleteBlockers(itemIds);
    if (blockers.length > 0)
      throw new BusinessException(
        'CONTRACT_NOT_DELETABLE',
        `진행 이력이 있어 삭제할 수 없습니다 (${blockers.join(' · ')}). 계약 취소로 정리해 주세요.`,
        undefined,
        { blockers },
      );

    await this.prisma.$transaction(async (tx) => {
      if (itemIds.length > 0) {
        await tx.orderItemComponent.deleteMany({ where: { orderItemId: { in: itemIds } } });
        await tx.orderItem.deleteMany({ where: { id: { in: itemIds } } });
      }
      if (orderIds.length > 0) {
        // 연락 이력·고객 진행은 계약이 아니라 고객의 기록이다. 참조만 끊고 남긴다.
        await tx.notificationHistory.updateMany({
          where: { orderId: { in: orderIds } },
          data: { orderId: null },
        });
        await tx.customerJourney.updateMany({
          where: { orderId: { in: orderIds } },
          data: { orderId: null },
        });
        await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      }

      const versions = await tx.contractVersion.findMany({
        where: { contractId: id },
        select: { id: true },
      });
      // 계약 → 현재 버전 FK를 먼저 끊어야 버전을 지울 수 있다.
      await tx.contract.update({ where: { id }, data: { currentVersionId: null } });
      await tx.contractLine.deleteMany({
        where: { contractVersionId: { in: versions.map((v) => v.id) } },
      });
      await tx.contractVersion.deleteMany({ where: { contractId: id } });
      await tx.contract.delete({ where: { id } });

      await this.audit.log(
        {
          userId: actor.id,
          action: 'DELETE',
          entityType: 'CONTRACT',
          entityId: id,
          before: {
            contractNo: contract.contractNo,
            status: contract.status,
            customerId: contract.customerId,
            orderIds,
          },
        },
        asAuditClient(tx),
      );
    });

    return { id, contractNo: contract.contractNo, deleted: true };
  }

  /** 삭제를 막는 진행 산출물을 사람이 읽을 이름으로 모은다. 비어 있으면 삭제 가능. */
  private async findDeleteBlockers(orderItemIds: string[]): Promise<string[]> {
    if (orderItemIds.length === 0) return [];
    const where = { orderItemId: { in: orderItemIds } };
    const componentIds = (
      await this.prisma.orderItemComponent.findMany({ where, select: { id: true } })
    ).map((c) => c.id);

    const [workOrders, production, fittings, measurements, options, rentalSelections, repairs, allocations] =
      await Promise.all([
        this.prisma.workOrder.count({ where }),
        this.prisma.productionEvent.count({ where }),
        this.prisma.fittingSession.count({ where }),
        this.prisma.orderItemMeasurement.count({ where }),
        this.prisma.optionSelectionSession.count({ where }),
        this.prisma.rentalSelectionSession.count({ where }),
        this.prisma.repairRequest.count({ where }),
        componentIds.length
          ? this.prisma.rentalAllocation.count({
              where: { orderItemComponentId: { in: componentIds } },
            })
          : Promise.resolve(0),
      ]);

    return [
      [workOrders, '작업지시서'],
      [production, '제작 이력'],
      [fittings, '가봉'],
      [measurements, '채촌 연결'],
      [options, '옵션 선택'],
      [rentalSelections, '렌탈 스타일 선택'],
      [repairs, '수선'],
      [allocations, '렌탈 배정'],
    ]
      .filter(([count]) => (count as number) > 0)
      .map(([, label]) => label as string);
  }

  /**
   * 계약서 출력용 JSON (현재 적용 버전 기준).
   * 웹 표시 규칙(D7): 세부가격 노출 — 라인 세부품목·라인금액 + 옵션명·추가금액 + 서명 상태.
   * 품목은 주문품목(정장 #1·#2) × 부위(상의·하의·베스트) 계층으로 펼치고,
   * 부위 아래에는 **추가금액이 붙은 옵션만** 옵션명·금액으로 나열한다.
   */
  async getDocument(id: string) {
    const contract = await this.getDetail(id);
    const version =
      contract.currentVersion ?? contract.versions[contract.versions.length - 1] ?? null;
    const options = (await this.loadContractOptions(id)).filter((o) => o.extraPrice > 0);
    const itemTree = await this.loadContractOptionTree(id);
    return {
      contractNo: contract.contractNo,
      status: contract.status,
      contractedAt: contract.contractedAt,
      customer: contract.customer,
      contractType: contract.contractType,
      version: version
        ? {
            versionNo: version.versionNo,
            versionStatus: version.versionStatus,
            changeReason: version.changeReason,
            totalAmount: version.totalAmount,
            completionDueDate: version.completionDueDate,
            photoDate: version.photoDate,
            weddingDate: version.weddingDate,
          }
        : null,
      lines: (version?.lines ?? []).map((l) => ({
        transactionType: l.transactionType,
        productCategory: l.productCategory,
        categoryLabel: CATEGORY_LABEL[l.productCategory] ?? l.productCategory,
        itemDescription: l.itemDescription,
        // 주문 생성 전(계약 확정 전) 폴백용 세부품목 라벨
        components: componentLabels(l.productCategory),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineAmount: l.lineAmount,
        notes: l.notes,
        // 주문품목 × 부위 × 유료옵션 계층 (주문 생성 전에는 빈 배열)
        items: itemTree.get(`${l.transactionType}|${l.productCategory}`) ?? [],
      })),
      // 웹은 옵션명·추가금액을 노출한다 (D7). 추가금액 0원 옵션은 계약서에 싣지 않는다.
      options: options.map((o) => ({ optionName: o.optionName, extraPrice: o.extraPrice })),
      // 서명 상태 (엑셀 버튼·확정 버튼 게이팅용)
      signature: version
        ? {
            signed: version.signatureFileId != null,
            signerName: version.signerName,
            signedAt: version.signedAt,
            downloadUrl: version.signatureFileId ? `/api/v1/files/${version.signatureFileId}` : null,
          }
        : { signed: false, signerName: null, signedAt: null, downloadUrl: null },
      printedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // 전자서명 (설계서 03 §3)
  // ---------------------------------------------------------------------------

  /** 서명 저장·교체. DRAFT 버전 한정. 이미지는 files 모듈에 저장하고 버전에 연결한다. */
  async saveSignature(id: string, versionId: string, dto: SaveSignatureDto, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    const version = await this.prisma.contractVersion.findUnique({ where: { id: versionId } });
    if (!version || version.contractId !== id) throw new NotFoundException('계약 버전이 없습니다.');
    if (version.versionStatus !== 'DRAFT')
      throw new BusinessException('CONTRACT_NOT_DRAFT', '초안 상태의 버전만 서명할 수 있습니다.', undefined, {
        versionStatus: version.versionStatus,
      });
    this.assertVersionMatch(contract.rowVersion, dto.version);

    const buffer = decodeSignaturePng(dto.imageDataUrl);
    // 파일 저장은 별도 커밋이라도 무방하다(롤백 시 고아 PNG는 무해). 버전 연결·감사는 tx로 묶는다.
    const file = await this.files.saveBuffer(
      { buffer, mimeType: 'image/png', originalName: `signature-${versionId}.png` },
      actor,
    );

    const signedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.contractVersion.update({
        where: { id: versionId },
        data: { signatureFileId: file.id, signedAt, signerName: dto.signerName },
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'SIGN',
          entityType: 'CONTRACT_VERSION',
          entityId: versionId,
          after: { signerName: dto.signerName, signedAt },
        },
        asAuditClient(tx),
      );
    });

    return {
      versionId,
      signatureFileId: file.id,
      signerName: dto.signerName,
      signedAt,
      downloadUrl: file.downloadUrl,
    };
  }

  /** 서명 제거 (다시 받기용, DRAFT 한정). */
  async removeSignature(id: string, versionId: string, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    const version = await this.prisma.contractVersion.findUnique({ where: { id: versionId } });
    if (!version || version.contractId !== id) throw new NotFoundException('계약 버전이 없습니다.');
    if (version.versionStatus !== 'DRAFT')
      throw new BusinessException('CONTRACT_NOT_DRAFT', '초안 상태의 버전만 서명을 제거할 수 있습니다.', undefined, {
        versionStatus: version.versionStatus,
      });
    void contract;

    await this.prisma.contractVersion.update({
      where: { id: versionId },
      data: { signatureFileId: null, signedAt: null, signerName: null },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'DELETE',
      entityType: 'CONTRACT_VERSION',
      entityId: versionId,
      before: { signatureFileId: version.signatureFileId },
    });
    return { versionId, signed: false };
  }

  /** 서명 메타 조회. */
  async getSignature(id: string, versionId: string) {
    const version = await this.prisma.contractVersion.findUnique({ where: { id: versionId } });
    if (!version || version.contractId !== id) throw new NotFoundException('계약 버전이 없습니다.');
    return {
      versionId,
      signed: version.signatureFileId != null,
      signatureFileId: version.signatureFileId,
      signerName: version.signerName,
      signedAt: version.signedAt,
      downloadUrl: version.signatureFileId ? `/api/v1/files/${version.signatureFileId}` : null,
    };
  }

  // ---------------------------------------------------------------------------
  // 계약서 엑셀 (설계서 03 §5·§8) — 즉석 스트리밍
  // ---------------------------------------------------------------------------

  async buildContractDocumentExcel(id: string, actor: AuthUser): Promise<{ buffer: Buffer; fileName: string }> {
    const contract = await this.getDetail(id);
    const version =
      contract.currentVersion ?? contract.versions[contract.versions.length - 1] ?? null;
    if (!version) throw new NotFoundException('계약 버전이 없습니다.');

    const lines: ContractExcelLine[] = version.lines.map((l) => ({
      category: CATEGORY_LABEL[l.productCategory] ?? l.productCategory,
      components: componentLabels(l.productCategory),
      quantity: l.quantity,
    }));
    const options = await this.loadContractOptions(id);

    let signature: { pngBuffer: Buffer; signerName: string; signedAt: Date } | null = null;
    if (version.signatureFileId && version.signedAt) {
      const pngBuffer = await this.files.readBuffer(version.signatureFileId);
      signature = { pngBuffer, signerName: version.signerName ?? '', signedAt: version.signedAt };
    }

    const buffer = await buildContractExcel({
      contractNo: contract.contractNo,
      status: contract.status,
      contractedAt: contract.contractedAt,
      customer: { name: contract.customer?.name ?? '', phone: contract.customer?.phone ?? null },
      contractType: contract.contractType?.name ?? null,
      lines,
      options: options.map((o) => ({ optionName: o.optionName })),
      totalAmount: Number(version.totalAmount), // D7: 총액만
      completionDueDate: version.completionDueDate,
      photoDate: version.photoDate,
      weddingDate: version.weddingDate,
      signature,
      issuedAt: new Date(),
    });

    await this.audit.log({
      userId: actor.id,
      action: 'EXPORT',
      entityType: 'CONTRACT',
      entityId: id,
      after: { contractNo: contract.contractNo, format: 'xlsx' },
    });

    return { buffer, fileName: `contract-${contract.contractNo}.xlsx` };
  }

  // ---------------------------------------------------------------------------
  // 내부: 주문·품목 펼침
  // ---------------------------------------------------------------------------

  /**
   * 계약 버전 라인을 transaction_type별 주문과 개별 품목으로 동기화한다.
   * - 수량 증가: 다음 sequence_no로 신규 품목 + 기본 구성품 생성
   * - 수량 감소: 뒤 순번부터 CANCELLED (사유 기록, 물리 삭제 금지)
   */
  private async syncOrdersToVersion(
    tx: Prisma.TransactionClient,
    contractId: string,
    versionId: string,
    opts: {
      completionDueDate: Date | null;
      photoDate: Date | null;
      weddingDate: Date | null;
      cancelReason: string | null;
    },
  ): Promise<OrderSummary[]> {
    const lines = await tx.contractLine.findMany({ where: { contractVersionId: versionId } });

    // (거래방식|품목) 단위 목표 수량 집계
    const targets = new Map<string, { transactionType: string; productCategory: string; quantity: number; lineId: string }>();
    for (const line of lines) {
      const key = `${line.transactionType}|${line.productCategory}`;
      const existing = targets.get(key);
      if (existing) existing.quantity += line.quantity;
      else
        targets.set(key, {
          transactionType: line.transactionType,
          productCategory: line.productCategory,
          quantity: line.quantity,
          lineId: line.id,
        });
    }

    const existingOrders = await tx.order.findMany({
      where: { contractId },
      include: { items: true },
    });
    const ordersByType = new Map(existingOrders.map((o) => [o.transactionType, o]));

    // 필요한 거래방식 주문 생성 (계약당 CUSTOM·RENTAL 각 최대 1건)
    for (const type of ['CUSTOM', 'RENTAL']) {
      const needed = [...targets.values()].some((t) => t.transactionType === type && t.quantity > 0);
      if (!needed || ordersByType.has(type)) continue;
      const order = await tx.order.create({
        data: {
          id: randomUUID(),
          orderNo: await this.nextNo(tx, 'ORD'),
          contractId,
          transactionType: type,
          status: 'CREATED',
          completionDueDate: opts.completionDueDate,
          photoDate: opts.photoDate,
          weddingDate: opts.weddingDate,
        },
      });
      ordersByType.set(type, { ...order, items: [] });
    }

    // 기존 주문 일정 갱신
    for (const order of existingOrders) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          completionDueDate: opts.completionDueDate,
          photoDate: opts.photoDate,
          weddingDate: opts.weddingDate,
        },
      });
    }

    for (const [type, order] of ordersByType) {
      const categories = new Set<string>([
        ...order.items.map((i) => i.productCategory),
        ...[...targets.values()].filter((t) => t.transactionType === type).map((t) => t.productCategory),
      ]);
      for (const category of categories) {
        const target = targets.get(`${type}|${category}`);
        const targetQty = target?.quantity ?? 0;
        const itemsOfCategory = order.items.filter((i) => i.productCategory === category);
        const activeItems = itemsOfCategory
          .filter((i) => i.status !== 'CANCELLED')
          .sort((a, b) => a.sequenceNo - b.sequenceNo);
        const maxSeq = itemsOfCategory.reduce((m, i) => Math.max(m, i.sequenceNo), 0);

        if (targetQty > activeItems.length && target) {
          const label = type === 'RENTAL' ? `렌탈 ${CATEGORY_LABEL[category]}` : CATEGORY_LABEL[category];
          for (let n = 1; n <= targetQty - activeItems.length; n += 1) {
            const seq = maxSeq + n;
            await tx.orderItem.create({
              data: {
                id: randomUUID(),
                orderId: order.id,
                sourceContractLineId: target.lineId,
                productCategory: category,
                sequenceNo: seq,
                displayName: `${label} #${seq}`,
                status: 'CREATED',
                components: {
                  create: (COMPONENT_MAP[category] ?? [category]).map((componentType) => ({
                    id: randomUUID(),
                    componentType,
                    sequenceNo: 1,
                    status: 'CREATED',
                  })),
                },
              },
            });
          }
        } else if (targetQty < activeItems.length) {
          const toCancel = activeItems.slice(targetQty).reverse(); // 뒤 순번부터
          for (const item of toCancel) {
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                status: 'CANCELLED',
                cancelledReason: opts.cancelReason ?? '계약 변경',
                cancelledAt: new Date(),
                rowVersion: { increment: 1 },
              },
            });
            await tx.orderItemComponent.updateMany({
              where: { orderItemId: item.id, status: 'CREATED' },
              data: { status: 'CANCELLED' },
            });
          }
        }
      }
    }

    return [...ordersByType.values()]
      .sort((a, b) => a.transactionType.localeCompare(b.transactionType))
      .map((o) => ({ id: o.id, orderNo: o.orderNo, tradeType: o.transactionType }));
  }

  // ---------------------------------------------------------------------------
  // 내부: 번호 채번·낙관적 잠금·멱등성
  // ---------------------------------------------------------------------------

  /** CTR-YYMMDD-### / ORD-YYMMDD-### 일별 시퀀스 채번 (트랜잭션 내 호출) */
  private async nextNo(tx: Prisma.TransactionClient, kind: 'CTR' | 'ORD'): Promise<string> {
    const now = new Date();
    const stamp = [
      String(now.getFullYear() % 100).padStart(2, '0'),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('');
    const prefix = `${kind}-${stamp}-`;
    const last =
      kind === 'CTR'
        ? await tx.contract.findFirst({
            where: { contractNo: { startsWith: prefix } },
            orderBy: { contractNo: 'desc' },
            select: { contractNo: true },
          })
        : await tx.order.findFirst({
            where: { orderNo: { startsWith: prefix } },
            orderBy: { orderNo: 'desc' },
            select: { orderNo: true },
          });
    const lastNo = last ? ('contractNo' in last ? last.contractNo : last.orderNo) : null;
    const seq = lastNo ? Number(lastNo.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(seq).padStart(3, '0')}`;
  }

  /**
   * 초안 수정 감사로그의 전/후 스냅샷.
   * 초안 버전 행 전체를 넣으면 diff가 잡음으로 가득 차므로 실제 수정 대상 필드만 추린다.
   * 품목은 행 단위로 로그를 쪼개지 않고 `맞춤 예복 정장 1개 1,350,000원` 형태의 요약 배열 하나로 담는다.
   */
  private draftSnapshot(
    contract: { contractTypeId: string | null; rowVersion: number },
    version: {
      versionNo: number;
      totalAmount: unknown;
      completionDueDate: Date | null;
      photoDate: Date | null;
      weddingDate: Date | null;
      signedAt: Date | null;
      signerName: string | null;
    },
    lines: ContractLineSummarySource[],
  ) {
    return {
      contractTypeId: contract.contractTypeId,
      rowVersion: contract.rowVersion,
      versionNo: version.versionNo,
      totalAmount: version.totalAmount,
      completionDueDate: version.completionDueDate,
      photoDate: version.photoDate,
      weddingDate: version.weddingDate,
      signedAt: version.signedAt,
      signerName: version.signerName,
      lines: lines.map(lineSummary),
    };
  }

  private async getContractOrThrow(id: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id },
      include: { customer: true },
    });
    if (!contract) throw new NotFoundException('계약이 없습니다.');
    return contract;
  }

  /** 서명 없이 확정 시도를 차단한다 (설계서 03 §2.4 / D4). */
  private assertSigned(signatureFileId: string | null): void {
    if (!signatureFileId)
      throw new BusinessException(
        'CONTRACT_SIGNATURE_REQUIRED',
        '서명이 완료되어야 계약을 확정할 수 있습니다.',
        [{ field: 'signature', reason: 'REQUIRED' }],
      );
  }

  /** 계약의 현재 옵션 선택값(옵션명·추가금액)을 모은다. (웹·엑셀 공통 소스, 설계서 03 §7.1) */
  private async loadContractOptions(
    contractId: string,
  ): Promise<Array<{ optionName: string; extraPrice: number }>> {
    const values = await this.prisma.optionSelectionValue.findMany({
      where: {
        selectionSession: { isCurrent: true, orderItem: { order: { contractId } } },
      },
      include: { optionChoice: { select: { choiceName: true } } },
      orderBy: { selectedAt: 'asc' },
    });
    return values.map((v) => ({
      optionName: v.optionChoice.choiceName,
      extraPrice: Number(v.extraPriceSnapshot),
    }));
  }

  /**
   * 계약서 웹 표시용 품목 계층 — `거래방식|품목` → 주문품목(정장 #1·#2) → 부위 → 유료 옵션.
   *
   * - 부위 축: 맞춤은 옵션 부위 그룹(상의·하의·베스트), 렌탈은 주문품목 구성품을 쓴다.
   *   (스타일 컨설팅 화면과 같은 축이라 두 화면의 부위 목록이 어긋나지 않는다.)
   * - 옵션은 현재 선택 세션의 값 중 **추가금액 > 0** 인 것만 담는다 (v2 계약관리 요구).
   * - 부위 행은 유료 옵션이 없어도 항상 남긴다 (구성품 자체가 계약서 정보).
   */
  private async loadContractOptionTree(contractId: string) {
    const items = await this.prisma.orderItem.findMany({
      where: { order: { contractId }, status: { not: 'CANCELLED' } },
      include: {
        order: { select: { transactionType: true, orderNo: true } },
        components: {
          where: { active: true },
          orderBy: [{ componentType: 'asc' }, { sequenceNo: 'asc' }],
          select: { componentType: true },
        },
      },
      orderBy: [{ productCategory: 'asc' }, { sequenceNo: 'asc' }],
    });

    const tree = new Map<string, ContractDocumentItem[]>();
    if (items.length === 0) return tree;

    const values = await this.prisma.optionSelectionValue.findMany({
      where: {
        selectionSession: { isCurrent: true, orderItem: { order: { contractId } } },
        extraPriceSnapshot: { gt: 0 },
      },
      include: {
        optionChoice: { select: { choiceName: true } },
        optionStage: { select: { componentGroup: true, stageName: true, sequenceNo: true } },
        selectionSession: { select: { orderItemId: true } },
      },
      orderBy: [{ optionStage: { sequenceNo: 'asc' } }],
    });
    const valuesByItem = new Map<string, typeof values>();
    for (const v of values) {
      const list = valuesByItem.get(v.selectionSession.orderItemId) ?? [];
      list.push(v);
      valuesByItem.set(v.selectionSession.orderItemId, list);
    }

    for (const item of items) {
      const groupCodes =
        item.order.transactionType === 'RENTAL'
          ? item.components.map((c) => c.componentType)
          : componentGroupsFor(item.productCategory);
      const components = (groupCodes.length > 0 ? groupCodes : [item.productCategory]).map(
        (group) => ({
          group,
          groupLabel: COMPONENT_GROUP_LABELS[group] ?? COMPONENT_LABEL[group] ?? group,
          options: [] as Array<{ stageName: string; optionName: string; extraPrice: number }>,
        }),
      );

      for (const v of valuesByItem.get(item.id) ?? []) {
        const matched = components.find((c) => c.group === v.optionStage.componentGroup);
        // 부위 미지정 단계(단일 부위 세트·구버전)는 부위가 하나면 그 부위, 아니면 '공통'으로 모은다.
        let target = matched ?? (components.length === 1 ? components[0] : undefined);
        if (!target) {
          target = components.find((c) => c.group === 'COMMON');
          if (!target) {
            target = { group: 'COMMON', groupLabel: '공통', options: [] };
            components.push(target);
          }
        }
        target.options.push({
          stageName: v.optionStage.stageName,
          optionName: v.optionChoice.choiceName,
          extraPrice: Number(v.extraPriceSnapshot),
        });
      }

      const key = `${item.order.transactionType}|${item.productCategory}`;
      const list = tree.get(key) ?? [];
      list.push({
        orderItemId: item.id,
        orderNo: item.order.orderNo,
        displayName: item.displayName,
        sequenceNo: item.sequenceNo,
        components,
        optionTotal: components.reduce(
          (s, c) => s + c.options.reduce((t, o) => t + o.extraPrice, 0),
          0,
        ),
      });
      tree.set(key, list);
    }
    return tree;
  }

  /**
   * 계약 확정 시 주문별 진행(journey)을 보장한다 (설계서 07 §7.1).
   *
   * 전에는 진행이 수동 생성뿐이라, 계약을 확정해도 진행 화면과 고객 목록의 진행상태 열이
   * 비어 있었다. 계약 확정이 곧 진행의 시작점(plan_v2 "상담 - 계약 - 스타일 컨설팅")이므로
   * 주문 1건당 진행 1건을 여기서 만든다.
   *
   * 상담 단계에서 수동 생성해 둔 진행(orderId 미연결)이 있으면 새로 만들지 않고 그 진행에
   * 주문을 연결한다 — 그러지 않으면 같은 고객에게 진행이 둘 생긴다.
   */
  private async ensureJourneysForOrders(
    tx: Prisma.TransactionClient,
    customerId: string,
    orders: { id: string; tradeType: string }[],
    confirmedAt: Date,
    actorId: string,
  ): Promise<void> {
    for (const order of orders) {
      // 주문 1건당 진행 1건 (journeys.service.create와 같은 규칙). 취소된 진행은 되살리지 않는다.
      const linked = await tx.customerJourney.findFirst({
        where: { orderId: order.id, status: { not: 'CANCELLED' } },
        select: { id: true },
      });
      if (linked) continue;

      const stages = await tx.journeyStage.findMany({
        where: { trackType: order.tradeType, active: true },
        orderBy: { sequenceNo: 'asc' },
      });
      const target = stages.find((s) => s.code === 'CONTRACT_CONFIRMED');
      // 트랙에 단계 정의가 없으면(시드 미적용) 계약 확정 자체를 막지 않고 넘어간다.
      if (!target) continue;

      // 상담 단계에서 만들어 둔 미연결 진행을 우선 흡수한다.
      const orphan = await tx.customerJourney.findFirst({
        where: {
          customerId,
          orderId: null,
          sourceRepairRequestId: null,
          trackType: order.tradeType,
          status: 'ACTIVE',
        },
        orderBy: { startedAt: 'desc' },
      });

      const journeyId = orphan?.id ?? randomUUID();
      const fromStageCode = orphan?.currentStageCode ?? null;
      if (orphan) {
        await tx.customerJourney.update({
          where: { id: orphan.id },
          data: { orderId: order.id, currentStageCode: target.code, rowVersion: { increment: 1 } },
        });
      } else {
        await tx.customerJourney.create({
          data: {
            id: journeyId,
            customerId,
            orderId: order.id,
            trackType: order.tradeType,
            currentStageCode: target.code,
            status: 'ACTIVE',
            startedAt: confirmedAt,
          },
        });
      }

      await tx.journeyEvent.create({
        data: {
          id: randomUUID(),
          journeyId,
          stageId: target.id,
          fromStageCode,
          toStageCode: target.code,
          notificationOutcome: 'NONE',
          actorId,
          changedAt: confirmedAt,
        },
      });
      await this.audit.log(
        {
          userId: actorId,
          action: orphan ? 'UPDATE' : 'CREATE',
          entityType: 'CUSTOMER_JOURNEY',
          entityId: journeyId,
          after: { trackType: order.tradeType, currentStageCode: target.code, orderId: order.id },
          reason: '계약 확정 시 진행 자동 시작',
        },
        asAuditClient(tx),
      );
    }
  }

  /**
   * 계약완료 시 고객 진행을 CONTRACT_CONFIRMED로 전진한다 (설계서 03 §6, 최소 연동).
   * ACTIVE 진행 중 CONTRACT_CONFIRMED보다 앞선 단계에 있는 건만 전진한다. 진행이 없으면 skip.
   */
  private async advanceJourneysToContractConfirmed(
    tx: Prisma.TransactionClient,
    customerId: string,
    changedAt: Date,
    actorId: string,
  ): Promise<void> {
    const journeys = await tx.customerJourney.findMany({
      where: { customerId, status: 'ACTIVE' },
    });
    if (journeys.length === 0) return;

    for (const journey of journeys) {
      const stages = await tx.journeyStage.findMany({
        where: { trackType: journey.trackType, active: true },
        orderBy: { sequenceNo: 'asc' },
      });
      const target = stages.find((s) => s.code === 'CONTRACT_CONFIRMED');
      if (!target) continue;
      const currentSeq = stages.find((s) => s.code === journey.currentStageCode)?.sequenceNo ?? -1;
      // 이미 계약확정 이상이면 전진하지 않는다(후진 금지).
      if (currentSeq >= target.sequenceNo) continue;

      await tx.journeyEvent.create({
        data: {
          id: randomUUID(),
          journeyId: journey.id,
          stageId: target.id,
          fromStageCode: journey.currentStageCode,
          toStageCode: target.code,
          notificationOutcome: 'NONE',
          actorId,
          changedAt,
        },
      });
      await tx.customerJourney.update({
        where: { id: journey.id },
        data: { currentStageCode: target.code, rowVersion: { increment: 1 } },
      });
    }
  }

  private assertVersionMatch(current: number, expected?: number): void {
    if (expected !== undefined && expected !== current)
      throw new BusinessException(
        'CONTRACT_VERSION_CONFLICT',
        '다른 사용자가 계약을 변경했습니다. 최신 데이터를 다시 조회해 주세요.',
        [{ field: 'version', reason: 'STALE_VALUE' }],
        { expectedVersion: current },
      );
  }

  /** row_version 조건부 갱신. 트랜잭션 중 경합 시에도 충돌을 감지한다. */
  private async updateContractGuarded(
    tx: Prisma.TransactionClient,
    id: string,
    expectedVersion: number,
    data: Prisma.ContractUncheckedUpdateManyInput,
  ): Promise<void> {
    const result = await tx.contract.updateMany({
      where: { id, rowVersion: expectedVersion },
      data: { ...data, rowVersion: { increment: 1 } },
    });
    if (result.count === 0)
      throw new BusinessException('CONTRACT_VERSION_CONFLICT', '다른 사용자가 계약을 변경했습니다.', [
        { field: 'version', reason: 'STALE_VALUE' },
      ]);
  }

  /** 동일 Idempotency-Key 재요청이면 저장된 최초 성공 응답을 반환한다. */
  private async findIdempotentResponse(key: string | undefined, endpoint: string): Promise<unknown> {
    if (!key) return undefined;
    const existing = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (!existing) return undefined;
    if (existing.endpoint !== endpoint)
      throw new BusinessException('VALIDATION_ERROR', '다른 요청에 사용된 Idempotency-Key입니다.', [
        { field: 'idempotencyKey', reason: 'REUSED_FOR_DIFFERENT_ENDPOINT' },
      ]);
    return existing.responseJson;
  }

  private async saveIdempotencyKey(
    tx: Prisma.TransactionClient,
    key: string | undefined,
    endpoint: string,
    userId: string,
    response: unknown,
  ): Promise<void> {
    if (!key) return;
    await tx.idempotencyKey.create({
      data: { id: randomUUID(), key, userId, endpoint, responseJson: response as Prisma.InputJsonValue },
    });
  }

  /** 동시 요청이 같은 키로 경합하면(유니크 충돌) 저장된 응답을 재조회해 반환한다. */
  private async runWithIdempotency<T>(key: string | undefined, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (key && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const stored = await this.prisma.idempotencyKey.findUnique({ where: { key } });
        if (stored) return stored.responseJson as T;
      }
      throw e;
    }
  }

  private toLineData(line: ContractLineDto, index: number) {
    return {
      id: randomUUID(),
      transactionType: line.transactionType,
      productCategory: line.productCategory,
      itemDescription: line.itemDescription ?? null,
      quantity: line.quantity,
      unitPrice: line.unitPrice ?? null,
      lineAmount: line.lineAmount ?? 0,
      notes: line.notes ?? null,
      sortOrder: line.sortOrder ?? index + 1,
    };
  }
}

function toDate(value?: string | null): Date | null {
  return value ? new Date(value) : null;
}

/** 감사로그 품목 요약의 입력 — 저장된 행(Decimal)과 요청 DTO(number)를 모두 받는다. */
interface ContractLineSummarySource {
  productCategory: string;
  itemDescription?: string | null;
  quantity: number;
  lineAmount?: unknown;
}

/**
 * 계약 품목 1행을 감사로그용 한 줄로 압축한다.
 * 품목별 감사 이벤트를 따로 만들지 않고, 이 문자열 배열의 전/후 차이로 "무엇이 어떻게 바뀌었는지"를 읽게 한다.
 */
function lineSummary(line: ContractLineSummarySource): string {
  const name = line.itemDescription?.trim() || CATEGORY_LABEL[line.productCategory] || line.productCategory;
  const amount = Number(line.lineAmount ?? 0);
  return `${name} ${line.quantity}개 ${amount.toLocaleString('ko-KR')}원`;
}

/** 대분류의 기본 구성품을 한글 세부품목 라벨로 (설계서 03 §5.3). */
function componentLabels(productCategory: string): string[] {
  const components = COMPONENT_MAP[productCategory] ?? [productCategory];
  return components.map((c) => COMPONENT_LABEL[c] ?? c);
}

/** PNG dataURL → Buffer. PNG 형식·용량(2MB) 검증 (설계서 03 §2.3). */
function decodeSignaturePng(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
  if (!match)
    throw new BusinessException('VALIDATION_ERROR', '서명 이미지는 PNG dataURL이어야 합니다.', [
      { field: 'imageDataUrl', reason: 'INVALID_FORMAT' },
    ]);
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length === 0)
    throw new BusinessException('VALIDATION_ERROR', '서명 이미지가 비어 있습니다.', [
      { field: 'imageDataUrl', reason: 'EMPTY' },
    ]);
  if (buffer.length > SIGNATURE_MAX_BYTES)
    throw new BusinessException('VALIDATION_ERROR', '서명 이미지 용량이 너무 큽니다.', [
      { field: 'imageDataUrl', reason: 'TOO_LARGE' },
    ]);
  // PNG 시그니처(매직바이트) 확인
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  if (!buffer.subarray(0, 4).equals(PNG_MAGIC))
    throw new BusinessException('VALIDATION_ERROR', '서명 이미지가 올바른 PNG가 아닙니다.', [
      { field: 'imageDataUrl', reason: 'NOT_PNG' },
    ]);
  return buffer;
}

/** AuditService.log의 tx 파라미터 타입에 맞춘 캐스팅 (delegate 구조는 동일) */
function asAuditClient(tx: Prisma.TransactionClient): Pick<PrismaService, 'auditLog'> {
  return tx as unknown as Pick<PrismaService, 'auditLog'>;
}
