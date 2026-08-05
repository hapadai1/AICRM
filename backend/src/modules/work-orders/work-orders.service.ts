import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { Response } from 'express';
import { createReadStream, existsSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { BusinessException } from '../../common/business.exception';
import { toDateOnlyString as toDateString } from '../../common/date';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FilesService, UploadedMulterFile } from '../files/files.service';
import { MEASUREMENT_ITEM_MAP } from '../measurements/measurement-catalog';
import { syncPrepStatuses } from '../production/prep-status';
import {
  buildShoesWorkOrderExcel,
  buildWorkOrderExcel,
  buildWorkOrderPreviewHtml,
  renderStoredWorkOrderHtml,
  type WorkOrderExcelData,
} from './work-order-excel';
import { canChangeWorkOrderMeasurement, resolveWorkOrderStatus } from './work-order-status';
import {
  IssueWorkOrderVersionDto,
  WORK_ORDER_LIST_STATUSES,
  WorkOrderListQueryDto,
  WorkOrderListStatus,
} from './work-orders.dto';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 품목 1건에 대해 판정·스냅샷에 필요한 원본을 한 번에 로드하는 include */
const orderItemInclude = Prisma.validator<Prisma.OrderItemInclude>()({
  order: { include: { contract: { include: { customer: true } } } },
  // 옵션 세션은 ContractItem에 붙는다 → 확정 후 되짚기(REACH-BACK): sourceContractItem 경유.
  sourceContractItem: {
    include: {
      optionSelectionSessions: {
        where: { isCurrent: true, status: 'CONFIRMED' },
        orderBy: { selectionVersionNo: Prisma.SortOrder.desc },
        take: 1,
        include: {
          values: {
            include: { optionStage: true, optionChoice: true },
            orderBy: { optionStage: { sequenceNo: Prisma.SortOrder.asc } },
          },
          // 부위별 원단·컬러·패턴 (v2 D3 / 설계서 04 §2.5)
          componentAttrs: true,
        },
      },
    },
  },
  measurementLinks: {
    where: { isCurrent: true },
    orderBy: { linkedAt: Prisma.SortOrder.desc },
    take: 1,
    include: {
      measurementSession: {
        include: {
          values: {
            orderBy: [{ sortOrder: Prisma.SortOrder.asc }, { measurementCode: Prisma.SortOrder.asc }],
          },
        },
      },
    },
  },
  workOrder: { include: { outputFile: true, uploadedFile: true, issuedByUser: true } },
  // 작업지시서 양식의 상의/하의/조끼 벌수·가봉일 칸을 채우는 원본.
  // 베스트 제외로 취소된 구성품이 조끼 벌수에 섞이면 안 된다 (2026-07-30).
  components: { where: { active: true, status: { not: 'CANCELLED' } } },
  fittingSessions: { orderBy: { fittingDate: Prisma.SortOrder.desc }, take: 1 },
});

type OrderItemWithSources = Prisma.OrderItemGetPayload<{ include: typeof orderItemInclude }>;
type ConfirmedOptionSession =
  OrderItemWithSources['sourceContractItem']['optionSelectionSessions'][number];
type MeasurementSessionWithValues =
  OrderItemWithSources['measurementLinks'][number]['measurementSession'];

// toDateString은 common/date.ts의 toDateOnlyString을 쓴다.

/** 작업지시서 양식의 상의/하의/조끼 '벌' 칸 (구성품 타입별 개수) */
function countComponents(components: Array<{ componentType: string }>): {
  jacket: number;
  trousers: number;
  vest: number;
} {
  const count = (type: string) => components.filter((c) => c.componentType === type).length;
  return { jacket: count('JACKET'), trousers: count('TROUSERS'), vest: count('VEST') };
}

