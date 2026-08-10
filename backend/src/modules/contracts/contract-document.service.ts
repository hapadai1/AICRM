import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FilesService } from '../files/files.service';
import { COMPONENT_GROUP_LABELS, componentGroupsFor } from '../options/option-component-groups';
import { buildContractExcel, ContractExcelLine } from './contract-excel';
import {
  CATEGORY_LABEL,
  COMPONENT_LABEL,
  componentLabels,
  ContractDocumentItem,
  DETAIL_INCLUDE,
  sortDocumentLines,
} from './contracts.shared';

/**
 * 계약서 문서 축 (2026-08-05 contracts.service에서 분리).
 * 상세 조회·웹 계약서 JSON·엑셀 생성 — 계약을 "읽어서 보여주는" 책임만 갖는다.
 */
@Injectable()
export class ContractDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  async getDetail(id: string) {
    const contract = await this.prisma.contract.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!contract) throw new NotFoundException('계약이 없습니다.');
    return contract;
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
}
