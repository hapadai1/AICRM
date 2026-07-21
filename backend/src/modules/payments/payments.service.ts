import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  CancelPaymentDto,
  CreatePaymentDto,
  PaymentListQueryDto,
  UpdatePaymentScheduleDto,
} from './payments.dto';

interface PaymentView {
  id: string;
  contractId: string;
  paymentType: string;
  amount: number;
  paymentDate: string;
  paymentMethod: string | null;
  status: string;
  memo: string | null;
  createdBy: string;
  createdAt: Date;
}

/** 결제 목록·등록·취소 공통 요약 (연동정합화 계약 §4) */
interface PaymentSummary {
  contractNo: string;
  customerName: string;
  contractTypeName: string | null;
  contractAmount: number;
  paidAmount: number;
  /** @deprecated paidAmount와 동일 값 — 기존 화면 하위호환 필드 */
  collectedAmount: number;
  balanceAmount: number;
  balanceDueDate: string | null;
}

/** 뷰 변환 입력 (Prisma 결제 레코드) */
interface PaymentRecord {
  id: string;
  contractId: string;
  paymentType: string;
  amount: unknown;
  paymentDate: Date;
  paymentMethod: string | null;
  status: string;
  memo: string | null;
  createdBy: string;
  createdAt: Date;
}

/** 결제 목록 행 — 결제 자체로 "누가·언제·어느 계약" 이 읽히도록 고객·계약을 함께 싣는다 */
interface PaymentListRow extends PaymentView {
  contractNo: string;
  contractTypeName: string | null;
  customerId: string;
  customerName: string;
  customerPhone: string;
}

/** 목록 합계 — 현재 필터 전체 기준, COMPLETED만 집계 (개편계획 05 §3.1) */
interface PaymentTotals {
  count: number;
  paidAmount: number;
  refundAmount: number;
  netAmount: number;
}

/** 계약 조회 결과 (요약 계산에 필요한 필드 포함) */
const CONTRACT_INCLUDE = {
  currentVersion: { select: { totalAmount: true } },
  customer: { select: { name: true } },
  contractType: { select: { name: true } },
} as const;

/** 목록 행에 고객·계약 정보를 채우기 위한 include */
const LIST_INCLUDE = {
  contract: {
    select: {
      contractNo: true,
      customer: { select: { id: true, name: true, phone: true } },
      contractType: { select: { name: true } },
    },
  },
} as const;

