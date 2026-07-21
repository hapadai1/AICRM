import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  CancelContractDto,
  ConfirmContractDto,
  ConfirmRevisionDto,
  CONTRACT_SORT_FIELDS,
  ContractLineDto,
  ContractListQueryDto,
  CreateContractDto,
  CreateRevisionDto,
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

const VERSION_INCLUDE = {
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ContractVersionInclude;

const DETAIL_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true, email: true, customerStatus: true } },
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
      depositAmount: true,
      balanceAmount: true,
      completionDueDate: true,
    },
  },
} satisfies Prisma.ContractInclude;

/** 정렬·집계에 쓰는 목록 행의 최소 형태 */
interface ContractListRow {
  contractedAt: Date | null;
  createdAt: Date;
  currentVersion: { totalAmount: Prisma.Decimal; completionDueDate: Date | null } | null;
  paidAmount: number;
  unpaidAmount: number;
}

type OrderSummary = { id: string; orderNo: string; tradeType: string };

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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
          depositAmount: dto.depositAmount ?? 0,
          balanceAmount: dto.balanceAmount ?? 0,
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
      after: { contractNo: contract.contractNo, customerId: contract.customerId },
    });
    return contract;
  }

  /**
   * 계약 목록 (개편계획 06).
   * 실수납액·미수금은 Prisma where로 표현할 수 없는 집계라 필터에 맞는 계약을 모두 읽고
   * 결제 집계를 병합한 뒤 메모리에서 정렬·페이징한다. (온프레미스 단일 매장 규모 전제)
   */
  async list(query: ContractListQueryDto) {
    const where = this.buildListWhere(query);
    const rows = await this.prisma.contract.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    const paymentByContract = await this.aggregatePayments(rows.map((r) => r.id));
    const enriched = rows
      .map((row) => {
        const totalAmount = Number(row.currentVersion?.totalAmount ?? 0);
        const agg = paymentByContract.get(row.id);
        const paidAmount = agg?.paidAmount ?? 0;
        return {
          ...row,
          paidAmount,
          unpaidAmount: totalAmount - paidAmount,
          lastPaymentDate: agg?.lastPaymentDate ?? null,
        };
      })
      .filter((row) => !query.unpaidOnly || row.unpaidAmount > 0);

    const sorted = this.sortList(enriched, query.sort);
    const page = sorted.slice(query.skip, query.skip + query.size);

    // 요약은 페이지가 아니라 필터 전체 기준이다.
    const totals = sorted.reduce(
      (acc, row) => {
        acc.count += 1;
        acc.totalAmount += Number(row.currentVersion?.totalAmount ?? 0);
        acc.paidAmount += row.paidAmount;
        acc.unpaidAmount += row.unpaidAmount;
        return acc;
      },
      { count: 0, totalAmount: 0, paidAmount: 0, unpaidAmount: 0 },
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
      ...(range ? this.buildDateFilter(query.dateField ?? 'contractedAt', range) : {}),
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
    if (dateField === 'paymentDate') {
      // 해당 기간에 완료된 결제가 1건이라도 있는 계약
      return { payments: { some: { status: 'COMPLETED', paymentDate: range } } };
    }
    if (dateField === 'completionDueDate') {
      return { currentVersion: { completionDueDate: range } };
    }
    return { contractedAt: range };
  }

  /** 계약별 실수납액(환불 차감)과 최근 결제일. 취소된 결제는 제외한다. */
  private async aggregatePayments(
    contractIds: string[],
  ): Promise<Map<string, { paidAmount: number; lastPaymentDate: string | null }>> {
    const result = new Map<string, { paidAmount: number; lastPaymentDate: string | null }>();
    if (contractIds.length === 0) return result;

    const grouped = await this.prisma.payment.groupBy({
      by: ['contractId', 'paymentType'],
      where: { contractId: { in: contractIds }, status: 'COMPLETED' },
      _sum: { amount: true },
      _max: { paymentDate: true },
    });

    for (const g of grouped) {
      const current = result.get(g.contractId) ?? { paidAmount: 0, lastPaymentDate: null };
      const amount = Number(g._sum.amount ?? 0);
      current.paidAmount += g.paymentType === 'REFUND' ? -amount : amount;
      const last = g._max.paymentDate ? g._max.paymentDate.toISOString().slice(0, 10) : null;
      if (last && (!current.lastPaymentDate || last > current.lastPaymentDate)) {
        current.lastPaymentDate = last;
      }
      result.set(g.contractId, current);
    }
    return result;
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
        case 'paidAmount':
          return row.paidAmount;
        case 'unpaidAmount':
          return row.unpaidAmount;
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

    await this.prisma.$transaction(async (tx) => {
      if (dto.lines) {
        await tx.contractLine.deleteMany({ where: { contractVersionId: draft.id } });
        await tx.contractLine.createMany({
          data: dto.lines.map((l, i) => ({ ...this.toLineData(l, i), contractVersionId: draft.id })),
        });
      }
      await tx.contractVersion.update({
        where: { id: draft.id },
        data: {
          ...(dto.totalAmount !== undefined ? { totalAmount: dto.totalAmount } : {}),
          ...(dto.depositAmount !== undefined ? { depositAmount: dto.depositAmount } : {}),
          ...(dto.balanceAmount !== undefined ? { balanceAmount: dto.balanceAmount } : {}),
          ...(dto.completionDueDate !== undefined ? { completionDueDate: toDate(dto.completionDueDate) } : {}),
          ...(dto.photoDate !== undefined ? { photoDate: toDate(dto.photoDate) } : {}),
          ...(dto.weddingDate !== undefined ? { weddingDate: toDate(dto.weddingDate) } : {}),
        },
      });
      await tx.contract.update({
        where: { id },
        data: {
          ...(dto.contractTypeId !== undefined ? { contractTypeId: dto.contractTypeId } : {}),
          rowVersion: { increment: 1 },
        },
      });
    });

    await this.audit.log({ userId: actor.id, action: 'UPDATE', entityType: 'CONTRACT', entityId: id });
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
            rowVersion: { increment: 1 },
          },
        });

        const orders = await this.syncOrdersToVersion(tx, id, draft.id, {
          completionDueDate: draft.completionDueDate,
          photoDate: draft.photoDate,
          weddingDate: draft.weddingDate,
          cancelReason: null,
        });

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
        depositAmount: dto.depositAmount ?? base.depositAmount,
        balanceAmount: dto.balanceAmount ?? base.balanceAmount,
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
      after: { contractId: id, versionNo: revision.versionNo },
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
        if (dto.depositAmount !== undefined) amountData.depositAmount = dto.depositAmount;
        if (dto.totalAmount !== undefined || dto.depositAmount !== undefined) {
          const total = dto.totalAmount ?? Number(revision.totalAmount);
          const deposit = dto.depositAmount ?? Number(revision.depositAmount);
          amountData.balanceAmount = total - deposit;
        }

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

  /** 계약서 출력용 JSON 요약 (현재 적용 버전 기준). */
  async getDocument(id: string) {
    const contract = await this.getDetail(id);
    const version =
      contract.currentVersion ?? contract.versions[contract.versions.length - 1] ?? null;
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
            depositAmount: version.depositAmount,
            balanceAmount: version.balanceAmount,
            completionDueDate: version.completionDueDate,
            photoDate: version.photoDate,
            weddingDate: version.weddingDate,
          }
        : null,
      lines: (version?.lines ?? []).map((l) => ({
        transactionType: l.transactionType,
        productCategory: l.productCategory,
        itemDescription: l.itemDescription,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineAmount: l.lineAmount,
        notes: l.notes,
      })),
      printedAt: new Date().toISOString(),
    };
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

  private async getContractOrThrow(id: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id },
      include: { customer: true },
    });
    if (!contract) throw new NotFoundException('계약이 없습니다.');
    return contract;
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

/** AuditService.log의 tx 파라미터 타입에 맞춘 캐스팅 (delegate 구조는 동일) */
function asAuditClient(tx: Prisma.TransactionClient): Pick<PrismaService, 'auditLog'> {
  return tx as unknown as Pick<PrismaService, 'auditLog'>;
}
