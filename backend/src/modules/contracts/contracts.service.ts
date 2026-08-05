import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { toDateOrNull as toDate, todayAsDbDate } from '../../common/date';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FilesService } from '../files/files.service';
import { COMPONENT_GROUP_LABELS, componentGroupsFor } from '../options/option-component-groups';
import { autoLinkMeasurements } from '../measurements/measurement-link';
import { orderItemIdsOfContract, syncPrepStatuses } from '../production/prep-status';
import { applyItemStatus } from '../production/item-status';
import { anyInProduction } from '../production/production-status';
import { buildContractExcel, ContractExcelLine } from './contract-excel';
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

/**
 * 품목 대분류 → 기본 구성품 (설계서 7.2).
 *
 * 정장은 맞춤·렌탈 가리지 않고 상의·하의·베스트 세 부위로 만든다 (현업 확정 2026-08-01).
 * 계약 시점에는 베스트를 뺄지 알 수 없어 계약서는 베스트를 다루지 않고, 벌마다 뺄지 말지는
 * 스타일 컨설팅에서 [베스트 제외] 체크로 정한다(setVestIncluded). 렌탈도 베스트 재고를
 * 따로 갖고 있어 부위가 없으면 3피스를 빌려줄 수 없었다.
 */
const COMPONENT_MAP: Record<string, string[]> = {
  SUIT: ['JACKET', 'TROUSERS', 'VEST'],
  SHIRT: ['SHIRT'],
  SHOES: ['SHOES'],
};