function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 결제 통합 검색 (개편계획 05 §3.1).
   * 결제일 범위·고객·계약번호로 결제를 가로로 조회하고, 필터 전체 기준 합계를 함께 반환한다.
   */
  async search(query: PaymentListQueryDto) {
    const where = this.buildListWhere(query);
    const [rows, totalElements] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return new Paginated<PaymentListRow>(
      rows.map((row) => this.toListRow(row)),
      query.page,
      query.size,
      totalElements,
      { totals: await this.buildTotals(where, query) },
    );
  }

  /** 결제 목록 + 요약(계약·고객·수금액·잔액·잔금 예정일). 수금액은 COMPLETED 결제 합계다. */
  async listByContract(contractId: string): Promise<{ payments: PaymentView[]; summary: PaymentSummary }> {
    const contract = await this.findContract(contractId);
    const payments = await this.prisma.payment.findMany({
      where: { contractId },
      orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
    });
    return {
      payments: payments.map((p) => this.toView(p)),
      summary: await this.buildSummary(contract),
    };
  }

  /**
   * 결제 수기 등록. 계약금액 초과 수금은 저장을 허용하되 응답에 경고를 담는다.
   * paymentType OTHER는 ETC로 통합 저장하고, payerName은 memo에 병합한다.
   */
  async create(contractId: string, dto: CreatePaymentDto, actor: AuthUser) {
    const contract = await this.findContract(contractId);
    const payment = await this.prisma.payment.create({
      data: {
        id: randomUUID(),
        contractId,
        paymentType: dto.paymentType === 'OTHER' ? 'ETC' : dto.paymentType,
        amount: dto.amount,
        paymentDate: new Date(dto.paymentDate),
        paymentMethod: dto.paymentMethod ?? null,
        status: dto.status ?? 'COMPLETED',
        memo: this.mergeMemo(dto.memo, dto.payerName),
        createdBy: actor.id,
      },
    });

    const view = this.toView(payment);
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'PAYMENT',
      entityId: payment.id,
      after: view,
    });

    const summary = await this.buildSummary(contract);
    const warning =
      summary.contractAmount > 0 && summary.paidAmount > summary.contractAmount
        ? {
            code: 'OVER_COLLECTION',
            message: '수금액이 계약금액을 초과했습니다.',
            contractAmount: summary.contractAmount,
            collectedAmount: summary.paidAmount,
          }
        : null;

    return { payment: view, summary, ...(warning ? { warning } : {}) };
  }

  /** 결제 취소: 레코드를 삭제하지 않고 status=CANCELLED로 전환하며 사유를 남긴다. */
  async cancel(paymentId: string, dto: CancelPaymentDto, actor: AuthUser) {
    const before = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!before) throw new NotFoundException('결제 내역이 없습니다.');
    if (before.status === 'CANCELLED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 취소된 결제입니다.');

    const cancelled = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'CANCELLED' },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CANCEL',
      entityType: 'PAYMENT',
      entityId: paymentId,
      before: this.toView(before),
      after: this.toView(cancelled),
      reason: dto.reason,
    });

    const contract = await this.findContract(before.contractId);
    return {
      payment: this.toView(cancelled),
      summary: await this.buildSummary(contract),
    };
  }

  /** PATCH /contracts/:id/payment-schedule — 잔금 결제 예정일 설정·해제 (감사로그 기록) */
  async updateSchedule(contractId: string, dto: UpdatePaymentScheduleDto, actor: AuthUser) {
    const contract = await this.findContract(contractId);
    const balanceDueDate = dto.balanceDueDate ? new Date(dto.balanceDueDate) : null;

    const updated = await this.prisma.contract.update({
      where: { id: contractId },
      data: { balanceDueDate },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'CONTRACT',
      entityId: contractId,
      before: { balanceDueDate: contract.balanceDueDate ? toDateString(contract.balanceDueDate) : null },
      after: { balanceDueDate: updated.balanceDueDate ? toDateString(updated.balanceDueDate) : null },
      reason: '잔금 결제 예정일 변경',
    });

    return {
      contractId,
      balanceDueDate: updated.balanceDueDate ? toDateString(updated.balanceDueDate) : null,
    };
  }

  /** 목록 검색 조건. 계약 하위 조건은 키 충돌을 피하려고 AND 배열에 쌓는다. */
  private buildListWhere(query: PaymentListQueryDto): Prisma.PaymentWhereInput {
    const and: Prisma.PaymentWhereInput[] = [];

    if (query.customerId) and.push({ contract: { customerId: query.customerId } });

    const keyword = query.q?.trim();
    if (keyword) {
      // 전화번호는 하이픈 없이 저장(customers.phone_normalized)되므로 숫자만 남겨 비교한다.
      const digits = keyword.replace(/\D/g, '');
      and.push({
        OR: [
          { contract: { contractNo: { contains: keyword, mode: 'insensitive' } } },
          { contract: { customer: { name: { contains: keyword, mode: 'insensitive' } } } },
          ...(digits ? [{ contract: { customer: { phoneNormalized: { contains: digits } } } }] : []),
        ],
      });
    }

    return {
      ...(query.contractId ? { contractId: query.contractId } : {}),
      ...(query.paymentType
        ? { paymentType: query.paymentType === 'OTHER' ? 'ETC' : query.paymentType }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            paymentDate: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(and.length > 0 ? { AND: and } : {}),
    };
  }

  /** 필터 전체 기준 합계. COMPLETED만 집계하고 REFUND는 분리한다. */
  private async buildTotals(
    where: Prisma.PaymentWhereInput,
    query: PaymentListQueryDto,
  ): Promise<PaymentTotals> {
    const empty = { count: 0, paidAmount: 0, refundAmount: 0, netAmount: 0 };
    // 취소분만 조회 중이면 집계 대상이 없다.
    if (query.status && query.status !== 'COMPLETED') return empty;

    const grouped = await this.prisma.payment.groupBy({
      by: ['paymentType'],
      where: { ...where, status: 'COMPLETED' },
      _sum: { amount: true },
      _count: { _all: true },
    });

    return grouped.reduce((acc, g) => {
      const amount = Number(g._sum.amount ?? 0);
      acc.count += g._count._all;
      if (g.paymentType === 'REFUND') acc.refundAmount += amount;
      else acc.paidAmount += amount;
      acc.netAmount = acc.paidAmount - acc.refundAmount;
      return acc;
    }, empty);
  }

  private toListRow(
    row: PaymentRecord & {
      contract: {
        contractNo: string;
        customer: { id: string; name: string; phone: string };
        contractType: { name: string } | null;
      };
    },
  ): PaymentListRow {
    return {
      ...this.toView(row),
      contractNo: row.contract.contractNo,
      contractTypeName: row.contract.contractType?.name ?? null,
      customerId: row.contract.customer.id,
      customerName: row.contract.customer.name,
      customerPhone: row.contract.customer.phone,
    };
  }

  private async findContract(contractId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: CONTRACT_INCLUDE,
    });
    if (!contract) throw new NotFoundException('계약이 없습니다.');
    return contract;
  }

  private async buildSummary(contract: {
    id: string;
    contractNo: string;
    balanceDueDate: Date | null;
    currentVersion: { totalAmount: unknown } | null;
    customer: { name: string };
    contractType: { name: string } | null;
  }): Promise<PaymentSummary> {
    const contractAmount = Number(contract.currentVersion?.totalAmount ?? 0);
    const sum = await this.prisma.payment.aggregate({
      where: { contractId: contract.id, status: 'COMPLETED' },
      _sum: { amount: true },
    });
    const paidAmount = Number(sum._sum.amount ?? 0);
    return {
      contractNo: contract.contractNo,
      customerName: contract.customer.name,
      contractTypeName: contract.contractType?.name ?? null,
      contractAmount,
      paidAmount,
      collectedAmount: paidAmount,
      balanceAmount: contractAmount - paidAmount,
      balanceDueDate: contract.balanceDueDate ? toDateString(contract.balanceDueDate) : null,
    };
  }

  /** payerName을 memo에 "입금자: {payerName}" 형태로 병합한다. */
  private mergeMemo(memo: string | undefined, payerName: string | undefined): string | null {
    const parts: string[] = [];
    if (payerName) parts.push(`입금자: ${payerName}`);
    if (memo) parts.push(memo);
    return parts.length > 0 ? parts.join(' / ') : null;
  }

  private toView(payment: PaymentRecord): PaymentView {
    return {
      id: payment.id,
      contractId: payment.contractId,
      paymentType: payment.paymentType,
      amount: Number(payment.amount),
      paymentDate: toDateString(payment.paymentDate),
      paymentMethod: payment.paymentMethod,
      status: payment.status,
      memo: payment.memo,
      createdBy: payment.createdBy,
      createdAt: payment.createdAt,
    };
  }
}
