import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { toDateOrNull as toDate } from '../../common/date';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FilesService } from '../files/files.service';
import { ContractDocumentService } from './contract-document.service';
import { ContractItemsService } from './contract-items.service';
import { ContractMaterializeService } from './contract-materialize.service';
import { CompleteContractDto, ContractLineDto, CreateRevisionDto, SaveSignatureDto } from './contracts.dto';
import {
  asAuditClient,
  assertVersionMatch,
  decodeSignaturePng,
  getContractOrThrow,
  lineSummary,
  toLineData,
  updateContractGuarded,
  VERSION_INCLUDE,
  XLSX_MIME,
} from './contracts.shared';

/**
 * 계약 버전·서명·완료 (2026-08-05 contracts.service에서 분리).
 * 계약서 문서의 생애주기 — 수정하기(버전업), 전자서명, 계약완료(물리화 트리거)를 담당한다.
 */
@Injectable()
export class ContractVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly materialize: ContractMaterializeService,
    private readonly items: ContractItemsService,
    private readonly document: ContractDocumentService,
  ) {}

  /**
   * 완료된 계약을 다시 고친다 — 계약서 스냅샷만 새 버전으로 복사하고 상태를 작성중으로 되돌린다.
   *
   * **계약이 변경된 것이고 취소·재계약이 아니다.** 품목은 계약 소유이므로 여기서 건드리지 않는다
   * → 컨설팅 선택·주문·주문품목·작업지시서·입출고·채촌이 그대로 이어진다. 수량을 실제로 바꾸면
   * 이후 임시저장(update)에서 syncContractItems 가 **차이만** 반영한다(늘어난 것만 새 품목).
   * 서명은 복사하지 않는다 — 고친 계약서에는 다시 서명을 받아야 한다.
   */
  async createRevision(id: string, dto: CreateRevisionDto, actor: AuthUser) {
    const contract = await getContractOrThrow(this.prisma, id);
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
          lines: { create: lines.map((l, i) => toLineData(l, i)) },
        },
        include: VERSION_INCLUDE,
      });
      // 품목은 계약 소유라 손대지 않는다 — 새 버전 라인으로 참조만 다시 걸고 수량 차이를 반영한다.
      await this.items.syncContractItems(tx, id, created.id, dto.changeReason ?? null);
      // 이어지는 컨설팅 옵션 추가금액을 새 버전에도 롤업 라인으로 반영한다.
      await this.items.syncOptionRollupLine(tx, id, created.id);
      // 수정 중에는 계약서를 다시 작성하는 상태다 → 작성중으로 되돌리고 이 버전을 현재로 잡는다.
      await updateContractGuarded(tx, id, contract.rowVersion, {
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

  /**
   * 계약 완료 — 계약이 성립하는 시점 (현업 확정 2026-07-30).
   *
   * 서명완료 계약만 완료할 수 있다. 여기서 서명한 버전을 확정본으로 굳히고,
   * 주문·주문품목·고객 전환·진행단계를 한 트랜잭션으로 물리화한다(physicalizeOnComplete).
   * 완료 시점의 계약서 엑셀을 구워 버전에 보관한다(설계서 03 M3) — 이후 다운로드는 보관본.
   */
  async complete(id: string, dto: CompleteContractDto, actor: AuthUser) {
    const contract = await getContractOrThrow(this.prisma, id);
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
    const { buffer, fileName } = await this.document.buildContractDocumentExcel(id, actor, { audit: false });
    const file = await this.files.saveBuffer(
      { buffer, mimeType: XLSX_MIME, originalName: fileName },
      actor,
    );

    const completedAt = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const { orders, customerStatus } = await this.materialize.physicalizeOnComplete(
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
      await updateContractGuarded(tx, id, dto.version ?? contract.rowVersion, {
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
    const contract = await getContractOrThrow(this.prisma, id);
    const version = await this.prisma.contractVersion.findUnique({ where: { id: versionId } });
    if (!version || version.contractId !== id) throw new NotFoundException('계약 버전이 없습니다.');
    await this.assertSignable(contract, version);
    assertVersionMatch(contract.rowVersion, dto.version);

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
      await updateContractGuarded(tx, id, contract.rowVersion, { status: 'SIGNED' });
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
    const contract = await getContractOrThrow(this.prisma, id);
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
        await updateContractGuarded(tx, id, contract.rowVersion, { status: 'DRAFT' });
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

    const consulting = await this.items.consultingReadiness(contract.id);
    if (!consulting.ready)
      throw new BusinessException(
        'CONSULTING_NOT_CONFIRMED',
        '스타일 컨설팅을 모든 품목에 대해 확정한 뒤 서명할 수 있습니다.',
        undefined,
        { pending: consulting.pending },
      );
  }
}
