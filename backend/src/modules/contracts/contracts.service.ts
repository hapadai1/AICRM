import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { toDateOrNull as toDate } from '../../common/date';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ContractDocumentService } from './contract-document.service';
import { ContractItemsService } from './contract-items.service';
import { ContractVersionsService } from './contract-versions.service';
import {
  CancelContractDto,
  CompleteContractDto,
  CONTRACT_SORT_FIELDS,
  ContractLineDto,
  ContractListQueryDto,
  CreateContractDto,
  CreateRevisionDto,
  SaveSignatureDto,
  UpdateContractDto,
} from './contracts.dto';
import {
  asAuditClient,
  assertVersionMatch,
  ContractLineSummarySource,
  DETAIL_INCLUDE,
  getContractOrThrow,
  lineSummary,
  nextNo,
  toLineData,
  updateContractGuarded,
  VERSION_INCLUDE,
} from './contracts.shared';

/**
 * 계약 서비스 — 초안 CRUD·목록·취소·삭제·흐름 게이팅 (2026-08-05 해체).
 *
 * 한 파일이 2,400줄로 계약의 모든 축을 안고 있던 것을 책임 단위로 갈랐다:
 * - 계약완료 물리화(주문·진행·채촌·준비)   → ContractMaterializeService
 * - 품목·컨설팅 동기화(라인↔벌·베스트·롤업) → ContractItemsService
 * - 계약서 문서(상세·웹 계약서·엑셀)        → ContractDocumentService
 * - 버전·서명·완료                          → ContractVersionsService
 * 컨트롤러·다른 모듈의 진입점은 그대로 두기 위해 여기서 위임한다(公開 표면 유지).
 */

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
      // 목록의 "품목 구성" 열용 — 거래구분·품목별 수량만 있으면 되므로 라인 전체는 싣지 않는다.
      lines: { select: { transactionType: true, productCategory: true, quantity: true } },
    },
  },
} satisfies Prisma.ContractInclude;