/** 계약서 엑셀 MIME (파일 저장·스트리밍 공용) */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const CATEGORY_LABEL: Record<string, string> = {
  SUIT: '정장',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/**
 * 계약서 출력 품목 순서: 맞춤(정장>셔츠>구두) → 렌탈(정장>셔츠>구두).
 * 저장 순서(sortOrder)와 무관하게 출력물(웹 계약서·엑셀)에서는 항상 이 순서로 싣는다.
 */
const TRANSACTION_ORDER: Record<string, number> = { CUSTOM: 0, RENTAL: 1 };
const CATEGORY_ORDER: Record<string, number> = { SUIT: 0, SHIRT: 1, SHOES: 2 };

function sortDocumentLines<T extends { transactionType: string; productCategory: string }>(
  lines: readonly T[],
): T[] {
  return [...lines].sort(
    (a, b) =>
      (TRANSACTION_ORDER[a.transactionType] ?? 99) - (TRANSACTION_ORDER[b.transactionType] ?? 99) ||
      (CATEGORY_ORDER[a.productCategory] ?? 99) - (CATEGORY_ORDER[b.productCategory] ?? 99),
  );
}

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
  contractItemId: string;
  /** 확정 후 물리화된 주문번호. 가계약(확정 전)에는 아직 주문이 없어 null. */
  orderNo: string | null;
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
      // 작성중 저장 즉시 컨설팅 대상 품목을 만든다 (계약-컨설팅-서명-완료-주문 흐름).
      await this.syncContractItems(tx, contractId, versionId, null);
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
        // 라인이 바뀌면 컨설팅 대상 품목도 수량에 맞춰 정합한다 (기존 선택은 보존).
        // 수정하기로 만든 버전이면 그 사유를 품목 취소 사유로 남긴다.
        await this.syncContractItems(tx, id, draft.id, draft.changeReason);
        // 라인을 통째로 다시 만들었으니, 컨설팅 옵션 추가금액 롤업 라인도 다시 붙인다.
        await this.syncOptionRollupLine(tx, id, draft.id);
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

  /**
   * 베스트 포함/제외 (현업 확정 2026-08-01) — 스타일 컨설팅 화면의 [베스트 제외] 체크박스.
   *
   * 계약서는 베스트를 다루지 않는다. 정장은 맞춤·렌탈 모두 상의·하의·베스트 세 부위로
   * 만들어지고, 어느 벌에서 뺄지는 옷을 고르면서 여기서 정한다. 이 API가 유일한 경로라
   * 체크(제외)와 해제(재포함)를 한 메서드로 왕복한다.
   *
   * **금액은 건드리지 않는다** — 베스트 값이 그때그때 달라 계약금액은 계약서에서 수기로
   * 조정한다. 다만 이미 계약금액에 반영한 베스트 *옵션 추가금*은 되돌린다(고른 적 없는
   * 옵션의 돈이 계약에 남으면 안 된다).
   *
   * 작성중(DRAFT)에서만 허용한다 — 서명·완료된 계약은 [수정하기]로 새 버전을 만든 뒤
   * 같은 조작을 한다(재서명·재완료 흐름).
   */
  async setVestIncluded(contractItemId: string, included: boolean, actor: AuthUser) {
    const item = await this.prisma.contractItem.findUnique({
      where: { id: contractItemId },
      include: {
        components: true,
        contract: { select: { id: true, contractNo: true, status: true, rowVersion: true, currentVersionId: true } },
        sourceContractLine: true,
        orderItems: { select: { status: true } },
      },
    });
    if (!item) throw new NotFoundException('계약 품목이 없습니다.');
    const contract = item.contract;
    if (contract.status !== 'DRAFT')
      throw new BusinessException(
        'CONTRACT_NOT_DRAFT',
        '작성중인 계약에서만 베스트를 바꿀 수 있습니다. 계약서 [수정하기]로 되돌린 뒤 진행해 주세요.',
        undefined,
        { status: contract.status },
      );
    // 컨설팅 잠금과 같은 규칙 — 제작 진행 중(발주 이후) 벌은 손대지 않는다 (0731).
    const inProduction = anyInProduction(item.orderItems);
    if (inProduction)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '제작 진행 중인 품목은 베스트를 바꿀 수 없습니다. 제작·입출고 화면에서 상태를 되돌린 뒤 진행해 주세요.',
      );
    if (!this.isVestCapable(item.transactionType, item.productCategory))
      throw new BusinessException('VALIDATION_ERROR', '정장 품목에서만 베스트를 바꿀 수 있습니다.', [
        { field: 'contractItemId', reason: 'NOT_SUIT' },
      ]);
    if (item.status === 'CANCELLED')
      throw new BusinessException('VALIDATION_ERROR', '취소된 품목입니다.', [
        { field: 'contractItemId', reason: 'ITEM_CANCELLED' },
      ]);

    const wasIncluded = item.components.some(
      (c) => c.componentType === 'VEST' && c.status !== 'CANCELLED',
    );
    if (wasIncluded === included)
      return {
        contractItemId: item.id,
        contractId: contract.id,
        contractNo: contract.contractNo,
        displayName: item.displayName,
        vestIncluded: included,
        changed: false,
      };

    await this.prisma.$transaction(async (tx) => {
      // 부위를 켜고 끈다(물리 삭제 없음). 제외면 그 벌의 베스트 옵션 선택·반영 추가금도 정리한다.
      // 계약서 라인·합계는 건드리지 않는다 — 베스트 금액은 계약서에서 수기로 조정한다.
      await this.syncVestComponent(tx, item, included);
      // 낙관적 잠금·감사 — 계약 품목 구성이 바뀌었다.
      await tx.contract.update({ where: { id: contract.id }, data: { rowVersion: { increment: 1 } } });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'UPDATE',
          entityType: 'CONTRACT_ITEM',
          entityId: item.id,
          before: { displayName: item.displayName, vestIncluded: wasIncluded },
          after: { displayName: item.displayName, vestIncluded: included },
          reason: included
            ? '베스트 포함 (스타일 컨설팅 — [베스트 제외] 해제)'
            : '베스트 제외 (스타일 컨설팅 — [베스트 제외] 체크)',
        },
        asAuditClient(tx),
      );
    });

    return {
      contractItemId: item.id,
      contractId: contract.id,
      contractNo: contract.contractNo,
      displayName: item.displayName,
      vestIncluded: included,
      changed: true,
    };
  }

  // ---------------------------------------------------------------------------
  // 물리화 (계약완료 시점 — 현업 확정 2026-07-30)
  // ---------------------------------------------------------------------------

  /**
   * 계약이 성립할 때 한 번에 처리하는 것들 — 계약완료([계약완료] 버튼)에서만 부른다.
   * 흐름: 작성중 → 서명완료 → **계약완료(여기)** → 수정하기(버전업) → 작성중 …
   *
   * 예전에는 '등록(확정)' 단계가 이 일을 앞에서 했는데, 컨설팅이 작성중 단계로 내려와
   * 등록을 앞세울 이유가 없어졌다. 서명한 버전을 확정본으로 굳히고, 주문·고객·진행단계를
   * 여기서 맞춘다. 수정하기로 다시 완료해도 품목이 계약 소유라 같은 주문품목이 이어진다.
   */
  private async physicalizeOnComplete(
    tx: Prisma.TransactionClient,
    contract: { id: string; customerId: string; contractedAt: Date | null; customer?: { contractedAt: Date | null; registeredAt: Date | null } | null },
    version: { id: string; completionDueDate: Date | null; photoDate: Date | null; weddingDate: Date | null },
    actor: AuthUser,
    completedAt: Date,
  ): Promise<{ orders: OrderSummary[]; customerStatus: string }> {
    await tx.contractVersion.update({
      where: { id: version.id },
      data: { versionStatus: 'CONFIRMED', confirmedBy: actor.id, confirmedAt: completedAt },
    });
    // 이전 확정 버전 보존: SUPERSEDED (설계서 6.3)
    await tx.contractVersion.updateMany({
      where: { contractId: contract.id, versionStatus: 'CONFIRMED', id: { not: version.id } },
      data: { versionStatus: 'SUPERSEDED' },
    });

    const customer = await tx.customer.update({
      where: { id: contract.customerId },
      data: {
        customerStatus: 'CONTRACTED',
        contractedAt: contract.customer?.contractedAt ?? completedAt,
        // 등록 절차를 거치지 않고 계약까지 온 경우를 보정한다 (계약 고객은 반드시 고객 목록에 있어야 한다)
        ...(contract.customer?.registeredAt ? {} : { registeredAt: completedAt }),
        rowVersion: { increment: 1 },
      },
    });

    const orders = await this.syncOrders(
      tx,
      contract.id,
      {
        completionDueDate: version.completionDueDate,
        photoDate: version.photoDate,
        weddingDate: version.weddingDate,
        cancelReason: null,
      },
      actor.id,
    );

    // AUTO 진행단계 훅 (설계서 02 §9.2 / 03 §6 / 07 §7.1).
    // (1) 주문별 진행을 보장하고 — 없으면 계약 단계에서 시작시킨다.
    // (2) 그 밖에 남은 ACTIVE 진행을 계약 단계로 전진시킨다.
    await this.ensureJourneysForOrders(tx, contract.customerId, orders, completedAt, actor.id);
    await this.advanceJourneysToContractConfirmed(tx, contract.customerId, completedAt, actor.id);

    /*
      계약 전에 미리 잰 채촌을 방금 생긴 품목에 붙인다 (현업 확정 2026-08-05).
      정상 순서는 '컨설팅에서 채촌 → 계약완료'인데, 그때는 주문이 없어 붙일 자리가 없었다.
      여기서 붙이지 않으면 준비가 끝난 적이 없는 것으로 남아 제작 목록에 뜨지 않는다.
    */
    await autoLinkMeasurements(tx, contract.customerId, actor.id);

    // 계약 전에 끝내 둔 준비(옵션 확정·채촌)를 물리화된 품목 상태에 반영한다.
    await syncPrepStatuses(tx, await orderItemIdsOfContract(tx, contract.id), actor.id);

    return { orders, customerStatus: customer.customerStatus };
  }

  // ---------------------------------------------------------------------------
  // 수정하기(버전업) — 계약서 문서의 버전업 (현업 확정 2026-07-30)
  // ---------------------------------------------------------------------------

  /**
   * 완료된 계약을 다시 고친다 — 계약서 스냅샷만 새 버전으로 복사하고 상태를 작성중으로 되돌린다.
   *
   * **계약이 변경된 것이고 취소·재계약이 아니다.** 품목은 계약 소유이므로 여기서 건드리지 않는다
   * → 컨설팅 선택·주문·주문품목·작업지시서·입출고·채촌이 그대로 이어진다. 수량을 실제로 바꾸면
   * 이후 임시저장(update)에서 syncContractItems 가 **차이만** 반영한다(늘어난 것만 새 품목).
   * 서명은 복사하지 않는다 — 고친 계약서에는 다시 서명을 받아야 한다.
   */
  async createRevision(id: string, dto: CreateRevisionDto, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    if (contract.status !== 'COMPLETED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '완료된 계약만 수정할 수 있습니다.', undefined, {
        status: contract.status,
      });
    const existingDraft = await this.prisma.contractVersion.findFirst({
      where: { contractId: id, versionStatus: 'DRAFT' },
    });
    if (existingDraft)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 수정 중인 계약서가 있습니다.', undefined, {
        revisionId: existingDraft.id,
      });
    const base = await this.prisma.contractVersion.findFirst({
      where: { contractId: id, versionStatus: 'CONFIRMED' },
      orderBy: { versionNo: 'desc' },
      include: VERSION_INCLUDE,
    });
    if (!base) throw new BusinessException('INVALID_STATUS_TRANSITION', '확정 버전이 없어 수정할 수 없습니다.');
    // 수정하기는 이력을 남기는 기능이다 — 무엇 때문에 고쳤는지 없으면 이력이 쓸모없다.
    if (!dto.changeReason?.trim())
      throw new BusinessException('VALIDATION_ERROR', '수정 사유는 필수입니다.', [
        { field: 'changeReason', reason: 'REQUIRED' },
      ]);

    const lines: ContractLineDto[] =
      dto.lines ??
      // 옵션 롤업 라인은 새 버전에서 세션 합계로 다시 만든다 — 그대로 복사하면 일반 품목으로 굳는다.
      base.lines
        .filter((l) => !l.isOptionRollup)
        .map((l) => ({
        transactionType: l.transactionType,
        productCategory: l.productCategory,
        itemDescription: l.itemDescription ?? undefined,
        quantity: l.quantity,
        unitPrice: l.unitPrice === null ? undefined : Number(l.unitPrice),
        lineAmount: Number(l.lineAmount),
        notes: l.notes ?? undefined,
        sortOrder: l.sortOrder,
      }));

    const revision = await this.prisma.$transaction(async (tx) => {
      const created = await tx.contractVersion.create({
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
      // 품목은 계약 소유라 손대지 않는다 — 새 버전 라인으로 참조만 다시 걸고 수량 차이를 반영한다.
      await this.syncContractItems(tx, id, created.id, dto.changeReason ?? null);
      // 이어지는 컨설팅 옵션 추가금액을 새 버전에도 롤업 라인으로 반영한다.
      await this.syncOptionRollupLine(tx, id, created.id);
      // 수정 중에는 계약서를 다시 작성하는 상태다 → 작성중으로 되돌리고 이 버전을 현재로 잡는다.
      await this.updateContractGuarded(tx, id, contract.rowVersion, {
        status: 'DRAFT',
        currentVersionId: created.id,
      });
      return created;
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

  // ---------------------------------------------------------------------------
  // 취소·계약서 출력
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
    const contract = await this.getContractOrThrow(id);
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
    this.assertVersionMatch(contract.rowVersion, dto.version);

    await this.prisma.$transaction(async (tx) => {
      const cancelledAt = new Date();
      await this.updateContractGuarded(tx, id, dto.version ?? contract.rowVersion, { status: 'CANCELLED' });

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
    const contract = await this.getContractOrThrow(id);
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
      await this.deleteContractItemsDeep(tx, contractItemIds);

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
      // 품목표는 계약서 라인을 그대로 편다 — 베스트는 자기 행을 갖지 않는다 (현업 확정 2026-08-01).
      // 정장은 상의·하의·베스트가 한 벌이고, 어느 벌에서 베스트를 뺄지는 스타일 컨설팅에서
      // 정해 품목 계층(items)에 나타난다. 라인 금액은 저장된 값을 쪼개지 않고 그대로 싣는다.
      lines: sortDocumentLines((version?.lines ?? []).filter((l) => !l.isOptionRollup)).map((l) => ({
        transactionType: l.transactionType,
        productCategory: l.productCategory,
        categoryLabel: CATEGORY_LABEL[l.productCategory] ?? l.productCategory,
        itemDescription: l.itemDescription,
        // 주문 생성 전(계약 확정 전) 폴백용 세부품목 라벨
        components: componentLabels(l.productCategory),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineAmount: Number(l.lineAmount),
        notes: l.notes,
        // 주문품목 × 부위 × 유료옵션 계층 (주문 생성 전에는 빈 배열)
        items:
          itemTree.get(`line:${l.id}`) ??
          itemTree.get(`${l.transactionType}|${l.productCategory}`) ??
          [],
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
  // 계약 흐름 게이팅 (현업 확정 2026-07-28)
  //   계약서 작성 → 등록(확정·주문 생성) → 스타일 컨설팅 → 서명 → 계약 완료
  // ---------------------------------------------------------------------------

  /**
   * 스타일 컨설팅이 전 품목 끝났는지 본다. 컨설팅은 작성중 단계의 계약 품목(ContractItem)에서 진행한다.
   *
   * 맞춤(CUSTOM) 품목은 옵션 선택 세션이, 렌탈(RENTAL) 품목은 렌탈 선택 세션이 각각 CONFIRMED여야 한다.
   * 취소된 품목은 대상에서 뺀다. 품목이 없으면(라인 미입력) 준비된 것으로 보지 않는다.
   */
  async consultingReadiness(contractId: string) {
    const items = await this.prisma.contractItem.findMany({
      where: { contractId, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        displayName: true,
        transactionType: true,
        components: { select: { componentType: true, status: true } },
        optionSelectionSessions: {
          where: { isCurrent: true },
          select: {
            status: true,
            values: { select: { optionStageId: true } },
            optionSetVersion: {
              select: {
                stages: { where: { active: true }, select: { id: true, componentGroup: true } },
              },
            },
          },
        },
        rentalSelectionSessions: { where: { isCurrent: true }, select: { status: true } },
      },
    });

    const pending: { contractItemId: string; displayName: string; transactionType: string }[] = [];
    let targetCount = 0;
    for (const item of items) {
      targetCount += 1;
      let done = false;
      if (item.transactionType === 'RENTAL') {
        done = item.rentalSelectionSessions.some((x) => x.status === 'CONFIRMED');
      } else {
        // 확정 상태만으로는 모자란 경우가 하나 있다 — 2피스로 확정한 뒤 베스트를 추가하면
        // 베스트 단계가 미선택인 채 확정으로 남는다. 확정 시점 검증(confirm)이 보장하는
        // 나머지 단계는 다시 세지 않고, **베스트 단계의 공백만** 미완료로 본다.
        const session = item.optionSelectionSessions[0];
        if (session?.status === 'CONFIRMED') {
          const vestActive = item.components.some(
            (c) => c.componentType === 'VEST' && c.status !== 'CANCELLED',
          );
          const vestStages = vestActive
            ? session.optionSetVersion.stages.filter((s) => s.componentGroup === 'VEST')
            : [];
          const selected = new Set(session.values.map((v) => v.optionStageId));
          done = vestStages.every((s) => selected.has(s.id));
        }
      }
      if (!done) {
        pending.push({
          contractItemId: item.id,
          displayName: item.displayName,
          transactionType: item.transactionType,
        });
      }
    }
    return { ready: targetCount > 0 && pending.length === 0, targetCount, pending };
  }

  /**
   * 계약 흐름 상태 — 화면이 [서명하기]·[계약 완료] 버튼을 켤지 판단하는 근거.
   * 서버가 최종 검증을 하므로 여기 값은 화면 안내용이다.
   */
  async getFlow(id: string) {
    const contract = await this.getContractOrThrow(id);
    // 주문 존재 여부가 취소·삭제 가능을 가른다 — 주문이 생긴 계약은 취소하지 않는다 (현업 확정 2026-07-31).
    const orderCount = await this.prisma.order.count({ where: { contractId: id } });
    const version = contract.currentVersionId
      ? await this.prisma.contractVersion.findUnique({ where: { id: contract.currentVersionId } })
      : null;
    const consulting = await this.consultingReadiness(id);
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

  /** 서명 가능 조건 검사 — 작성중인 현재 버전 + 컨설팅 전 품목 확정. */
  private async assertSignable(
    contract: { id: string; status: string; currentVersionId: string | null },
    version: { id: string; versionStatus: string },
  ) {
    if (contract.status !== 'DRAFT')
      throw new BusinessException(
        'CONTRACT_NOT_DRAFT',
        contract.status === 'SIGNED'
          ? '이미 서명을 받은 계약입니다.'
          : '작성중인 계약에만 서명할 수 있습니다.',
        undefined,
        { status: contract.status },
      );
    if (version.versionStatus !== 'DRAFT' || contract.currentVersionId !== version.id)
      throw new BusinessException(
        'CONTRACT_NOT_DRAFT',
        '현재 작성중인 계약서 버전에만 서명할 수 있습니다.',
        undefined,
        { versionStatus: version.versionStatus },
      );

    const consulting = await this.consultingReadiness(contract.id);
    if (!consulting.ready)
      throw new BusinessException(
        'CONSULTING_NOT_CONFIRMED',
        '스타일 컨설팅을 모든 품목에 대해 확정한 뒤 서명할 수 있습니다.',
        undefined,
        { pending: consulting.pending },
      );
  }

  /**
   * 계약 완료 — 계약이 성립하는 시점 (현업 확정 2026-07-30).
   *
   * 서명완료 계약만 완료할 수 있다. 여기서 서명한 버전을 확정본으로 굳히고,
   * 주문·주문품목·고객 전환·진행단계를 한 트랜잭션으로 물리화한다(physicalizeOnComplete).
   * 완료 시점의 계약서 엑셀을 구워 버전에 보관한다(설계서 03 M3) — 이후 다운로드는 보관본.
   */
  async complete(id: string, dto: CompleteContractDto, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    if (contract.status !== 'SIGNED')
      throw new BusinessException('CONTRACT_NOT_COMPLETABLE', '서명을 받은 계약만 완료할 수 있습니다.', undefined, {
        status: contract.status,
      });
    const version = contract.currentVersionId
      ? await this.prisma.contractVersion.findUnique({ where: { id: contract.currentVersionId } })
      : null;
    if (!version) throw new NotFoundException('계약 버전이 없습니다.');
    if (!version.signatureFileId || !version.signedAt)
      throw new BusinessException('CONTRACT_SIGNATURE_REQUIRED', '서명을 받은 뒤 계약을 완료할 수 있습니다.');

    // 엑셀은 트랜잭션 밖에서 만든다 — 파일 생성이 오래 걸려 잠금을 오래 쥐면 안 된다.
    // 실패하면 완료 자체가 진행되지 않으므로 고아 파일도 남지 않는다.
    const { buffer, fileName } = await this.buildContractDocumentExcel(id, actor, { audit: false });
    const file = await this.files.saveBuffer(
      { buffer, mimeType: XLSX_MIME, originalName: fileName },
      actor,
    );

    const completedAt = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const { orders, customerStatus } = await this.physicalizeOnComplete(
        tx,
        contract,
        version,
        actor,
        completedAt,
      );
      await tx.contractVersion.update({
        where: { id: version.id },
        data: { excelFileId: file.id },
      });
      // version 미지정이면 현재 값으로 진행한다(단건 화면에서 낙관적 잠금 없이 누르는 경우).
      await this.updateContractGuarded(tx, id, dto.version ?? contract.rowVersion, {
        status: 'COMPLETED',
        // 계약일은 처음 완료한 날로 고정한다 — 수정하기로 다시 완료해도 갱신하지 않는다.
        contractedAt: contract.contractedAt ?? completedAt,
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'COMPLETE',
          entityType: 'CONTRACT',
          entityId: id,
          before: { status: contract.status },
          after: {
            status: 'COMPLETED',
            versionNo: version.versionNo,
            excelFileId: file.id,
            signedAt: version.signedAt,
            completedAt,
            customerStatus,
            orders,
          },
        },
        asAuditClient(tx),
      );
      return { orders, customerStatus };
    });

    return {
      contractId: id,
      contractNo: contract.contractNo,
      status: 'COMPLETED',
      versionNo: version.versionNo,
      customerStatus: result.customerStatus,
      orders: result.orders,
      excelFileId: file.id,
      downloadUrl: `/api/v1/contracts/${id}/excel`,
    };
  }

  // ---------------------------------------------------------------------------
  // 전자서명 (설계서 03 §3)
  // ---------------------------------------------------------------------------

  /**
   * 서명 저장·교체 (현업 확정 2026-07-30).
   *
   * 서명은 **스타일 컨설팅까지 끝난 작성중 계약서**에 받고, 받으면 상태가 서명완료가 된다.
   * 옵션 추가금액이 서명 전에 총액에 반영되므로, 서명본 금액과 이후 재출력 금액이
   * 어긋나지 않는다(설계서 03 M1). 이미지는 files 모듈에 저장하고 버전에 연결한다.
   */
  async saveSignature(id: string, versionId: string, dto: SaveSignatureDto, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    const version = await this.prisma.contractVersion.findUnique({ where: { id: versionId } });
    if (!version || version.contractId !== id) throw new NotFoundException('계약 버전이 없습니다.');
    await this.assertSignable(contract, version);
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
      // 서명을 받으면 상태가 서명완료로 넘어간다 → 그 뒤로는 계약완료만 남는다.
      await this.updateContractGuarded(tx, id, contract.rowVersion, { status: 'SIGNED' });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'SIGN',
          entityType: 'CONTRACT_VERSION',
          entityId: versionId,
          after: { signerName: dto.signerName, signedAt, status: 'SIGNED' },
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

  /** 서명 제거 — 서명완료를 작성중으로 되돌린다. 완료된 계약의 서명은 지울 수 없다. */
  async removeSignature(id: string, versionId: string, actor: AuthUser) {
    const contract = await this.getContractOrThrow(id);
    const version = await this.prisma.contractVersion.findUnique({ where: { id: versionId } });
    if (!version || version.contractId !== id) throw new NotFoundException('계약 버전이 없습니다.');
    if (contract.status === 'COMPLETED')
      throw new BusinessException('CONTRACT_NOT_COMPLETABLE', '완료된 계약의 서명은 지울 수 없습니다.', undefined, {
        status: contract.status,
      });

    await this.prisma.$transaction(async (tx) => {
      await tx.contractVersion.update({
        where: { id: versionId },
        data: { signatureFileId: null, signedAt: null, signerName: null },
      });
      if (contract.status === 'SIGNED')
        await this.updateContractGuarded(tx, id, contract.rowVersion, { status: 'DRAFT' });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'DELETE',
          entityType: 'CONTRACT_VERSION',
          entityId: versionId,
          before: { signatureFileId: version.signatureFileId, status: contract.status },
        },
        asAuditClient(tx),
      );
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

  async buildContractDocumentExcel(
    id: string,
    actor: AuthUser,
    opts: { audit?: boolean } = {},
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const contract = await this.getDetail(id);
    const version =
      contract.currentVersion ?? contract.versions[contract.versions.length - 1] ?? null;
    if (!version) throw new NotFoundException('계약 버전이 없습니다.');

    // 완료된 계약은 완료 시점에 구워 둔 보관본을 그대로 내려준다(설계서 03 M3).
    // 지금 다시 만들면 완료 후 바뀐 값이 섞여 "그때 서명한 문서"가 아니게 된다.
    if (version.excelFileId) {
      const stored = await this.files.readBuffer(version.excelFileId);
      if (opts.audit !== false) {
        await this.audit.log({
          userId: actor.id,
          action: 'EXPORT',
          entityType: 'CONTRACT',
          entityId: id,
          after: { contractNo: contract.contractNo, format: 'xlsx', stored: true },
        });
      }
      return { buffer: stored, fileName: `contract-${contract.contractNo}.xlsx` };
    }

    // 베스트는 자기 행을 갖지 않는다 (현업 확정 2026-08-01) — 웹 계약서와 같은 규칙.
    const lines: ContractExcelLine[] = sortDocumentLines(
      version.lines.filter((l) => !l.isOptionRollup),
    ).map((l) => ({
      category: CATEGORY_LABEL[l.productCategory] ?? l.productCategory,
      components: componentLabels(l.productCategory),
      quantity: l.quantity,
    }));
    // 옵션 목록 뒤에 "베스트 제외 — 정장 #2"를 붙인다 (현업 확정 2026-08-01).
    // 계약서가 베스트를 다루지 않으니, 3피스로 계약하고 2피스로 만든다는 사실이 종이에도 남아야 한다.
    const options = [...(await this.loadContractOptions(id)), ...(await this.loadVestExclusions(id))];

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

    if (opts.audit !== false) {
      await this.audit.log({
        userId: actor.id,
        action: 'EXPORT',
        entityType: 'CONTRACT',
        entityId: id,
        after: { contractNo: contract.contractNo, format: 'xlsx', stored: false },
      });
    }

    return { buffer, fileName: `contract-${contract.contractNo}.xlsx` };
  }

  // ---------------------------------------------------------------------------
  // 내부: 옵션 추가금액 롤업 라인
  // ---------------------------------------------------------------------------

  /**
   * 스타일 컨설팅 옵션 추가금액을 계약 품목 맨 아래 '옵션(추가금액)' 한 줄로 동기화한다.
   *
   * 금액은 그 계약의 **현재 확정 세션들**의 반영 누계(surchargeApplied) 합계다 —
   * 확정 시 applyPendingTx가 계약 버전 금액(totalAmount)에 더한 값과 정확히 같아,
   * 롤업 라인 합계와 계약 금액이 어긋나지 않는다.
   *
   * 이 라인은 백엔드가 소유한다: 화면 저장 본문에는 실려 오지 않고(프론트가 제외),
   * 라인 재생성(초안 수정·변경계약)·확정 반영 때마다 여기서 지우고 다시 만든다.
   * 합계가 0이면 라인을 두지 않는다.
   */
  async syncOptionRollupLine(
    tx: Prisma.TransactionClient,
    contractId: string,
    versionId: string,
  ): Promise<void> {
    const sessions = await tx.optionSelectionSession.findMany({
      where: { contractItem: { contractId }, isCurrent: true },
      select: { surchargeApplied: true },
    });
    const total = sessions.reduce((sum, s) => sum + Number(s.surchargeApplied), 0);

    // 항상 먼저 걷어낸다 — 금액이 바뀌었거나 0이 되면 한 줄만 남기거나 없애기 위해.
    await tx.contractLine.deleteMany({
      where: { contractVersionId: versionId, isOptionRollup: true },
    });
    if (total <= 0) return;

    const agg = await tx.contractLine.aggregate({
      where: { contractVersionId: versionId },
      _max: { sortOrder: true },
    });
    await tx.contractLine.create({
      data: {
        id: randomUUID(),
        contractVersionId: versionId,
        // 실제 거래방식·품목이 아니라 옵션 합산 라인임을 나타내는 표식값.
        transactionType: 'OPTION',
        productCategory: 'OPTION',
        itemDescription: '옵션(추가금액)',
        quantity: 1,
        unitPrice: total,
        lineAmount: total,
        vestIncluded: false,
        vestUnitPrice: null,
        notes: null,
        sortOrder: (agg._max.sortOrder ?? 0) + 1,
        isOptionRollup: true,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 내부: 주문·품목 펼침
  // ---------------------------------------------------------------------------

  /**
   * 계약 품목 정합 — 계약 라인(거래방식×품목×수량)을 벌 단위 ContractItem으로 펼친다.
   * 컨설팅(옵션·렌탈 선택)이 이 품목·부위(ContractItemComponent)에 붙는다.
   *
   * **품목은 계약 소유다**(현업 확정 2026-07-30). 수정하기(버전업)로 새 버전이 생겨도 품목은
   * 그대로 이어지고, 여기서 수량 차이만 반영한다. **주문(Order)은 만들지 않는다** —
   * 계약완료 시 syncOrdersToVersion이 이 품목을 주문으로 물리화한다.
   * - 수량 증가: 다음 sequence_no로 신규 품목 + 기본 구성품 생성 (그 품목만 컨설팅 미선택)
   * - 수량 감소:
   *   · 작성중이고 아직 물리화(주문)되지 않았으면 → 지우고 순번을 다시 채운다(#1…#n 연속).
   *     계약 성립 전이라 이력을 남길 대상이 아니고, 번호가 튀면 현장에서 헷갈린다.
   *   · 그 밖에는 뒤 순번부터 CANCELLED (사유 기록, 물리 삭제 금지 → 주문·작업지시서 보존)
   */
  private async syncContractItems(
    tx: Prisma.TransactionClient,
    contractId: string,
    versionId: string,
    cancelReason: string | null,
  ): Promise<void> {
    const lines = await tx.contractLine.findMany({
      // 옵션 추가금액 롤업 라인은 실제 벌이 아니므로 컨설팅 대상 품목으로 펼치지 않는다.
      where: { contractVersionId: versionId, isOptionRollup: false },
      orderBy: { sortOrder: 'asc' },
    });

    // 라인을 벌 단위 슬롯으로 편다 — 슬롯 순서(라인 sortOrder → 수량)가 품목 순번(#1…#n)과 짝이 된다.
    const slotsByKey = new Map<string, Array<{ lineId: string }>>();
    for (const line of lines) {
      const key = `${line.transactionType}|${line.productCategory}`;
      const slots = slotsByKey.get(key) ?? [];
      for (let n = 0; n < line.quantity; n += 1) slots.push({ lineId: line.id });
      slotsByKey.set(key, slots);
    }

    const existingItems = await tx.contractItem.findMany({
      where: { contractId },
      // 물리화(주문품목) 여부가 '지워도 되는 품목'을, 상태가 '베스트를 꺼도 되는 품목'을 가른다.
      include: { orderItems: { select: { id: true, status: true } }, components: true },
    });
    const keys = new Set<string>([
      ...slotsByKey.keys(),
      ...existingItems.map((i) => `${i.transactionType}|${i.productCategory}`),
    ]);

    for (const key of keys) {
      const [transactionType, productCategory] = key.split('|');
      const slots = slotsByKey.get(key) ?? [];
      const targetQty = slots.length;
      let itemsOfKey = existingItems.filter(
        (i) => i.transactionType === transactionType && i.productCategory === productCategory,
      );
      let activeItems = itemsOfKey
        .filter((i) => i.status !== 'CANCELLED')
        .sort((a, b) => a.sequenceNo - b.sequenceNo);

      if (targetQty < activeItems.length) {
        // 수량 감소는 **주문으로 물리화되지 않은 품목만** 뒤 순번부터 지운다 (현업 확정 2026-07-31).
        // 수정하기(버전업)는 품목 추가 전용이라, 물리화된 품목이 감소 대상에 걸리면
        // 저장 자체를 거부한다 — 제작 중인 옷이 계약 변경으로 조용히 취소되는 것을 막는다.
        const deficit = activeItems.length - targetQty;
        const removable = activeItems.filter((i) => i.orderItems.length === 0).slice(-deficit);
        if (removable.length < deficit) {
          const blocked = activeItems.filter((i) => i.orderItems.length > 0);
          const sample = blocked[blocked.length - 1];
          throw new BusinessException(
            'INVALID_STATUS_TRANSITION',
            `${sample.displayName}은(는) 주문이 진행 중이라 수량을 줄일 수 없습니다. 수정하기에서는 품목 추가만 가능합니다.`,
            undefined,
            { blockedItemIds: blocked.map((i) => i.id) },
          );
        }
        await this.deleteContractItemsDeep(
          tx,
          removable.map((i) => i.id),
        );
        const removedIds = new Set(removable.map((i) => i.id));
        itemsOfKey = itemsOfKey.filter((i) => !removedIds.has(i.id));
        activeItems = activeItems.filter((i) => !removedIds.has(i.id));
      } else if (targetQty > activeItems.length) {
        const label =
          transactionType === 'RENTAL'
            ? `렌탈 ${CATEGORY_LABEL[productCategory] ?? productCategory}`
            : CATEGORY_LABEL[productCategory] ?? productCategory;
        // 취소된 품목이 차지한 순번은 비켜 간다(이력 보존). 남은 품목 기준으로 다음 번호를 뽑는다.
        const maxSeq = itemsOfKey.reduce((m, i) => Math.max(m, i.sequenceNo), 0);
        // 루프 안에서 activeItems에 push하므로 생성 수·슬롯 기준 위치를 먼저 고정한다.
        const baseLen = activeItems.length;
        const createCount = targetQty - baseLen;
        for (let n = 1; n <= createCount; n += 1) {
          const seq = maxSeq + n;
          const slot = slots[baseLen + n - 1];
          const componentTypes = [...(COMPONENT_MAP[productCategory] ?? [productCategory])];
          const created = await tx.contractItem.create({
            data: {
              id: randomUUID(),
              contractId,
              sourceContractLineId: slot?.lineId ?? null,
              transactionType,
              productCategory,
              sequenceNo: seq,
              displayName: `${label} #${seq}`,
              status: 'CREATED',
              components: {
                create: componentTypes.map((componentType) => ({
                  id: randomUUID(),
                  componentType,
                  sequenceNo: 1,
                  status: 'CREATED',
                })),
              },
            },
            include: { components: true },
          });
          activeItems.push({ ...created, orderItems: [] });
        }
      }

      // 살아남은 벌을 슬롯과 짝지어 라인 참조를 다시 건다.
      // (계약 수정·버전업으로 라인이 삭제·재생성돼 참조가 끊기는 문제도 여기서 함께 정합된다.)
      //
      // 베스트 부위는 여기서 건드리지 않는다 (현업 확정 2026-08-01) — 뺄지 말지는 컨설팅이
      // 단독으로 갖는다. 예전처럼 라인 값에 맞추면, 컨설팅에서 뺀 뒤 계약서에서 금액을
      // 수기로 고쳐 저장하는 순간(바로 그 흐름이다) 제외가 풀려 되살아난다.
      for (let idx = 0; idx < activeItems.length; idx += 1) {
        const item = activeItems[idx];
        const slot = slots[idx];
        if (!slot) continue;
        if (item.sourceContractLineId !== slot.lineId)
          await tx.contractItem.update({
            where: { id: item.id },
            data: { sourceContractLineId: slot.lineId },
          });
      }
    }
  }

  /**
   * 베스트를 켜고 끌 수 있는 품목인가 — 정장이면 맞춤·렌탈 모두 (현업 확정 2026-08-01).
   * 셔츠·구두는 베스트가 없다.
   */
  private isVestCapable(_transactionType: string, productCategory: string): boolean {
    return productCategory === 'SUIT';
  }

  /**
   * 품목의 VEST 부위를 켜고 끈다 (컨설팅 [베스트 제외] 체크박스 — setVestIncluded 전용).
   * - 포함: 취소된 부위가 있으면 되살리고, 없으면 새로 만든다.
   * - 제외: 부위를 CANCELLED로 두고(물리 삭제 금지) 그 품목의 베스트 옵션 선택도 정리한다.
   *   제외는 '감소'라 **제작 진행 중(제작요청 이후) 벌은 거부**한다 (현업 확정 2026-07-31).
   * 주문품목 구성품은 여기서 건드리지 않는다 — 계약완료 시 syncOrders 가 증분 반영한다.
   */
  private async syncVestComponent(
    tx: Prisma.TransactionClient,
    item: {
      id: string;
      displayName: string;
      components: { id: string; componentType: string; status: string }[];
      orderItems: { status: string }[];
    },
    vestIncluded: boolean,
  ): Promise<void> {
    const vest = item.components
      .filter((c) => c.componentType === 'VEST')
      .sort((a, b) => (a.status === 'CANCELLED' ? 1 : 0) - (b.status === 'CANCELLED' ? 1 : 0))[0];

    if (vestIncluded) {
      if (vest && vest.status !== 'CANCELLED') return; // 이미 켜져 있다
      if (vest)
        await tx.contractItemComponent.update({ where: { id: vest.id }, data: { status: 'CREATED' } });
      else
        await tx.contractItemComponent.create({
          data: { id: randomUUID(), contractItemId: item.id, componentType: 'VEST', sequenceNo: 1, status: 'CREATED' },
        });
    } else if (vest && vest.status !== 'CANCELLED') {
      if (anyInProduction(item.orderItems))
        throw new BusinessException(
          'INVALID_STATUS_TRANSITION',
          `${item.displayName}은(는) 제작 진행 중이라 베스트를 제외할 수 없습니다. 제작·입출고 화면에서 상태를 되돌린 뒤 진행해 주세요.`,
        );
      await tx.contractItemComponent.update({ where: { id: vest.id }, data: { status: 'CANCELLED' } });
      await this.removeVestSelections(tx, item.id);
    }
  }

  /**
   * 품목의 현재 옵션 세션에서 베스트 부위 흔적을 지운다 — VEST 단계 선택값과
   * 부위별 원단·컬러·패턴. 이미 계약금액에 반영한 베스트 옵션 추가금액이 있으면
   * 차액을 계약 현재 버전 금액에서 되돌리고 반영 누계를 맞춘다.
   * 남은 단계가 전부 선택된 미확정 세션은 REVIEW로 올려 완료 판정이 어긋나지 않게 한다.
   */
  private async removeVestSelections(tx: Prisma.TransactionClient, contractItemId: string): Promise<void> {
    const session = await tx.optionSelectionSession.findFirst({
      where: { contractItemId, isCurrent: true },
      include: {
        values: { include: { optionStage: { select: { componentGroup: true, active: true } } } },
        contractItem: { select: { contract: { select: { currentVersionId: true } } } },
      },
    });
    if (!session) return;

    const vestValueIds = session.values
      .filter((v) => v.optionStage.componentGroup === 'VEST')
      .map((v) => v.id);
    if (vestValueIds.length > 0)
      await tx.optionSelectionValue.deleteMany({ where: { id: { in: vestValueIds } } });
    await tx.optionSelectionComponentAttr.deleteMany({
      where: { selectionSessionId: session.id, componentGroup: 'VEST' },
    });

    // 반영 누계 정산 — 남은 선택 합계보다 이미 반영한 금액이 크면 그 차액을 되돌린다.
    const remainingTotal = session.values
      .filter((v) => v.optionStage.componentGroup !== 'VEST' && v.optionStage.active)
      .reduce((sum, v) => sum + Number(v.extraPriceSnapshot), 0);
    const applied = Number(session.surchargeApplied);
    if (applied > remainingTotal) {
      const versionId = session.contractItem.contract?.currentVersionId;
      if (versionId)
        await tx.contractVersion.update({
          where: { id: versionId },
          data: { totalAmount: { decrement: applied - remainingTotal } },
        });
      await tx.optionSelectionSession.update({
        where: { id: session.id },
        data: { surchargeApplied: remainingTotal },
      });
    }

    // 베스트 단계가 빠지면서 나머지가 이미 다 선택돼 있으면 검토 단계로 올린다.
    if (session.status === 'IN_PROGRESS') {
      const stages = await tx.optionStage.findMany({
        where: {
          optionSetVersionId: session.optionSetVersionId,
          active: true,
          NOT: { componentGroup: 'VEST' },
        },
        select: { id: true },
      });
      const selected = new Set(
        session.values.filter((v) => v.optionStage.componentGroup !== 'VEST').map((v) => v.optionStageId),
      );
      if (stages.length > 0 && stages.every((s) => selected.has(s.id)))
        await tx.optionSelectionSession.update({
          where: { id: session.id },
          data: { status: 'REVIEW', reviewedAt: new Date(), rowVersion: { increment: 1 } },
        });
    }
  }

  /**
   * 계약 품목과 그에 딸린 컨설팅 산출물을 물리 삭제한다.
   * 주문으로 물리화되지 않은 품목에만 쓴다 — 주문품목이 있으면 취소로 남겨야 한다.
   */
  private async deleteContractItemsDeep(tx: Prisma.TransactionClient, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const rentalSessionIds = (
      await tx.rentalSelectionSession.findMany({
        where: { contractItemId: { in: itemIds } },
        select: { id: true },
      })
    ).map((s) => s.id);
    if (rentalSessionIds.length > 0)
      await tx.rentalSelectionLine.deleteMany({ where: { sessionId: { in: rentalSessionIds } } });
    await tx.rentalSelectionSession.deleteMany({ where: { contractItemId: { in: itemIds } } });

    const optionSessionIds = (
      await tx.optionSelectionSession.findMany({
        where: { contractItemId: { in: itemIds } },
        select: { id: true },
      })
    ).map((s) => s.id);
    if (optionSessionIds.length > 0) {
      await tx.optionSelectionValue.deleteMany({ where: { selectionSessionId: { in: optionSessionIds } } });
      await tx.optionSelectionComponentAttr.deleteMany({
        where: { selectionSessionId: { in: optionSessionIds } },
      });
    }
    await tx.optionSelectionSession.deleteMany({ where: { contractItemId: { in: itemIds } } });
    await tx.contractItemComponent.deleteMany({ where: { contractItemId: { in: itemIds } } });
    await tx.contractItem.deleteMany({ where: { id: { in: itemIds } } });
  }

  /**
   * 계약완료 시 물리화 — 계약 품목(ContractItem)을 거래방식별 주문(Order)과 주문품목(OrderItem)으로 옮긴다.
   * 흐름: 계약(작성중) → 컨설팅 → 서명 → **계약완료(여기)** → 주문. 옵션 선택 결과는 ContractItem에
   * 남아 있고, OrderItem은 sourceContractItemId로 그 품목을 되짚어 작업지시서·엑셀이 옵션을 읽는다.
   *
   * 품목은 계약 소유이므로 수정하기(버전업)로 다시 완료해도 **같은 품목 = 같은 주문품목**이다.
   * 늘어난 품목만 주문품목이 새로 생기고, 취소된 품목의 주문품목만 취소된다.
   */
  private async syncOrders(
    tx: Prisma.TransactionClient,
    contractId: string,
    opts: {
      completionDueDate: Date | null;
      photoDate: Date | null;
      weddingDate: Date | null;
      cancelReason: string | null;
    },
    actorId: string,
  ): Promise<OrderSummary[]> {
    const items = await tx.contractItem.findMany({
      where: { contractId },
      include: { components: true },
      orderBy: { sequenceNo: 'asc' },
    });
    const neededTypes = new Set(items.filter((i) => i.status !== 'CANCELLED').map((i) => i.transactionType));

    const existingOrders = await tx.order.findMany({
      where: { contractId },
      include: { items: { include: { components: true } } },
    });
    type ExistingOrderItem = {
      id: string;
      status: string;
      sourceContractItemId: string;
      components: { id: string; componentType: string; sequenceNo: number; status: string }[];
    };
    const ordersByType = new Map<string, { id: string; orderNo: string; transactionType: string; items: ExistingOrderItem[] }>(
      existingOrders.map((o) => [o.transactionType, o]),
    );

    // 필요한 거래방식 주문 생성 (계약당 CUSTOM·RENTAL 각 최대 1건)
    for (const type of ['CUSTOM', 'RENTAL']) {
      if (!neededTypes.has(type) || ordersByType.has(type)) continue;
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

    // 이미 물리화된 주문품목을 계약 품목 기준으로 매핑
    const orderItemByContractItem = new Map<string, ExistingOrderItem>();
    for (const order of ordersByType.values()) {
      for (const it of order.items) orderItemByContractItem.set(it.sourceContractItemId, it);
    }

    for (const ci of items) {
      const order = ordersByType.get(ci.transactionType);
      if (!order) continue;
      const existing = orderItemByContractItem.get(ci.id);
      if (ci.status === 'CANCELLED') {
        // 안전핀: 계약 변경 경로로는 미진행(CREATED) 주문품목만 취소한다.
        // 진행 중 품목이 취소되는 경로는 없다 — 실물 정리는 오프라인 (현업 확정 2026-07-31).
        if (existing && existing.status === 'CREATED') {
          // 상태 갱신·이력은 단일 기록자(applyItemStatus)로 — 왜 취소됐는지 제작 이력에도 남는다.
          await applyItemStatus(tx, {
            orderItemId: existing.id,
            from: existing.status,
            to: 'CANCELLED',
            eventDate: todayAsDbDate(),
            notes: '계약 변경으로 품목 취소',
            cancelled: { reason: opts.cancelReason ?? '계약 변경' },
            actorId,
          });
          await tx.orderItem.update({
            where: { id: existing.id },
            data: { rowVersion: { increment: 1 } },
          });
          await tx.orderItemComponent.updateMany({
            where: { orderItemId: existing.id, status: 'CREATED' },
            data: { status: 'CANCELLED' },
          });
        }
        continue;
      }
      if (!existing) {
        await tx.orderItem.create({
          data: {
            id: randomUUID(),
            orderId: order.id,
            sourceContractItemId: ci.id,
            productCategory: ci.productCategory,
            sequenceNo: ci.sequenceNo,
            displayName: ci.displayName,
            status: 'CREATED',
            components: {
              create: ci.components
                .filter((c) => c.status !== 'CANCELLED')
                .map((c) => ({
                  id: randomUUID(),
                  componentType: c.componentType,
                  sequenceNo: c.sequenceNo,
                  status: 'CREATED',
                })),
            },
          },
        });
      } else if (existing.status !== 'CANCELLED') {
        // 수정하기(버전업)로 부위가 바뀐 경우(베스트 추가·제외) 재완료 시 구성품을 증분 반영한다.
        await this.syncOrderItemComponents(tx, existing, ci.components);
      }
    }

    return [...ordersByType.values()]
      .sort((a, b) => a.transactionType.localeCompare(b.transactionType))
      .map((o) => ({ id: o.id, orderNo: o.orderNo, tradeType: o.transactionType }));
  }

  /**
   * 기존 주문품목의 구성품을 계약 품목 부위에 증분 정합한다 (재완료 시점, 2026-07-30).
   * - 계약에 살아 있는 부위가 주문에 없으면 생성, 취소돼 있으면 되살린다 (베스트 추가)
   * - 계약에서 취소된 부위의 주문 구성품은 **미진행(CREATED)일 때만** 취소한다 (베스트 제외)
   *   — 입고·배정 등 진행이 시작된 구성품은 현장 판단 대상이라 자동으로 건드리지 않는다.
   */
  private async syncOrderItemComponents(
    tx: Prisma.TransactionClient,
    orderItem: {
      id: string;
      components: { id: string; componentType: string; sequenceNo: number; status: string }[];
    },
    contractComponents: { componentType: string; sequenceNo: number; status: string }[],
  ): Promise<void> {
    const activeContract = contractComponents.filter((c) => c.status !== 'CANCELLED');
    const matchOf = (type: string, seq: number) =>
      orderItem.components.find((oc) => oc.componentType === type && oc.sequenceNo === seq);

    for (const cc of activeContract) {
      const match = matchOf(cc.componentType, cc.sequenceNo);
      if (!match) {
        await tx.orderItemComponent.create({
          data: {
            id: randomUUID(),
            orderItemId: orderItem.id,
            componentType: cc.componentType,
            sequenceNo: cc.sequenceNo,
            status: 'CREATED',
          },
        });
      } else if (match.status === 'CANCELLED') {
        await tx.orderItemComponent.update({ where: { id: match.id }, data: { status: 'CREATED' } });
      }
    }

    for (const oc of orderItem.components) {
      const stillActive = activeContract.some(
        (cc) => cc.componentType === oc.componentType && cc.sequenceNo === oc.sequenceNo,
      );
      if (!stillActive && oc.status === 'CREATED')
        await tx.orderItemComponent.update({ where: { id: oc.id }, data: { status: 'CANCELLED' } });
    }
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

  /** 계약의 현재 옵션 선택값(옵션명·추가금액)을 모은다. (웹·엑셀 공통 소스, 설계서 03 §7.1) */
  private async loadContractOptions(
    contractId: string,
  ): Promise<Array<{ optionName: string; extraPrice: number }>> {
    const values = await this.prisma.optionSelectionValue.findMany({
      where: {
        selectionSession: {
          isCurrent: true,
          contractItem: { contractId },
        },
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
   * 컨설팅에서 베스트를 뺀 벌 — 계약서 옵션 목록에 "베스트 제외 — 정장 #2"로 싣는다
   * (현업 확정 2026-08-01). 금액은 없다 — 베스트 값은 계약서에서 수기로 조정한다.
   */
  private async loadVestExclusions(
    contractId: string,
  ): Promise<Array<{ optionName: string; extraPrice: number }>> {
    const items = await this.prisma.contractItem.findMany({
      where: {
        contractId,
        status: { not: 'CANCELLED' },
        components: { some: { componentType: 'VEST', status: 'CANCELLED' } },
      },
      select: { displayName: true },
      orderBy: [{ productCategory: 'asc' }, { sequenceNo: 'asc' }],
    });
    return items.map((i) => ({ optionName: `베스트 제외 — ${i.displayName}`, extraPrice: 0 }));
  }

  /**
   * 계약서 웹 표시용 품목 계층 — `거래방식|품목` → 주문품목(정장 #1·#2) → 부위 → 유료 옵션.
   *
   * - 부위 축: 맞춤은 옵션 부위 그룹(상의·하의·베스트), 렌탈은 주문품목 구성품을 쓴다.
   *   (스타일 컨설팅 화면과 같은 축이라 두 화면의 부위 목록이 어긋나지 않는다.)
   * - 옵션은 현재 선택 세션의 값 중 **추가금액 > 0** 인 것만 담는다 (v2 계약관리 요구).
   * - 부위 행은 유료 옵션이 없어도 항상 남긴다 (구성품 자체가 계약서 정보).
   * - 컨설팅에서 뺀 베스트도 "제외"로 남긴다 (현업 확정 2026-08-01) — 계약서가 베스트를
   *   다루지 않게 되면서, 3피스로 계약하고 2피스로 만든다는 사실이 여기서만 보인다.
   */
  private async loadContractOptionTree(contractId: string) {
    // 컨설팅은 계약 품목(ContractItem)에서 하므로 계약완료 전에도 계약서 옵션을 보여줄 수 있다.
    // 완료 후에는 이 품목이 주문품목으로 물리화되며, 주문번호는 그때 붙는다(sourceContractItem 되짚기).
    const items = await this.prisma.contractItem.findMany({
      where: { contractId, status: { not: 'CANCELLED' } },
      include: {
        components: {
          // 취소된 부위도 가져온다 — 베스트 제외를 계약서에 적어야 한다(아래 excluded).
          orderBy: [{ componentType: 'asc' }, { sequenceNo: 'asc' }],
          select: { componentType: true, status: true },
        },
        orderItems: {
          where: { status: { not: 'CANCELLED' } },
          select: { order: { select: { orderNo: true } } },
        },
      },
      orderBy: [{ productCategory: 'asc' }, { sequenceNo: 'asc' }],
    });

    const tree = new Map<string, ContractDocumentItem[]>();
    if (items.length === 0) return tree;

    const values = await this.prisma.optionSelectionValue.findMany({
      where: {
        selectionSession: {
          isCurrent: true,
          contractItem: { contractId },
        },
        extraPriceSnapshot: { gt: 0 },
      },
      include: {
        optionChoice: { select: { choiceName: true } },
        optionStage: { select: { componentGroup: true, stageName: true, sequenceNo: true } },
        selectionSession: { select: { contractItemId: true } },
      },
      orderBy: [{ optionStage: { sequenceNo: 'asc' } }],
    });
    const valuesByItem = new Map<string, typeof values>();
    for (const v of values) {
      const list = valuesByItem.get(v.selectionSession.contractItemId) ?? [];
      list.push(v);
      valuesByItem.set(v.selectionSession.contractItemId, list);
    }

    for (const item of items) {
      // 취소된 부위(= 컨설팅에서 뺀 베스트)도 행으로 남겨 "제외"로 표시한다 (2026-08-01).
      const excludedTypes = new Set(
        item.components.filter((c) => c.status === 'CANCELLED').map((c) => c.componentType),
      );
      const groupCodes =
        item.transactionType === 'RENTAL'
          ? item.components.map((c) => c.componentType)
          : componentGroupsFor(item.productCategory);
      const components = (groupCodes.length > 0 ? groupCodes : [item.productCategory]).map(
        (group) => ({
          group,
          groupLabel: COMPONENT_GROUP_LABELS[group] ?? COMPONENT_LABEL[group] ?? group,
          excluded: excludedTypes.has(group),
          options: [] as Array<{ stageName: string; optionName: string; extraPrice: number }>,
        }),
      );

      for (const v of valuesByItem.get(item.id) ?? []) {
        const group = v.optionStage.componentGroup;
        let target = components.find((c) => c.group === group);
        if (!target && group) {
          // 부위가 지정된 단계인데 부위 행이 없다(부위 행 자체가 없는 구버전 품목 등).
          // '공통'으로 뭉개지 말고 제 부위 라벨로 행을 만든다.
          target = {
            group,
            groupLabel: COMPONENT_GROUP_LABELS[group] ?? COMPONENT_LABEL[group] ?? group,
            excluded: false,
            options: [],
          };
          components.push(target);
        }
        if (!target) {
          // 부위 미지정 단계(단일 부위 세트·구버전)는 부위가 하나면 그 부위, 아니면 '공통'으로 모은다.
          target = components.length === 1 ? components[0] : components.find((c) => c.group === 'COMMON');
          if (!target) {
            target = { group: 'COMMON', groupLabel: '공통', excluded: false, options: [] };
            components.push(target);
          }
        }
        target.options.push({
          stageName: v.optionStage.stageName,
          optionName: v.optionChoice.choiceName,
          extraPrice: Number(v.extraPriceSnapshot),
        });
      }

      // 라인이 같은 카테고리로 둘 이상이면(정장 2줄) 카테고리 키로만 묶을 때 두 라인이
      // 서로의 벌까지 그려 표가 겹쳐 보인다. 벌은 자기 라인을 알고 있으니 그 키로 묶고,
      // 라인 참조가 끊긴 구버전 품목만 카테고리 키에 남긴다.
      const key = item.sourceContractLineId
        ? `line:${item.sourceContractLineId}`
        : `${item.transactionType}|${item.productCategory}`;
      const list = tree.get(key) ?? [];
      list.push({
        contractItemId: item.id,
        orderNo: item.orderItems[0]?.order.orderNo ?? null,
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

  /**
   * 계약서 라인 저장값. 베스트는 여기서 다루지 않는다 (현업 확정 2026-08-01) —
   * 정장은 상의·하의·베스트가 한 벌이고, 뺄지 말지는 스타일 컨설팅이 벌마다 정한다.
   */
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

// 날짜 헬퍼는 common/date.ts가 단일 출처다.

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