@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  // ---------------------------------------------------------------------------
  // 목록·상세·이력
  // ---------------------------------------------------------------------------

  /** WO-001: 품목별 작업지시서 상태 목록 (미주문/재출력 필요/최신) */
  async list(query: WorkOrderListQueryDto): Promise<Paginated<unknown>> {
    const requested = (query.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = requested.filter(
      (s) => !WORK_ORDER_LIST_STATUSES.includes(s as WorkOrderListStatus),
    );
    if (invalid.length > 0) {
      throw new BusinessException('VALIDATION_ERROR', '지원하지 않는 상태 필터입니다.', [
        { field: 'status', reason: `허용 값: ${WORK_ORDER_LIST_STATUSES.join(', ')}` },
      ]);
    }

    // 대상: 작업지시서가 이미 있거나, 현재 옵션 세션이 CONFIRMED인 맞춤 품목
    const items = await this.prisma.orderItem.findMany({
      where: {
        status: { not: 'CANCELLED' },
        OR: [
          { workOrder: { isNot: null } },
          {
            sourceContractItem: {
              optionSelectionSessions: { some: { isCurrent: true, status: 'CONFIRMED' } },
            },
          },
        ],
      },
      include: orderItemInclude,
      orderBy: { createdAt: 'asc' },
    });

    const rows = items
      .map((item) => this.toListRow(item))
      .filter((row) => requested.length === 0 || requested.includes(row.status));
    return new Paginated(rows.slice(query.skip, query.skip + query.size), query.page, query.size, rows.length);
  }

  /** WO-001: 작업지시서 상세 */
  async detail(workOrderId: string) {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      include: {
        outputFile: true,
        uploadedFile: true,
        issuedByUser: true,
        orderItem: { include: orderItemInclude },
      },
    });
    if (!workOrder) {
      throw new BusinessException('NOT_FOUND', '작업지시서를 찾을 수 없습니다.');
    }
    return {
      ...this.toListRow(workOrder.orderItem),
      workOrderId: workOrder.id,
      createdAt: workOrder.createdAt.toISOString(),
      docStatus: workOrder.status,
      issuedAt: workOrder.issuedAt?.toISOString() ?? null,
      issuedByName: workOrder.issuedByUser?.displayName ?? null,
      fileName: workOrder.uploadedFile?.originalName ?? workOrder.outputFile?.originalName ?? null,
      uploadedFileName: workOrder.uploadedFile?.originalName ?? null,
    };
  }

  /*
    출력 이력(버전 목록)은 없앴다 (현업 확정 2026-08-05) — 작업지시서는 품목당 파일 하나이고
    다시 뽑으면 덮어쓴다. 누가 언제 뽑았는지는 감사로그(EXPORT)에 남는다.
  */

  // ---------------------------------------------------------------------------
  // 미리보기
  // ---------------------------------------------------------------------------

  /**
   * WO-002: 확정 옵션·채촌 표 데이터. 옵션 확정 전제 미충족 시 422.
   *
   * measurementSessionId를 주면 연결된 채촌 대신 해당 버전으로 미리본다(출력 API와 동일 규칙).
   * 화면의 채촌 버전 선택을 위해 같은 고객의 채촌 후보 목록도 함께 내려준다.
   */
  async preview(orderItemId: string, measurementSessionId?: string) {
    const item = await this.loadOrderItem(orderItemId);
    // 연결이 없어도 쓸 채촌이 있으면(완료 채촌 1건 이상) 전제 미충족으로 보지 않는다.
    const { session, measurementSession: linkedSession, link } = this.requirePrerequisites(item, {
      measurementOptional: await this.hasUsableMeasurement(item, measurementSessionId),
    });
    // 연결이 없으면 그 고객의 가장 최근 완료 채촌을 기본으로 보여 준다.
    // 조회 단계에서는 연결을 만들지 않는다 — 실제 확정은 출력(issue) 때 한다.
    const measurementSession = await this.resolveWorkOrderMeasurement(
      item,
      linkedSession,
      measurementSessionId,
    );
    const wo = item.workOrder ?? null;

    // 채촌 교체 후보: 같은 고객의 모든 채촌 (최근 채촌일부터)
    const candidates = await this.prisma.measurementSession.findMany({
      where: { customerId: item.order.contract.customer.id },
      orderBy: [{ measurementDate: 'desc' }, { versionNo: 'desc' }],
      select: {
        id: true,
        versionNo: true,
        measurementDate: true,
        measurementType: true,
        _count: { select: { values: true } },
      },
    });

    return {
      orderItemId: item.id,
      workOrderId: item.workOrder?.id ?? null,
      customerId: item.order.contract.customer.id,
      customerName: item.order.contract.customer.name,
      orderId: item.order.id,
      orderNo: item.order.orderNo,
      itemLabel: item.displayName,
      productCategory: item.productCategory,
      sequenceNo: item.sequenceNo,
      fabricName: session.fabricName,
      option: this.buildOptionSnapshot(session),
      measurement: measurementSession
        ? {
            ...this.buildMeasurementSnapshot(measurementSession),
            // linkedAt은 "품목에 연결된" 채촌일 때만 의미가 있다.
            linkedAt:
              link && measurementSession.id === link.measurementSessionId
                ? link.linkedAt.toISOString()
                : null,
            isLinked: !!link && measurementSession.id === link.measurementSessionId,
          }
        : null,
      measurementCandidates: candidates.map((c) => ({
        measurementSessionId: c.id,
        versionNo: c.versionNo,
        measurementDate: toDateString(c.measurementDate),
        measurementType: c.measurementType,
        completed: c._count.values > 0,
        isLinked: !!link && c.id === link.measurementSessionId,
      })),
      // 연결 없이 최신 채촌으로 자동 선택된 상태인지 — 화면 문구를 가르는 값이다.
      measurementAutoSelected: !link && measurementSession != null,
      // 작업요청(제작 착수) 뒤에는 채촌을 바꿀 수 없다 (현업 확정 2026-08-03).
      canChangeMeasurement: canChangeWorkOrderMeasurement(item.status),
      docStatus: wo?.status ?? 'DRAFT',
      fileName: wo?.uploadedFile?.originalName ?? wo?.outputFile?.originalName ?? null,
      uploadedFileName: wo?.uploadedFile?.originalName ?? null,
      lastIssuedAt: wo?.issuedAt?.toISOString() ?? null,
      status: resolveWorkOrderStatus(session, link, !!wo?.outputFile),
      /*
        정식 출력 가능 판정 — 옵션 확정 + **값이 든 채촌**.
        채촌의 '완료' 표시는 걷어냈다(2026-08-05). 상태 대신 내용으로 가른다:
        값이 하나도 없는 빈 채촌이 최신이라고 그대로 공장에 나가면 안 된다.
      */
      optionConfirmed: session.status === 'CONFIRMED',
      measurementCompleted: !!measurementSession && measurementSession.values.length > 0,
      printable:
        session.status === 'CONFIRMED' && !!measurementSession && measurementSession.values.length > 0,
    };
  }

  // ---------------------------------------------------------------------------
  // 양식 미리보기 (HTML) — 파일·버전을 만들지 않는다
  // ---------------------------------------------------------------------------

  /**
   * WO-002: 출력 전 실제 양식 모습 그대로 확인. 출력과 **같은 워크북**을 그려서
   * 미리 본 것과 내려받은 것이 어긋나지 않게 한다. 버전·파일은 생기지 않는다.
   */
  async formPreview(
    orderItemId: string,
    measurementSessionId?: string,
  ): Promise<{ orderItemId: string; html: string }> {
    const item = await this.loadOrderItem(orderItemId);
    const { session, measurementSession: linkedSession } = this.requirePrerequisites(item, {
      measurementOptional: measurementSessionId != null,
    });
    const measurementSession = await this.resolveMeasurementSession(
      item,
      linkedSession,
      measurementSessionId,
    );
    const html = await buildWorkOrderPreviewHtml(
      this.buildExcelData(
        item,
        this.buildOptionSnapshot(session),
        this.buildMeasurementSnapshot(measurementSession),
        { fabricName: session.fabricName, issuedAt: new Date(), note: null },
      ),
    );
    return { orderItemId: item.id, html };
  }

  /*
    저장된 출력본을 화면에서 다시 그리는 기능은 없앴다 (2026-08-05) — 파일이 곧 결과물이므로
    받아서 열면 된다. 미리보기는 '지금 값으로 그리기'(formPreview) 하나만 남는다.
  */

  // ---------------------------------------------------------------------------
  // Excel 출력 (버전 생성)
  // ---------------------------------------------------------------------------

  /**
   * WO-002: Excel 출력·버전 생성 (데이터모델 §15.4).
   * 전제 검증 → 스냅샷·source_hash → Excel 생성·저장 → 단일 트랜잭션으로
   * files + work_orders(upsert) + work_order_versions + current_version_id 갱신.
   * Idempotency-Key 재요청 시 최초 응답을 그대로 반환한다 (구현표준 §1.5).
   */
  async issue(
    orderItemId: string,
    dto: IssueWorkOrderVersionDto,
    idempotencyKey: string | undefined,
    actor: AuthUser,
  ) {
    if (idempotencyKey && idempotencyKey.length > 80) {
      throw new BusinessException('VALIDATION_ERROR', 'Idempotency-Key는 80자 이하여야 합니다.');
    }
    // 멱등성 기준: orderItemId + Idempotency-Key (화면·API 정의서 §12.7)
    const idemKey = idempotencyKey ? `wov:${orderItemId}:${idempotencyKey}` : null;
    if (idemKey) {
      const stored = await this.prisma.idempotencyKey.findUnique({ where: { key: idemKey } });
      if (stored?.responseJson != null) return stored.responseJson;
    }

    const item = await this.loadOrderItem(orderItemId);
    const { session, measurementSession: linkedSession, link } = this.requirePrerequisites(item, {
      measurementOptional: await this.hasUsableMeasurement(item, dto.measurementSessionId),
    });
    // 연결이 없으면 최신 완료 채촌으로 출력하고, 아래에서 그 채촌으로 연결을 확정한다.
    const measurementSession = await this.resolveWorkOrderMeasurement(
      item,
      linkedSession,
      dto.measurementSessionId,
    );

    if (dto.version !== undefined && dto.version !== item.rowVersion) {
      throw new BusinessException('VERSION_CONFLICT', '품목 정보가 갱신되었습니다. 다시 조회해 주세요.', undefined, {
        currentVersion: item.rowVersion,
      });
    }

    const optionSnapshot = this.buildOptionSnapshot(session);
    const measurementSnapshot = this.buildMeasurementSnapshot(measurementSession);

    const issuedAt = new Date();
    let writtenPath: string | null = null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 품목당 work_orders 1건 (데이터모델 §10.1)
        const workOrder = await tx.workOrder.upsert({
          where: { orderItemId },
          update: {},
          create: { id: randomUUID(), orderItemId },
          select: { id: true, outputFileId: true },
        });
        const fileName = `${item.order.orderNo}_${item.productCategory}-${String(item.sequenceNo).padStart(2, '0')}.xlsx`;

        // Excel 생성 — 정장/셔츠는 실물 공장 양식(송파) 템플릿, 구두는 간이 메모형 시트로 분기
        // (설계서 06 §5-a).
        const excelData = this.buildExcelData(item, optionSnapshot, measurementSnapshot, {
          fabricName: session.fabricName,
          issuedAt,
          note: dto.note ?? null,
        });
        const buffer =
          item.productCategory === 'SHOES'
            ? await buildShoesWorkOrderExcel(excelData)
            : await buildWorkOrderExcel(excelData);

        /*
          품목당 파일 하나다 (현업 확정 2026-08-05) — 저장 위치도 품목마다 고정해 두고
          다시 뽑으면 그 자리를 덮어쓴다. 버전을 쌓지 않으므로 옛 파일이 남지 않는다.
        */
        const storageKey = `work-orders/${workOrder.id}.xlsx`;
        const filePath = resolve(this.storageRoot(), storageKey);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, buffer);
        writtenPath = filePath;

        const fileData = {
          storageKey,
          originalName: fileName,
          mimeType: XLSX_MIME,
          sizeBytes: BigInt(buffer.length),
          checksumSha256: createHash('sha256').update(buffer).digest('hex'),
        };
        const fileId = workOrder.outputFileId ?? randomUUID();
        if (workOrder.outputFileId) {
          await tx.file.update({ where: { id: workOrder.outputFileId }, data: fileData });
        } else {
          await tx.file.create({ data: { id: fileId, ...fileData } });
        }

        // 출력하면 작업지시서가 선다 — 발주가 이 창을 거치므로 여기서 완료로 굳힌다.
        await tx.workOrder.update({
          where: { id: workOrder.id },
          data: {
            outputFileId: fileId,
            issuedAt,
            issuedBy: actor.id,
            status: 'COMPLETED',
          },
        });

        // 출력에 실제로 쓴 채촌으로 품목 연결을 확정한다 (현업 확정 2026-08-03).
        // 출력 시점에 쓴 것이 곧 기준이며, 뒤에 더 최근 채촌이 생겨도 저절로 바뀌지 않는다.
        // 빈 채촌은 기준이 될 수 없으므로 그대로 둔다.
        if (measurementSession.values.length > 0 && link?.measurementSessionId !== measurementSession.id) {
          await tx.orderItemMeasurement.updateMany({
            where: { orderItemId, isCurrent: true, NOT: { measurementSessionId: measurementSession.id } },
            data: { isCurrent: false },
          });
          const existing = await tx.orderItemMeasurement.findFirst({
            where: { orderItemId, measurementSessionId: measurementSession.id },
          });
          if (existing) {
            await tx.orderItemMeasurement.update({
              where: { id: existing.id },
              data: { isCurrent: true, linkedBy: actor.id, linkedAt: issuedAt },
            });
          } else {
            await tx.orderItemMeasurement.create({
              data: {
                id: randomUUID(),
                orderItemId,
                measurementSessionId: measurementSession.id,
                isCurrent: true,
                linkedBy: actor.id,
                linkedAt: issuedAt,
              },
            });
          }
          await this.audit.log(
            {
              userId: actor.id,
              action: 'LINK',
              entityType: 'ORDER_ITEM_MEASUREMENT',
              entityId: orderItemId,
              before: link ? { measurementSessionId: link.measurementSessionId } : null,
              after: { measurementSessionId: measurementSession.id, isCurrent: true },
              reason: '작업지시서 출력 시 채촌 확정',
            },
            tx,
          );
        }
        if (dto.version !== undefined) {
          await tx.orderItem.update({
            where: { id: orderItemId },
            data: { rowVersion: { increment: 1 } },
          });
        }
        // 출력으로 채촌이 확정되면 준비가 끝난 것이다 — 품목 상태에 반영한다.
        await syncPrepStatuses(tx, [orderItemId], actor.id);

        const response = {
          workOrderId: workOrder.id,
          issuedAt: issuedAt.toISOString(),
          file: { id: fileId, fileName, downloadUrl: `/api/v1/files/${fileId}` },
        };

        await this.audit.log(
          {
            userId: actor.id,
            action: 'EXPORT',
            entityType: 'WORK_ORDER',
            entityId: workOrder.id,
            after: { orderItemId, fileId, fileName },
            reason: dto.note,
          },
          tx,
        );
        if (idemKey) {
          await tx.idempotencyKey.create({
            data: {
              id: randomUUID(),
              key: idemKey,
              userId: actor.id,
              endpoint: `POST /order-items/${orderItemId}/work-order`,
              responseJson: response,
            },
          });
        }
        return response;
      });
    } catch (error) {
      // 파일 생성 후 트랜잭션 실패 시 고아 파일 정리 (화면·API 정의서 §15.3)
      if (writtenPath) await unlink(writtenPath).catch(() => undefined);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // 파일 다운로드
  // ---------------------------------------------------------------------------

  /**
   * 저장된 Excel 스트리밍 — 작업지시서 id로 받는다 (2026-08-05, 버전 제거).
   * 수기 최종본이 있으면 그것을 내려 준다. 실제로 공장에 나간 서류가 최종이다.
   */
  async streamFile(workOrderId: string, res: Response): Promise<void> {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      include: { outputFile: true, uploadedFile: true },
    });
    if (!wo) throw new BusinessException('NOT_FOUND', '작업지시서를 찾을 수 없습니다.');
    const file = wo.uploadedFile ?? wo.outputFile;
    if (!file) throw new BusinessException('NOT_FOUND', '아직 출력한 작업지시서가 없습니다.');

    const filePath = resolve(this.storageRoot(), file.storageKey);
    if (!existsSync(filePath)) {
      throw new BusinessException('NOT_FOUND', '출력 파일이 저장소에 존재하지 않습니다.');
    }
    const encodedName = encodeURIComponent(file.originalName);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
    );
    createReadStream(filePath).pipe(res);
  }

  /**
   * 수기 최종본 올리기 (현업 확정 2026-08-05).
   * 시스템 출력본을 손으로 고쳐 공장에 보낸 파일을 **보관만** 한다 — 열어서 값을 꺼내지 않는다.
   */
  async uploadFinalFile(workOrderId: string, file: UploadedMulterFile | undefined, actor: AuthUser) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { id: true, uploadedFileId: true },
    });
    if (!wo) throw new BusinessException('NOT_FOUND', '작업지시서를 찾을 수 없습니다.');

    const uploaded = await this.files.upload(file, actor);
    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: { uploadedFileId: uploaded.id, uploadedBy: actor.id, uploadedAt: new Date() },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPLOAD',
      entityType: 'WORK_ORDER',
      entityId: workOrderId,
      before: { uploadedFileId: wo.uploadedFileId },
      after: { uploadedFileId: uploaded.id, fileName: uploaded.originalName },
      reason: '수기 최종본 업로드',
    });
    return { workOrderId, file: { id: uploaded.id, fileName: uploaded.originalName } };
  }

  /** 잘못 올린 최종본 내리기 — 파일 자체는 남기고 연결만 끊는다(업로드 이력 보존). */
  async removeFinalFile(workOrderId: string, actor: AuthUser) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { id: true, uploadedFileId: true },
    });
    if (!wo) throw new BusinessException('NOT_FOUND', '작업지시서를 찾을 수 없습니다.');
    if (!wo.uploadedFileId)
      throw new BusinessException('VALIDATION_ERROR', '올려 둔 최종본이 없습니다.');

    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: { uploadedFileId: null, uploadedBy: null, uploadedAt: null },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'DELETE',
      entityType: 'WORK_ORDER',
      entityId: workOrderId,
      before: { uploadedFileId: wo.uploadedFileId },
      reason: '수기 최종본 내림',
    });
    return { workOrderId, removed: true };
  }

  // ---------------------------------------------------------------------------
  // 내부 헬퍼
  // ---------------------------------------------------------------------------

  private storageRoot(): string {
    return this.config.get<string>('FILE_STORAGE_PATH', './storage');
  }

  private async loadOrderItem(orderItemId: string): Promise<OrderItemWithSources> {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: orderItemInclude,
    });
    if (!item) {
      throw new BusinessException('NOT_FOUND', '주문 품목을 찾을 수 없습니다.');
    }
    return item;
  }

  /**
   * 출력 전제 검증: 현재 옵션 세션 CONFIRMED + 현재 채촌 연결 (통합설계서 §10.4).
   * measurementOptional=true면 채촌 연결 누락을 허용한다(요청 본문으로 세션 지정 시).
   */
  private requirePrerequisites(
    item: OrderItemWithSources,
    opts: { measurementOptional?: boolean } = {},
  ): {
    session: ConfirmedOptionSession;
    /** measurementOptional=true면 null일 수 있다. */
    link: OrderItemWithSources['measurementLinks'][number] | null;
    measurementSession: MeasurementSessionWithValues;
  } {
    const session = item.sourceContractItem.optionSelectionSessions[0] ?? null;
    const link = item.measurementLinks[0] ?? null;
    const missing: string[] = [];
    if (!session) missing.push('OPTION_SESSION_CONFIRMED');
    if (!link && !opts.measurementOptional) missing.push('MEASUREMENT_LINKED');
    if (missing.length > 0) {
      throw new BusinessException(
        'WORK_ORDER_PREREQUISITE_MISSING',
        '옵션 확정과 채촌 연결이 완료되어야 작업지시서를 출력할 수 있습니다.',
        undefined,
        { orderItemId: item.id, missing },
      );
    }
    return {
      session: session as ConfirmedOptionSession,
      link,
      measurementSession: link?.measurementSession as MeasurementSessionWithValues,
    };
  }

  /**
   * 연결이 없어도 대신 쓸 채촌이 있는지 — 지목한 채촌이 있거나, 그 고객에게 완료 채촌이 있으면 참.
   * 전제 미충족(422) 판정에서 "채촌 연결"을 요구할지 가르는 값이다.
   */
  private async hasUsableMeasurement(
    item: OrderItemWithSources,
    measurementSessionId: string | undefined,
  ): Promise<boolean> {
    if (measurementSessionId) return true;
    const usable = await this.prisma.measurementSession.count({
      where: { customerId: item.order.contract.customer.id, values: { some: {} } },
    });
    return usable > 0;
  }

  /**
   * 작업지시서가 쓸 채촌을 정한다 (현업 확정 2026-08-03).
   *
   * 1) 요청이 특정 채촌을 지목하면 그것,
   * 2) 품목에 연결된 채촌이 있으면 그것,
   * 3) 둘 다 없으면 **스타일 컨설팅 구분의, 값이 든 가장 최근 채촌** (현업 확정 2026-08-05).
   *
   * 구분을 가리는 이유: 가봉·수선 채촌은 그 옷을 고치려고 잰 것이라 새 옷의 기준이 아니다.
   * 값 유무를 보는 이유: '완료' 표시를 걷어냈으므로, 방금 열어 둔 빈 채촌이 최신일 수 있다.
   */
  private async resolveWorkOrderMeasurement(
    item: OrderItemWithSources,
    linkedSession: MeasurementSessionWithValues | undefined,
    measurementSessionId: string | undefined,
  ): Promise<MeasurementSessionWithValues> {
    if (measurementSessionId)
      return this.resolveMeasurementSession(item, linkedSession, measurementSessionId);
    if (linkedSession) return linkedSession;

    const latest = await this.prisma.measurementSession.findFirst({
      where: {
        customerId: item.order.contract.customer.id,
        measurementType: 'INITIAL',
        values: { some: {} },
      },
      orderBy: [{ measurementDate: 'desc' }, { versionNo: 'desc' }],
      include: { values: { orderBy: [{ sortOrder: 'asc' }, { measurementCode: 'asc' }] } },
    });
    if (!latest) {
      throw new BusinessException(
        'WORK_ORDER_PREREQUISITE_MISSING',
        '쓸 수 있는 채촌이 없습니다. 스타일 컨설팅 채촌을 먼저 기록해 주세요.',
        undefined,
        { orderItemId: item.id, missing: ['MEASUREMENT_LINKED'] },
      );
    }
    return latest;
  }

  /** 요청 본문 measurementSessionId가 있으면 해당 채촌 세션으로 교체 (WO-002 채촌 변경) */
  private async resolveMeasurementSession(
    item: OrderItemWithSources,
    linkedSession: MeasurementSessionWithValues | undefined,
    measurementSessionId: string | undefined,
  ): Promise<MeasurementSessionWithValues> {
    if (!measurementSessionId || measurementSessionId === linkedSession?.id) {
      if (!linkedSession) {
        throw new BusinessException(
          'WORK_ORDER_PREREQUISITE_MISSING',
          '품목에 연결된 채촌이 없습니다.',
          undefined,
          { orderItemId: item.id, missing: ['MEASUREMENT_LINKED'] },
        );
      }
      return linkedSession;
    }
    const session = await this.prisma.measurementSession.findUnique({
      where: { id: measurementSessionId },
      include: {
        values: { orderBy: [{ sortOrder: 'asc' }, { measurementCode: 'asc' }] },
      },
    });
    if (!session || session.customerId !== item.order.contract.customer.id) {
      throw new BusinessException('NOT_FOUND', '해당 고객의 채촌 세션을 찾을 수 없습니다.');
    }
    return session;
  }

  /**
   * 양식 채우기에 넘길 값 묶음. 출력(파일 저장)과 미리보기(HTML)가 같은 입력을 쓰도록
   * 한 곳에서 만든다 — 미리 본 것과 내려받은 것이 어긋나지 않게 하는 단일 출처.
   */
  private buildExcelData(
    item: OrderItemWithSources,
    optionSnapshot: ReturnType<WorkOrdersService['buildOptionSnapshot']>,
    measurementSnapshot: ReturnType<WorkOrdersService['buildMeasurementSnapshot']>,
    meta: { fabricName: string | null; issuedAt: Date; note: string | null },
  ): WorkOrderExcelData {
    return {
      customerName: item.order.contract.customer.name,
      customerPhone: item.order.contract.customer.phone,
      // 신체 3필드는 선택 입력이라 없으면 null → 양식의 빈칸을 그대로 둔다 (설계서 06 §2.5)
      customerHeightCm: item.order.contract.customer.heightCm,
      customerWeightKg:
        item.order.contract.customer.weightKg != null
          ? Number(item.order.contract.customer.weightKg)
          : null,
      customerAge: item.order.contract.customer.age,
      orderNo: item.order.orderNo,
      itemLabel: item.displayName,
      productCategory: item.productCategory,
      sequenceNo: item.sequenceNo,
      fabricName: meta.fabricName,
      issuedAt: meta.issuedAt,
      note: meta.note,
      orderDate: toDateString(item.order.contract.contractedAt ?? item.order.createdAt),
      fittingDate: item.fittingSessions[0] ? toDateString(item.fittingSessions[0].fittingDate) : null,
      completionDate: item.order.completionDueDate
        ? toDateString(item.order.completionDueDate)
        : null,
      componentCounts: countComponents(item.components),
      measurementDate: measurementSnapshot.measurementDate,
      measurementVersionNo: measurementSnapshot.versionNo,
      options: optionSnapshot.stages.map((s) => ({
        stageCode: s.stageCode,
        stageName: s.stageName,
        choiceName: s.choiceName,
      })),
      measurements: measurementSnapshot.values.map((v) => ({
        code: v.measurementCode,
        label: MEASUREMENT_ITEM_MAP.get(v.measurementCode)?.label ?? v.measurementCode,
        value: v.value != null ? String(v.value) : (v.textValue ?? '-'),
        unit: v.unit,
      })),
      components: this.buildComponentAttrs(item.sourceContractItem.optionSelectionSessions[0]),
    };
  }

  /**
   * 세션의 부위별 원단·컬러·패턴을 작업지시서 양식 구조로 변환 (설계서 04 §2.5).
   * 저장된 부위 attr이 없으면 undefined를 반환해 기존 fabricName 단일 출력을 유지한다.
   */
  private buildComponentAttrs(
    session: ConfirmedOptionSession | undefined,
  ): WorkOrderExcelData['components'] {
    const attrs = session?.componentAttrs ?? [];
    if (attrs.length === 0) return undefined;
    const pick = (group: string) => {
      const a = attrs.find((x) => x.componentGroup === group);
      return a
        ? { fabricName: a.fabricName, colorName: a.colorName, patternName: a.patternName, notes: a.notes }
        : undefined;
    };
    return { JACKET: pick('JACKET'), TROUSERS: pick('TROUSERS'), VEST: pick('VEST') };
  }

  /** 출력 당시 단계명·선택 옵션명·원단 스냅샷 (데이터모델 §10.2) */
  private buildOptionSnapshot(session: ConfirmedOptionSession) {
    return {
      optionSessionId: session.id,
      selectionVersionNo: session.selectionVersionNo,
      confirmedAt: session.confirmedAt?.toISOString() ?? null,
      fabricName: session.fabricName,
      stages: session.values.map((v) => ({
        stageCode: v.optionStage.stageCode,
        stageName: v.optionStage.stageName,
        sequenceNo: v.optionStage.sequenceNo,
        choiceCode: v.optionChoice.choiceCode,
        choiceName: v.optionChoice.choiceName,
        factoryLabel: v.optionChoice.factoryLabel,
      })),
    };
  }

  /** 출력 당시 채촌 버전·항목 값 스냅샷 (데이터모델 §10.2) */
  private buildMeasurementSnapshot(session: MeasurementSessionWithValues) {
    return {
      measurementSessionId: session.id,
      versionNo: session.versionNo,
      measurementDate: toDateString(session.measurementDate),
      measurementType: session.measurementType,
      values: session.values.map((v) => ({
        bodySection: v.bodySection,
        measurementCode: v.measurementCode,
        value: v.numericValue != null ? Number(v.numericValue) : null,
        textValue: v.textValue,
        unit: v.unit,
        sortOrder: v.sortOrder,
      })),
    };
  }

  private toListRow(item: OrderItemWithSources) {
    const session = item.sourceContractItem.optionSelectionSessions[0] ?? null;
    const link = item.measurementLinks[0] ?? null;
    const wo = item.workOrder ?? null;
    return {
      workOrderId: wo?.id ?? null,
      orderItemId: item.id,
      contractId: item.order.contract.id,
      contractNo: item.order.contract.contractNo,
      customerId: item.order.contract.customer.id,
      customerName: item.order.contract.customer.name,
      orderId: item.order.id,
      orderNo: item.order.orderNo,
      itemLabel: item.displayName,
      productCategory: item.productCategory,
      sequenceNo: item.sequenceNo,
      fabricName: session?.fabricName ?? null,
      status: resolveWorkOrderStatus(session, link, !!wo?.outputFile),
      docStatus: wo?.status ?? 'DRAFT',
      fileName: wo?.uploadedFile?.originalName ?? wo?.outputFile?.originalName ?? null,
      uploadedFileName: wo?.uploadedFile?.originalName ?? null,
      lastIssuedAt: wo?.issuedAt?.toISOString() ?? null,
      optionConfirmedAt: session?.confirmedAt?.toISOString() ?? null,
      measurementLinkedAt: link?.linkedAt.toISOString() ?? null,
    };
  }

}