/** 정렬·집계에 쓰는 목록 행의 최소 형태 */
interface ContractListRow {
  contractedAt: Date | null;
  createdAt: Date;
  currentVersion: { totalAmount: Prisma.Decimal; completionDueDate: Date | null } | null;
}

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly items: ContractItemsService,
    private readonly document: ContractDocumentService,
    private readonly versions: ContractVersionsService,
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
          contractNo: await nextNo(tx, 'CTR'),
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
          lines: { create: lines.map((l, i) => toLineData(l, i)) },
        },
      });
      // 작성중 저장 즉시 컨설팅 대상 품목을 만든다 (계약-컨설팅-서명-완료-주문 흐름).
      await this.items.syncContractItems(tx, contractId, versionId, null);
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
    const contract = await this.document.getDetail(id);
    // 선택 옵션 추가금이 계약금액에 반영됐는지 배지로 보여주기 위한 계약 단위 요약.
    (contract as typeof contract & {
      optionSurcharge?: { total: number; applied: number; pending: number };
    }).optionSurcharge = await this.items.contractSurchargeSummary(contract.id);
    return contract;
  }

  async getVersions(id: string) {
    await getContractOrThrow(this.prisma, id);
    return this.prisma.contractVersion.findMany({
      where: { contractId: id },
      include: VERSION_INCLUDE,
      orderBy: { versionNo: 'asc' },
    });
  }

  /** 초안 수정. DRAFT 상태가 아니면 CONTRACT_NOT_DRAFT — 확정본은 계약 변경으로만 수정한다. */
  async update(id: string, dto: UpdateContractDto, actor: AuthUser) {
    const contract = await getContractOrThrow(this.prisma, id);
    if (contract.status !== 'DRAFT')
      throw new BusinessException('CONTRACT_NOT_DRAFT', '확정된 계약은 계약 변경 기능으로만 수정할 수 있습니다.', undefined, {
        status: contract.status,
      });
    assertVersionMatch(contract.rowVersion, dto.version);

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
          data: dto.lines.map((l, i) => ({ ...toLineData(l, i), contractVersionId: draft.id })),
        });
        // 라인이 바뀌면 컨설팅 대상 품목도 수량에 맞춰 정합한다 (기존 선택은 보존).
        // 수정하기로 만든 버전이면 그 사유를 품목 취소 사유로 남긴다.
        await this.items.syncContractItems(tx, id, draft.id, draft.changeReason);
        // 라인을 통째로 다시 만들었으니, 컨설팅 옵션 추가금액 롤업 라인도 다시 붙인다.
        await this.items.syncOptionRollupLine(tx, id, draft.id);
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
  // 취소·삭제
  // ---------------------------------------------------------------------------

  /**
   * 계약 취소: 사유 필수, 물리 삭제 금지. 취소는 종결 상태다(수정하기 없음).
   * **작성중·서명완료 + 주문 없음일 때만 취소한다**(현업 확정 2026-07-31).
   * 주문이 생긴 계약(완료 후 수정하기로 되돌린 경우 포함)은 취소하지 않는다 —
   * 실물 정리는 렌탈 메뉴·오프라인에서 한다.
   *
   * 진행(journey)은 여기서 건드리지 않는다 (현업 확정 2026-08-05).
   * 계약 전 진행은 계약과 직접 연결돼 있지 않아 "이 계약의 진행"을 기계가 확정할 수 없고,
   * 진행은 사람이 관리하는 표시 레이어다(스키마 §12) — 정리는 진행 보드에서 담당자가 닫는다.
   */
  async cancel(id: string, dto: CancelContractDto, actor: AuthUser) {
    const contract = await getContractOrThrow(this.prisma, id);
    if (contract.status !== 'DRAFT' && contract.status !== 'SIGNED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        contract.status === 'CANCELLED'
          ? '이미 취소된 계약입니다.'
          : '작성중·서명완료 계약만 취소할 수 있습니다.',
        undefined,
        { status: contract.status },
      );
    const orderCount = await this.prisma.order.count({ where: { contractId: id } });
    if (orderCount > 0)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '주문이 생성된 계약은 취소할 수 없습니다. 품목 정리는 제작·입출고와 렌탈 화면에서 진행해 주세요.',
        undefined,
        { orderCount },
      );
    assertVersionMatch(contract.rowVersion, dto.version);

    await this.prisma.$transaction(async (tx) => {
      const cancelledAt = new Date();
      await updateContractGuarded(tx, id, dto.version ?? contract.rowVersion, { status: 'CANCELLED' });

      // 계약 품목(컨설팅 앵커)을 먼저 취소한다 — 물리화 전이면 이게 유일한 품목이다.
      const liveItems = await tx.contractItem.findMany({
        where: { contractId: id, status: { not: 'CANCELLED' } },
        select: { id: true },
      });
      const liveItemIds = liveItems.map((i) => i.id);
      if (liveItemIds.length > 0) {
        await tx.contractItem.updateMany({
          where: { id: { in: liveItemIds } },
          data: { status: 'CANCELLED', cancelledReason: dto.reason, cancelledAt, rowVersion: { increment: 1 } },
        });
        await tx.contractItemComponent.updateMany({
          where: { contractItemId: { in: liveItemIds }, status: 'CREATED' },
          data: { status: 'CANCELLED' },
        });
      }

      // 주문은 여기서 다루지 않는다 — 위 가드가 주문 있는 계약의 취소를 이미 막았다.
      // (예전에 주문·품목을 함께 취소하는 블록이 있었지만 가드 때문에 절대 실행되지 않았고,
      //  폐기된 `status === 'CREATED'` 기준까지 담고 있어 걷어냈다. 2026-08-05)
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
   * 확정된 계약은 취소로만 정리한다(이력 보존). 지울 수 있는 건 계약이 만든 것들
   * (버전·라인·컨설팅 산출물)뿐이다. 주문이 생긴 계약은 아래 가드가 삭제를 막으므로
   * 주문·작업지시서·제작 이력은 여기서 만날 일이 없다 — 취소도 주문 전에만 되니(0731)
   * 삭제 가능한 계약에는 주문이 존재할 수 없다.
   */
  async remove(id: string, actor: AuthUser) {
    const contract = await getContractOrThrow(this.prisma, id);
    if (contract.status !== 'DRAFT' && contract.status !== 'CANCELLED')
      throw new BusinessException(
        'CONTRACT_NOT_DELETABLE',
        '임시저장·취소 상태의 계약만 삭제할 수 있습니다. 확정된 계약은 [계약 취소]로 처리해 주세요.',
        undefined,
        { status: contract.status },
      );

    // 작성중이라도 주문이 생긴 계약(완료 후 수정하기로 되돌린 경우)은 삭제 금지 —
    // 작성중이 "계약 전 초안"과 "완료 후 재작성"을 겸하므로 주문 존재로 가른다 (현업 확정 2026-07-31).
    const orderCount = await this.prisma.order.count({ where: { contractId: id } });
    if (orderCount > 0)
      throw new BusinessException(
        'CONTRACT_NOT_DELETABLE',
        '주문이 생성된 계약은 삭제할 수 없습니다.',
        undefined,
        { orderCount },
      );

    await this.prisma.$transaction(async (tx) => {
      const versions = await tx.contractVersion.findMany({
        where: { contractId: id },
        select: { id: true },
      });
      const versionIds = versions.map((v) => v.id);

      // 컨설팅 산출물(계약 품목·부위·옵션/렌탈 선택 세션)을 함께 정리한다.
      const contractItemIds = (
        await tx.contractItem.findMany({
          where: { contractId: id },
          select: { id: true },
        })
      ).map((c) => c.id);
      await this.items.deleteContractItemsDeep(tx, contractItemIds);

      // 계약 → 현재 버전 FK를 먼저 끊어야 버전을 지울 수 있다.
      await tx.contract.update({ where: { id }, data: { currentVersionId: null } });
      await tx.contractLine.deleteMany({ where: { contractVersionId: { in: versionIds } } });
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
          },
        },
        asAuditClient(tx),
      );
    });

    return { id, contractNo: contract.contractNo, deleted: true };
  }

  // ---------------------------------------------------------------------------
  // 계약 흐름 게이팅 (현업 확정 2026-07-28)
  //   계약서 작성 → 스타일 컨설팅 → 서명 → 계약 완료 → 주문
  // ---------------------------------------------------------------------------

  /**
   * 계약 흐름 상태 — 화면이 [서명하기]·[계약 완료] 버튼을 켤지 판단하는 근거.
   * 서버가 최종 검증을 하므로 여기 값은 화면 안내용이다.
   */
  async getFlow(id: string) {
    const contract = await getContractOrThrow(this.prisma, id);
    // 주문 존재 여부가 취소·삭제 가능을 가른다 — 주문이 생긴 계약은 취소하지 않는다 (현업 확정 2026-07-31).
    const orderCount = await this.prisma.order.count({ where: { contractId: id } });
    const version = contract.currentVersionId
      ? await this.prisma.contractVersion.findUnique({ where: { id: contract.currentVersionId } })
      : null;
    const consulting = await this.items.consultingReadiness(id);
    const signed = !!version?.signatureFileId && !!version.signedAt;

    return {
      contractId: id,
      status: contract.status,
      version: contract.rowVersion,
      currentVersionId: contract.currentVersionId,
      versionNo: version?.versionNo ?? null,
      consulting: {
        ready: consulting.ready,
        targetCount: consulting.targetCount,
        pending: consulting.pending,
      },
      signed,
      signedAt: version?.signedAt ?? null,
      signerName: version?.signerName ?? null,
      /** 서명 가능 = 작성중 + 컨설팅 전 품목 확정 */
      canSign: contract.status === 'DRAFT' && consulting.ready,
      /** 완료 가능 = 서명완료 */
      canComplete: contract.status === 'SIGNED',
      completed: contract.status === 'COMPLETED',
      /** 수정하기(버전업) 가능 = 완료된 계약 */
      canRevise: contract.status === 'COMPLETED',
      /** 수정하기(서명 해제) 가능 = 서명완료 — 버전업 없이 작성중으로 되돌려 다시 서명받는다 */
      canReopen: contract.status === 'SIGNED',
      /**
       * 취소 가능 = 작성중·서명완료 **이면서 주문이 없는** 계약 (현업 확정 2026-07-31).
       * 주문이 생긴 계약(완료 후 수정하기로 되돌린 경우 포함)은 취소하지 않는다 —
       * 실물 정리는 렌탈 메뉴·오프라인에서 한다. 취소는 종결 상태다(수정하기 없음).
       */
      canCancel: (contract.status === 'DRAFT' || contract.status === 'SIGNED') && orderCount === 0,
      excelStored: !!version?.excelFileId,
    };
  }

  // ---------------------------------------------------------------------------
  // 위임 — 컨트롤러·다른 모듈의 진입점 유지 (해체 후 公開 표면)
  // ---------------------------------------------------------------------------

  async consultingReadiness(contractId: string) {
    return this.items.consultingReadiness(contractId);
  }

  async setVestIncluded(contractItemId: string, included: boolean, actor: AuthUser) {
    return this.items.setVestIncluded(contractItemId, included, actor);
  }

  /** 옵션 확정 반영(option-sessions)에서도 부른다 — 세션 확정 시 롤업 라인 동기화. */
  async syncOptionRollupLine(tx: Prisma.TransactionClient, contractId: string, versionId: string) {
    return this.items.syncOptionRollupLine(tx, contractId, versionId);
  }

  async getDocument(id: string) {
    return this.document.getDocument(id);
  }

  async buildContractDocumentExcel(id: string, actor: AuthUser, opts: { audit?: boolean } = {}) {
    return this.document.buildContractDocumentExcel(id, actor, opts);
  }

  async createRevision(id: string, dto: CreateRevisionDto, actor: AuthUser) {
    return this.versions.createRevision(id, dto, actor);
  }

  async complete(id: string, dto: CompleteContractDto, actor: AuthUser) {
    return this.versions.complete(id, dto, actor);
  }

  async saveSignature(id: string, versionId: string, dto: SaveSignatureDto, actor: AuthUser) {
    return this.versions.saveSignature(id, versionId, dto, actor);
  }

  async removeSignature(id: string, versionId: string, actor: AuthUser) {
    return this.versions.removeSignature(id, versionId, actor);
  }

  async getSignature(id: string, versionId: string) {
    return this.versions.getSignature(id, versionId);
  }

  // ---------------------------------------------------------------------------
  // 내부 헬퍼
  // ---------------------------------------------------------------------------

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
}
