import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { Response } from 'express';
import { createReadStream, existsSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MEASUREMENT_ITEM_MAP } from '../measurements/measurement-catalog';
import {
  buildShoesWorkOrderExcel,
  buildWorkOrderExcel,
  buildWorkOrderPreviewHtml,
  renderStoredWorkOrderHtml,
  type WorkOrderExcelData,
} from './work-order-excel';
import { resolveWorkOrderStatus } from './work-order-status';
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
  workOrder: { include: { currentVersion: true } },
  // 작업지시서 양식의 상의/하의/조끼 벌수·가봉일 칸을 채우는 원본
  components: { where: { active: true } },
  fittingSessions: { orderBy: { fittingDate: Prisma.SortOrder.desc }, take: 1 },
});

type OrderItemWithSources = Prisma.OrderItemGetPayload<{ include: typeof orderItemInclude }>;
type ConfirmedOptionSession = OrderItemWithSources['optionSelectionSessions'][number];
type MeasurementSessionWithValues =
  OrderItemWithSources['measurementLinks'][number]['measurementSession'];

type VersionWithFile = Prisma.WorkOrderVersionGetPayload<{
  include: { outputFile: true; issuedByUser: true };
}>;

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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
          { optionSelectionSessions: { some: { isCurrent: true, status: 'CONFIRMED' } } },
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
        currentVersion: { include: { outputFile: true, issuedByUser: true } },
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
      currentVersion: workOrder.currentVersion ? this.toVersionRow(workOrder.currentVersion) : null,
    };
  }

  /** WO-002: 출력 이력 (최신 버전부터) */
  async versions(workOrderId: string) {
    const workOrder = await this.prisma.workOrder.findUnique({ where: { id: workOrderId } });
    if (!workOrder) {
      throw new BusinessException('NOT_FOUND', '작업지시서를 찾을 수 없습니다.');
    }
    const versions = await this.prisma.workOrderVersion.findMany({
      where: { workOrderId },
      include: { outputFile: true, issuedByUser: true },
      orderBy: { versionNo: 'desc' },
    });
    return versions.map((v) => this.toVersionRow(v));
  }

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
    const { session, measurementSession: linkedSession, link } = this.requirePrerequisites(item, {
      measurementOptional: measurementSessionId != null,
    });
    const measurementSession = measurementSessionId
      ? await this.resolveMeasurementSession(item, linkedSession, measurementSessionId)
      : linkedSession;
    const currentVersion = item.workOrder?.currentVersion ?? null;

    // 채촌 버전 교체 후보: 같은 고객의 모든 채촌 세션 (최신 버전부터)
    const candidates = await this.prisma.measurementSession.findMany({
      where: { customerId: item.order.contract.customer.id },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true,
        versionNo: true,
        measurementDate: true,
        measurementType: true,
        completedAt: true,
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
        completed: c.completedAt != null,
        isLinked: !!link && c.id === link.measurementSessionId,
      })),
      currentVersionNo: currentVersion?.versionNo ?? null,
      // 미리보기 화면에서 최신 출력본을 바로 내려받게 하려면 버전 id가 필요하다.
      currentVersionId: currentVersion?.id ?? null,
      lastIssuedAt: currentVersion?.issuedAt.toISOString() ?? null,
      status: resolveWorkOrderStatus(session, link, currentVersion),
      // 정식 출력 가능 판정 (docs/dev/08 §4): 옵션 확정 + 채촌 연결·완료
      optionConfirmed: session.status === 'CONFIRMED',
      measurementCompleted: !!measurementSession && measurementSession.completedAt != null,
      printable:
        session.status === 'CONFIRMED' && !!measurementSession && measurementSession.completedAt != null,
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
  ): Promise<{ orderItemId: string; versionNo: number; html: string }> {
    const item = await this.loadOrderItem(orderItemId);
    const { session, measurementSession: linkedSession } = this.requirePrerequisites(item, {
      measurementOptional: measurementSessionId != null,
    });
    const measurementSession = await this.resolveMeasurementSession(
      item,
      linkedSession,
      measurementSessionId,
    );
    // 아직 출력 전이므로 "다음에 붙을 버전 번호"를 보여준다.
    const nextVersionNo = (item.workOrder?.currentVersion?.versionNo ?? 0) + 1;
    const html = await buildWorkOrderPreviewHtml(
      this.buildExcelData(
        item,
        this.buildOptionSnapshot(session),
        this.buildMeasurementSnapshot(measurementSession),
        { fabricName: session.fabricName, versionNo: nextVersionNo, issuedAt: new Date(), note: null },
      ),
    );
    return { orderItemId: item.id, versionNo: nextVersionNo, html };
  }

  /** WO-002: 저장된 출력본을 그대로 화면에서 본다 (출력 이력 보기) */
  async versionFormPreview(versionId: string): Promise<{ versionId: string; versionNo: number; html: string }> {
    const version = await this.prisma.workOrderVersion.findUnique({
      where: { id: versionId },
      include: { outputFile: true },
    });
    if (!version) {
      throw new BusinessException('NOT_FOUND', '작업지시서 버전을 찾을 수 없습니다.');
    }
    const filePath = resolve(this.storageRoot(), version.outputFile.storageKey);
    if (!existsSync(filePath)) {
      throw new BusinessException('NOT_FOUND', '출력 파일이 저장소에 존재하지 않습니다.');
    }
    return {
      versionId,
      versionNo: version.versionNo,
      html: await renderStoredWorkOrderHtml(filePath),
    };
  }

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
    const { session, measurementSession: linkedSession } = this.requirePrerequisites(item, {
      measurementOptional: dto.measurementSessionId != null,
    });
    const measurementSession = await this.resolveMeasurementSession(
      item,
      linkedSession,
      dto.measurementSessionId,
    );

    if (dto.version !== undefined && dto.version !== item.rowVersion) {
      throw new BusinessException('VERSION_CONFLICT', '품목 정보가 갱신되었습니다. 다시 조회해 주세요.', undefined, {
        currentVersion: item.rowVersion,
      });
    }

    // 출력 당시 표시값 스냅샷 + 원본 조합 해시 (데이터모델 §10.2)
    const optionSnapshot = this.buildOptionSnapshot(session);
    const measurementSnapshot = this.buildMeasurementSnapshot(measurementSession);
    const sourceHash = createHash('sha256')
      .update(JSON.stringify({ option: optionSnapshot, measurement: measurementSnapshot }))
      .digest('hex');

    const issuedAt = new Date();
    const versionId = randomUUID();
    const fileId = randomUUID();
    let writtenPath: string | null = null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 품목당 work_orders 1건 (데이터모델 §10.1)
        const workOrder = await tx.workOrder.upsert({
          where: { orderItemId },
          update: {},
          create: { id: randomUUID(), orderItemId },
        });
        const last = await tx.workOrderVersion.findFirst({
          where: { workOrderId: workOrder.id },
          orderBy: { versionNo: 'desc' },
          select: { versionNo: true },
        });
        const versionNo = (last?.versionNo ?? 0) + 1;
        const fileName = `${item.order.orderNo}_${item.productCategory}-${String(item.sequenceNo).padStart(2, '0')}_V${versionNo}.xlsx`;

        // Excel 생성 — 정장/셔츠는 실물 공장 양식(송파) 템플릿, 구두는 간이 메모형 시트로 분기
        // (설계서 06 §5-a). 버전관리·파일저장·감사(EXPORT) 흐름은 카테고리와 무관하게 동일하다.
        const excelData = this.buildExcelData(item, optionSnapshot, measurementSnapshot, {
          fabricName: session.fabricName,
          versionNo,
          issuedAt,
          note: dto.note ?? null,
        });
        const buffer =
          item.productCategory === 'SHOES'
            ? await buildShoesWorkOrderExcel(excelData)
            : await buildWorkOrderExcel(excelData);

        const storageKey = `work-orders/${versionId}.xlsx`;
        const filePath = resolve(this.storageRoot(), storageKey);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, buffer);
        writtenPath = filePath;

        await tx.file.create({
          data: {
            id: fileId,
            storageKey,
            originalName: fileName,
            mimeType: XLSX_MIME,
            sizeBytes: BigInt(buffer.length),
            checksumSha256: createHash('sha256').update(buffer).digest('hex'),
          },
        });

        // 이전 유효 버전은 SUPERSEDED로 보존 (데이터모델 §10.2)
        await tx.workOrderVersion.updateMany({
          where: { workOrderId: workOrder.id, status: { in: ['ISSUED', 'SENT'] } },
          data: { status: 'SUPERSEDED' },
        });
        await tx.workOrderVersion.create({
          data: {
            id: versionId,
            workOrderId: workOrder.id,
            versionNo,
            sourceOptionSessionId: session.id,
            sourceMeasurementSessionId: measurementSession.id,
            optionSnapshot: optionSnapshot as unknown as Prisma.InputJsonValue,
            measurementSnapshot: measurementSnapshot as unknown as Prisma.InputJsonValue,
            sourceHash,
            changeReason: dto.note ?? null,
            outputFileId: fileId,
            status: 'ISSUED',
            issuedBy: actor.id,
            issuedAt,
          },
        });
        await tx.workOrder.update({
          where: { id: workOrder.id },
          data: { currentVersionId: versionId },
        });
        if (dto.version !== undefined) {
          await tx.orderItem.update({
            where: { id: orderItemId },
            data: { rowVersion: { increment: 1 } },
          });
        }

        const response = {
          workOrderId: workOrder.id,
          workOrderVersionId: versionId,
          versionNo,
          issuedAt: issuedAt.toISOString(),
          file: { id: fileId, fileName, downloadUrl: `/api/v1/files/${fileId}` },
        };

        await this.audit.log(
          {
            userId: actor.id,
            action: 'EXPORT',
            entityType: 'WORK_ORDER_VERSION',
            entityId: versionId,
            after: { orderItemId, workOrderId: workOrder.id, versionNo, fileId, sourceHash },
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
              endpoint: `POST /order-items/${orderItemId}/work-order-versions`,
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

  /** 저장된 Excel 스트리밍 (파일 모듈과 독립 구현) */
  async streamFile(versionId: string, res: Response): Promise<void> {
    const version = await this.prisma.workOrderVersion.findUnique({
      where: { id: versionId },
      include: { outputFile: true },
    });
    if (!version) {
      throw new BusinessException('NOT_FOUND', '작업지시서 버전을 찾을 수 없습니다.');
    }
    const filePath = resolve(this.storageRoot(), version.outputFile.storageKey);
    if (!existsSync(filePath)) {
      throw new BusinessException('NOT_FOUND', '출력 파일이 저장소에 존재하지 않습니다.');
    }
    const encodedName = encodeURIComponent(version.outputFile.originalName);
    res.setHeader('Content-Type', version.outputFile.mimeType);
    res.setHeader('Content-Length', String(version.outputFile.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
    );
    createReadStream(filePath).pipe(res);
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
    const session = item.optionSelectionSessions[0] ?? null;
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
    meta: { fabricName: string | null; versionNo: number; issuedAt: Date; note: string | null },
  ): WorkOrderExcelData {
    return {
      customerName: item.order.contract.customer.name,
      customerPhone: item.order.contract.customer.phone,
      orderNo: item.order.orderNo,
      itemLabel: item.displayName,
      productCategory: item.productCategory,
      sequenceNo: item.sequenceNo,
      fabricName: meta.fabricName,
      versionNo: meta.versionNo,
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
      components: this.buildComponentAttrs(item.optionSelectionSessions[0]),
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
    const session = item.optionSelectionSessions[0] ?? null;
    const link = item.measurementLinks[0] ?? null;
    const currentVersion = item.workOrder?.currentVersion ?? null;
    return {
      workOrderId: item.workOrder?.id ?? null,
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
      status: resolveWorkOrderStatus(session, link, currentVersion),
      currentVersionNo: currentVersion?.versionNo ?? null,
      lastIssuedAt: currentVersion?.issuedAt.toISOString() ?? null,
      optionConfirmedAt: session?.confirmedAt?.toISOString() ?? null,
      measurementLinkedAt: link?.linkedAt.toISOString() ?? null,
    };
  }

  private toVersionRow(version: VersionWithFile) {
    return {
      id: version.id,
      versionNo: version.versionNo,
      status: version.status,
      changeReason: version.changeReason,
      sourceOptionSessionId: version.sourceOptionSessionId,
      sourceMeasurementSessionId: version.sourceMeasurementSessionId,
      sourceHash: version.sourceHash,
      optionSnapshot: version.optionSnapshot,
      measurementSnapshot: version.measurementSnapshot,
      issuedBy: { id: version.issuedByUser.id, displayName: version.issuedByUser.displayName },
      issuedAt: version.issuedAt.toISOString(),
      sentAt: version.sentAt?.toISOString() ?? null,
      file: {
        id: version.outputFile.id,
        fileName: version.outputFile.originalName,
        downloadUrl: `/api/v1/files/${version.outputFile.id}`,
      },
    };
  }
}
