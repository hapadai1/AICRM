import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { ContractLineDto } from './contracts.dto';

/**
 * 계약 도메인 공용 상수·헬퍼 (2026-08-05 분리).
 *
 * contracts.service 한 파일이 계약 CRUD·버전·서명·물리화·품목 동기화·문서 출력을
 * 전부 안고 2,400줄이 되어, 책임 단위(materialize·items·document·versions)로 잘랐다.
 * 여기는 그 서비스들이 **함께 쓰는** 순수 헬퍼만 둔다 — 상태를 갖지 않고 tx/prisma를 받는다.
 */

/**
 * 품목 대분류 → 기본 구성품 (설계서 7.2).
 * 정장은 맞춤·렌탈 가리지 않고 상의·하의·베스트 세 부위로 만든다 (현업 확정 2026-08-01).
 */
export const COMPONENT_MAP: Record<string, string[]> = {
  SUIT: ['JACKET', 'TROUSERS', 'VEST'],
  SHIRT: ['SHIRT'],
  SHOES: ['SHOES'],
};

/** 계약서 엑셀 MIME (파일 저장·스트리밍 공용) */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const CATEGORY_LABEL: Record<string, string> = {
  SUIT: '정장',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/** 구성품(부위) 한글 라벨 (설계서 03 §5.3) */
export const COMPONENT_LABEL: Record<string, string> = {
  JACKET: '상의',
  TROUSERS: '하의',
  VEST: '베스트',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/**
 * 계약서 출력 품목 순서: 맞춤(정장>셔츠>구두) → 렌탈(정장>셔츠>구두).
 * 저장 순서(sortOrder)와 무관하게 출력물(웹 계약서·엑셀)에서는 항상 이 순서로 싣는다.
 */
const TRANSACTION_ORDER: Record<string, number> = { CUSTOM: 0, RENTAL: 1 };
const CATEGORY_ORDER: Record<string, number> = { SUIT: 0, SHIRT: 1, SHOES: 2 };

export function sortDocumentLines<T extends { transactionType: string; productCategory: string }>(
  lines: readonly T[],
): T[] {
  return [...lines].sort(
    (a, b) =>
      (TRANSACTION_ORDER[a.transactionType] ?? 99) - (TRANSACTION_ORDER[b.transactionType] ?? 99) ||
      (CATEGORY_ORDER[a.productCategory] ?? 99) - (CATEGORY_ORDER[b.productCategory] ?? 99),
  );
}

/** 계약서 웹 표시용 주문품목 계층 (품목 → 부위 → 유료 옵션) */
export interface ContractDocumentItem {
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

export const VERSION_INCLUDE = {
  lines: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ContractVersionInclude;

export const DETAIL_INCLUDE = {
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

export type OrderSummary = { id: string; orderNo: string; tradeType: string };

export async function getContractOrThrow(prisma: PrismaService, id: string) {
  const contract = await prisma.contract.findUnique({
    where: { id },
    include: { customer: true },
  });
  if (!contract) throw new NotFoundException('계약이 없습니다.');
  return contract;
}

export function assertVersionMatch(current: number, expected?: number): void {
  if (expected !== undefined && expected !== current)
    throw new BusinessException(
      'CONTRACT_VERSION_CONFLICT',
      '다른 사용자가 계약을 변경했습니다. 최신 데이터를 다시 조회해 주세요.',
      [{ field: 'version', reason: 'STALE_VALUE' }],
      { expectedVersion: current },
    );
}

/** row_version 조건부 갱신. 트랜잭션 중 경합 시에도 충돌을 감지한다. */
export async function updateContractGuarded(
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

/** CTR-YYMMDD-### / ORD-YYMMDD-### 일별 시퀀스 채번 (트랜잭션 내 호출) */
export async function nextNo(tx: Prisma.TransactionClient, kind: 'CTR' | 'ORD'): Promise<string> {
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
 * 계약서 라인 저장값. 베스트는 여기서 다루지 않는다 (현업 확정 2026-08-01) —
 * 정장은 상의·하의·베스트가 한 벌이고, 뺄지 말지는 스타일 컨설팅이 벌마다 정한다.
 */
export function toLineData(line: ContractLineDto, index: number) {
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

/** 감사로그 품목 요약의 입력 — 저장된 행(Decimal)과 요청 DTO(number)를 모두 받는다. */
export interface ContractLineSummarySource {
  productCategory: string;
  itemDescription?: string | null;
  quantity: number;
  lineAmount?: unknown;
}

/**
 * 계약 품목 1행을 감사로그용 한 줄로 압축한다.
 * 품목별 감사 이벤트를 따로 만들지 않고, 이 문자열 배열의 전/후 차이로 "무엇이 어떻게 바뀌었는지"를 읽게 한다.
 */
export function lineSummary(line: ContractLineSummarySource): string {
  const name = line.itemDescription?.trim() || CATEGORY_LABEL[line.productCategory] || line.productCategory;
  const amount = Number(line.lineAmount ?? 0);
  return `${name} ${line.quantity}개 ${amount.toLocaleString('ko-KR')}원`;
}

/** 대분류의 기본 구성품을 한글 세부품목 라벨로 (설계서 03 §5.3). */
export function componentLabels(productCategory: string): string[] {
  const components = COMPONENT_MAP[productCategory] ?? [productCategory];
  return components.map((c) => COMPONENT_LABEL[c] ?? c);
}

/** 서명 이미지 디코드 버퍼 상한 (설계서 03 §2.3) */
const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;

/** PNG dataURL → Buffer. PNG 형식·용량(2MB) 검증 (설계서 03 §2.3). */
export function decodeSignaturePng(dataUrl: string): Buffer {
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
export function asAuditClient(tx: Prisma.TransactionClient): Pick<PrismaService, 'auditLog'> {
  return tx as unknown as Pick<PrismaService, 'auditLog'>;
}
