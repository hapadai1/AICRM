/**
 * AICRM 데모 데이터 확장 시드
 * - 전제: prisma/seed.ts(기본) + prisma/seed-demo.ts(데모) 실행 완료 상태
 * - 재실행 안전: 확장 마커 고객(한지민, 01077011001) 존재 시 스킵 후 종료
 * - 실행: npm run seed:more
 *
 * seed-demo가 만든 최소 시나리오 위에 "전 메뉴가 비어 보이지 않도록" 데이터를 덧붙인다.
 *   신규 고객 6 / 계약 6(확정 4·완료 1·취소 1) / 주문 9 / 품목 15 / 구성품 22
 *   옵션 세션 5(확정 3·확인대기 1·진행중 1) / 채촌 5버전(초도 3·가봉 2) / 작업지시서 3버전
 *   렌탈 SKU +3·실물 +12·배정 +7(예약 2·대여중 2·반납완료 3) / 수선 +5(상태 4종)
 *   결제 +12(계약금·중도금·잔금·수선비·환불) / 예약 +18 / 상담 +7
 *   알림 규칙 2·발송 이력 6 / 공유 메모 +3 / 기존 데모 고객(정우성 등) 이력 보강
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const prisma = new PrismaClient();

/** 확장 시드 여부 감지용 고정 전화번호 (한지민) */
const MARKER_PHONE = '01077011001';

type Tx = Prisma.TransactionClient;

const uuid = (): string => randomUUID();

/** 오늘±offset 일을 @db.Date 컬럼용 UTC 자정 Date로 반환 */
function dateOnly(offsetDays: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays));
}

/** 오늘±offset 일의 지정 시각(로컬) timestamptz Date */
function at(offsetDays: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function storageRoot(): string {
  return resolve(process.env.FILE_STORAGE_PATH ?? './storage');
}

/** FILE_STORAGE_PATH에 실제 파일을 쓰고 files 레코드를 생성한다. */
async function createFile(
  tx: Tx,
  args: { storageKey: string; originalName: string; mimeType: string; buffer: Buffer },
): Promise<string> {
  const absolutePath = join(storageRoot(), args.storageKey);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, args.buffer);
  const record = await tx.file.create({
    data: {
      id: uuid(),
      storageKey: args.storageKey,
      originalName: args.originalName,
      mimeType: args.mimeType,
      sizeBytes: BigInt(args.buffer.length),
      checksumSha256: createHash('sha256').update(args.buffer).digest('hex'),
    },
  });
  return record.id;
}

// -----------------------------------------------------------------------------
// 채촌 값 (seed-demo와 동일한 코드 체계)
// -----------------------------------------------------------------------------

/** [code, bodySection, numeric|null, text|null, unit, sortOrder] */
type MeasureRow = [string, string, number | null, string | null, string, number];

function measurementRows(v: {
  neck: number; shoulder: number; chest: number; sleeve: number; bodyLength: number; wrist: number;
  upperSize: string; waist: number; hip: number; rise: number; pantsLength: number; thigh: number;
  calf: number; lowerSize: string; shoeSize: number;
}): MeasureRow[] {
  return [
    ['JACKET_LENGTH', 'UPPER', v.bodyLength, null, 'CM', 10],
    ['SHOULDER', 'UPPER', v.shoulder, null, 'CM', 20],
    ['FRONT_WIDTH', 'UPPER', Math.round(v.chest * 0.4 * 10) / 10, null, 'CM', 30],
    ['BACK_WIDTH', 'UPPER', Math.round(v.chest * 0.42 * 10) / 10, null, 'CM', 40],
    ['CHEST_UPPER', 'UPPER', v.chest, null, 'CM', 50],
    ['CHEST_MID', 'UPPER', v.chest - 2, null, 'CM', 60],
    ['CHEST_LOW', 'UPPER', v.chest - 4, null, 'CM', 70],
    ['SLEEVE_LEFT', 'UPPER', v.sleeve, null, 'CM', 80],
    ['SLEEVE_RIGHT', 'UPPER', v.sleeve, null, 'CM', 90],
    ['SLEEVE_WIDTH', 'UPPER', v.wrist + 18, null, 'CM', 100],
    ['SLEEVE_OPENING', 'UPPER', v.wrist, null, 'CM', 110],
    ['WAIST', 'LOWER', v.waist, null, 'CM', 210],
    ['HIP', 'LOWER', v.hip, null, 'CM', 220],
    ['THIGH', 'LOWER', v.thigh, null, 'CM', 230],
    ['FRONT_RISE', 'LOWER', v.rise, null, 'CM', 240],
    ['BACK_RISE', 'LOWER', v.rise + 8, null, 'CM', 250],
    ['KNEE', 'LOWER', v.calf + 2, null, 'CM', 260],
    ['PANTS_OPENING', 'LOWER', Math.round(v.calf * 0.5 * 10) / 10, null, 'CM', 270],
    ['PANTS_LENGTH', 'LOWER', v.pantsLength, null, 'CM', 280],
    ['SHOE_SIZE', 'SHOES', v.shoeSize, null, 'MM', 310],
  ];
}

interface SeededMeasurement {
  id: string;
  versionNo: number;
  measurementDate: Date;
  measurementType: string;
  rows: MeasureRow[];
}

async function main(): Promise<void> {
  const marker = await prisma.customer.findUnique({ where: { phoneNormalized: MARKER_PHONE } });
  if (marker) {
    console.log(`확장 시드 스킵: ${marker.name}(${MARKER_PHONE})이 이미 존재합니다.`);
    return;
  }

  const admin = await prisma.user.findUnique({ where: { loginId: 'admin' } });
  if (!admin) throw new Error('admin 사용자가 없습니다. 기본 시드를 먼저 실행하세요.');
  const adminId = admin.id;

  const contractTypes = await prisma.contractType.findMany();
  const contractTypeId = (code: string): string => {
    const found = contractTypes.find((c) => c.code === code);
    if (!found) throw new Error(`계약 구분(${code})이 없습니다. 기본 시드를 먼저 실행하세요.`);
    return found.id;
  };

  const purposes = await prisma.appointmentPurpose.findMany();
  const purposeId = (code: string): string => {
    const found = purposes.find((p) => p.code === code);
    if (!found) throw new Error(`예약 목적(${code})이 없습니다. 기본 시드를 먼저 실행하세요.`);
    return found.id;
  };

  // 활성 옵션 버전 (단계·선택지 포함) — seed-demo가 만든 ACTIVE 버전 재사용
  const optionSets = await prisma.optionSet.findMany({
    include: {
      activeVersion: {
        include: {
          stages: { orderBy: { sequenceNo: 'asc' }, include: { choices: { orderBy: { choiceCode: 'asc' } } } },
        },
      },
    },
  });
  const optionVersionOf = (category: string) => {
    const set = optionSets.find((s) => s.productCategory === category);
    if (!set?.activeVersion) {
      throw new Error(`옵션 세트(${category})의 활성 버전이 없습니다. 데모 시드를 먼저 실행하세요.`);
    }
    return set.activeVersion;
  };
  const suitVersion = optionVersionOf('SUIT');
  const shirtVersion = optionVersionOf('SHIRT');

  // 기존 데모 고객 (이력 보강 대상)
  const findCustomer = async (phoneNormalized: string) =>
    prisma.customer.findUnique({ where: { phoneNormalized } });
  const 정우성 = await findCustomer('01056789012');
  const 김민준 = await findCustomer('01012345678');
  const 이서연 = await findCustomer('01023456789');

  await prisma.$transaction(
    async (tx) => {
      // =====================================================================
      // 공통 헬퍼
      // =====================================================================
      const customer = async (args: {
        name: string; phone: string; email?: string; status: string;
        firstReservedAt?: Date; contractedAt?: Date; notes?: string;
      }): Promise<string> => {
        const id = uuid();
        await tx.customer.create({
          data: {
            id,
            name: args.name,
            phone: args.phone,
            phoneNormalized: args.phone.replace(/\D/g, ''),
            email: args.email ?? null,
            customerStatus: args.status,
            firstReservedAt: args.firstReservedAt ?? null,
            contractedAt: args.contractedAt ?? null,
            notes: args.notes ?? null,
          },
        });
        return id;
      };

      interface LineDef {
        transactionType: string; productCategory: string; itemDescription: string;
        quantity: number; unitPrice: number;
      }
      const createContract = async (args: {
        contractNo: string; customerId: string; typeCode: string; status: string;
        contractedAt: Date; balanceDueDate?: Date | null;
        versions: Array<{
          versionNo: number; versionStatus: string; total: number; deposit: number;
          confirmedAt?: Date; completionDueDate?: Date; photoDate?: Date; weddingDate?: Date;
          changeReason?: string; lines: LineDef[];
        }>;
      }): Promise<{ contractId: string; versionLineIds: string[][] }> => {
        const contractId = uuid();
        await tx.contract.create({
          data: {
            id: contractId,
            contractNo: args.contractNo,
            customerId: args.customerId,
            contractTypeId: contractTypeId(args.typeCode),
            status: args.status,
            contractedAt: args.contractedAt,
            balanceDueDate: args.balanceDueDate ?? null,
          },
        });
        const versionLineIds: string[][] = [];
        let currentVersionId: string | null = null;
        for (const v of args.versions) {
          const versionId = uuid();
          await tx.contractVersion.create({
            data: {
              id: versionId,
              contractId,
              versionNo: v.versionNo,
              versionStatus: v.versionStatus,
              changeReason: v.changeReason ?? null,
              totalAmount: v.total,
              depositAmount: v.deposit,
              balanceAmount: v.total - v.deposit,
              completionDueDate: v.completionDueDate ?? null,
              photoDate: v.photoDate ?? null,
              weddingDate: v.weddingDate ?? null,
              confirmedBy: v.confirmedAt ? adminId : null,
              confirmedAt: v.confirmedAt ?? null,
              createdBy: adminId,
            },
          });
          const lineIds: string[] = [];
          for (let i = 0; i < v.lines.length; i += 1) {
            const l = v.lines[i];
            const lineId = uuid();
            await tx.contractLine.create({
              data: {
                id: lineId,
                contractVersionId: versionId,
                transactionType: l.transactionType,
                productCategory: l.productCategory,
                itemDescription: l.itemDescription,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                lineAmount: l.unitPrice * l.quantity,
                sortOrder: i + 1,
              },
            });
            lineIds.push(lineId);
          }
          versionLineIds.push(lineIds);
          if (v.versionStatus !== 'SUPERSEDED') currentVersionId = versionId;
        }
        if (currentVersionId) {
          await tx.contract.update({ where: { id: contractId }, data: { currentVersionId } });
        }
        return { contractId, versionLineIds };
      };

      const order = async (args: {
        orderNo: string; contractId: string; transactionType: string; status: string;
        completionDueDate?: Date; photoDate?: Date; weddingDate?: Date;
      }): Promise<string> => {
        const id = uuid();
        await tx.order.create({
          data: {
            id,
            orderNo: args.orderNo,
            contractId: args.contractId,
            transactionType: args.transactionType,
            status: args.status,
            completionDueDate: args.completionDueDate ?? null,
            photoDate: args.photoDate ?? null,
            weddingDate: args.weddingDate ?? null,
          },
        });
        return id;
      };

      const orderItem = async (args: {
        orderId: string; lineId: string; productCategory: string; sequenceNo: number;
        displayName: string; status: string;
      }): Promise<string> => {
        const id = uuid();
        await tx.orderItem.create({
          data: {
            id,
            orderId: args.orderId,
            sourceContractLineId: args.lineId,
            productCategory: args.productCategory,
            sequenceNo: args.sequenceNo,
            displayName: args.displayName,
            status: args.status,
          },
        });
        return id;
      };

      const component = async (args: {
        orderItemId: string; componentType: string; status: string; sequenceNo?: number;
        expectedInboundDate?: Date; actualInboundAt?: Date; actualOutboundAt?: Date; notes?: string;
      }): Promise<string> => {
        const id = uuid();
        await tx.orderItemComponent.create({
          data: {
            id,
            orderItemId: args.orderItemId,
            componentType: args.componentType,
            sequenceNo: args.sequenceNo ?? 1,
            status: args.status,
            expectedInboundDate: args.expectedInboundDate ?? null,
            actualInboundAt: args.actualInboundAt ?? null,
            actualOutboundAt: args.actualOutboundAt ?? null,
            notes: args.notes ?? null,
          },
        });
        return id;
      };

      type OptionVersion = typeof suitVersion;
      const optionSession = async (args: {
        orderItemId: string; version: OptionVersion; picks: Array<'A' | 'B'>;
        status: 'IN_PROGRESS' | 'REVIEW' | 'CONFIRMED'; fabricName?: string;
        startedAt: Date; lastSavedAt: Date; reviewedAt?: Date; confirmedAt?: Date;
      }): Promise<string> => {
        const sessionId = uuid();
        const nextStage = args.version.stages[args.picks.length] ?? null;
        await tx.optionSelectionSession.create({
          data: {
            id: sessionId,
            orderItemId: args.orderItemId,
            optionSetVersionId: args.version.id,
            selectionVersionNo: 1,
            status: args.status,
            currentStageId: args.status === 'CONFIRMED' ? null : (nextStage?.id ?? null),
            fabricName: args.fabricName ?? null,
            startedAt: args.startedAt,
            lastSavedAt: args.lastSavedAt,
            reviewedAt: args.reviewedAt ?? null,
            confirmedAt: args.confirmedAt ?? null,
            isCurrent: true,
          },
        });
        for (let i = 0; i < args.picks.length; i += 1) {
          const stage = args.version.stages[i];
          if (!stage) break;
          const choice = stage.choices.find((c) => c.choiceCode === args.picks[i]) ?? stage.choices[0];
          await tx.optionSelectionValue.create({
            data: {
              id: uuid(),
              selectionSessionId: sessionId,
              optionStageId: stage.id,
              optionChoiceId: choice.id,
              selectedBy: adminId,
              selectedAt: args.lastSavedAt,
            },
          });
        }
        return sessionId;
      };

      const measurement = async (args: {
        customerId: string; relatedOrderId?: string; versionNo: number; measurementDate: Date;
        measurementType: 'INITIAL' | 'FITTING'; previousSessionId?: string; fitPreference?: string;
        bodyNotes?: string; completedAt: Date; rows: MeasureRow[]; linkOrderItemIds?: string[];
      }): Promise<SeededMeasurement> => {
        const sessionId = uuid();
        await tx.measurementSession.create({
          data: {
            id: sessionId,
            customerId: args.customerId,
            relatedOrderId: args.relatedOrderId ?? null,
            versionNo: args.versionNo,
            measurementDate: args.measurementDate,
            measurementType: args.measurementType,
            previousSessionId: args.previousSessionId ?? null,
            fitPreference: args.fitPreference ?? null,
            bodyNotes: args.bodyNotes ?? null,
            completedAt: args.completedAt,
            createdBy: adminId,
          },
        });
        for (const [code, bodySection, numericValue, textValue, unit, sortOrder] of args.rows) {
          await tx.measurementValue.create({
            data: {
              id: uuid(),
              measurementSessionId: sessionId,
              bodySection,
              measurementCode: code,
              numericValue,
              textValue,
              unit,
              sortOrder,
            },
          });
        }
        for (const orderItemId of args.linkOrderItemIds ?? []) {
          await tx.orderItemMeasurement.create({
            data: {
              id: uuid(),
              orderItemId,
              measurementSessionId: sessionId,
              isCurrent: true,
              linkedBy: adminId,
              linkedAt: args.completedAt,
            },
          });
        }
        return {
          id: sessionId,
          versionNo: args.versionNo,
          measurementDate: args.measurementDate,
          measurementType: args.measurementType,
          rows: args.rows,
        };
      };

      const workOrder = async (args: {
        orderItemId: string; orderNo: string; productCategory: string; sequenceNo: number;
        optionSessionId: string; measurementSession: SeededMeasurement; issuedAt: Date;
        status: 'ISSUED' | 'SENT';
      }): Promise<void> => {
        const workOrderId = uuid();
        await tx.workOrder.create({ data: { id: workOrderId, orderItemId: args.orderItemId } });
        const session = await tx.optionSelectionSession.findUniqueOrThrow({
          where: { id: args.optionSessionId },
          include: {
            values: {
              include: { optionStage: true, optionChoice: true },
              orderBy: { optionStage: { sequenceNo: 'asc' } },
            },
          },
        });
        const optionSnapshot: Prisma.InputJsonValue = {
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
        const m = args.measurementSession;
        const measurementSnapshot: Prisma.InputJsonValue = {
          measurementSessionId: m.id,
          versionNo: m.versionNo,
          measurementDate: m.measurementDate.toISOString().slice(0, 10),
          measurementType: m.measurementType,
          values: m.rows.map(([code, bodySection, numericValue, textValue, unit, sortOrder]) => ({
            bodySection, measurementCode: code, value: numericValue, textValue, unit, sortOrder,
          })),
        };
        const versionId = uuid();
        const fileName = `${args.orderNo}_${args.productCategory}-${String(args.sequenceNo).padStart(2, '0')}_V1.xlsx`;
        const outputFileId = await createFile(tx, {
          storageKey: `work-orders/${versionId}.xlsx`,
          originalName: fileName,
          mimeType: XLSX_MIME,
          buffer: Buffer.alloc(0),
        });
        await tx.workOrderVersion.create({
          data: {
            id: versionId,
            workOrderId,
            versionNo: 1,
            sourceOptionSessionId: args.optionSessionId,
            sourceMeasurementSessionId: m.id,
            optionSnapshot,
            measurementSnapshot,
            sourceHash: createHash('sha256')
              .update(JSON.stringify({ option: optionSnapshot, measurement: measurementSnapshot }))
              .digest('hex'),
            outputFileId,
            status: args.status,
            issuedBy: adminId,
            issuedAt: args.issuedAt,
          },
        });
        await tx.workOrder.update({ where: { id: workOrderId }, data: { currentVersionId: versionId } });
      };

      const productionEvent = async (args: {
        orderItemId: string; componentId?: string; eventType: string;
        previousStatus?: string; newStatus: string; expectedDate?: Date; eventDate: Date; notes?: string;
      }): Promise<void> => {
        await tx.productionEvent.create({
          data: {
            id: uuid(),
            orderItemId: args.orderItemId,
            componentId: args.componentId ?? null,
            eventType: args.eventType,
            previousStatus: args.previousStatus ?? null,
            newStatus: args.newStatus,
            expectedDate: args.expectedDate ?? null,
            eventDate: args.eventDate,
            notes: args.notes ?? null,
            actorId: adminId,
          },
        });
      };

      const payment = async (args: {
        contractId: string; paymentType: string; amount: number; paymentDate: Date;
        paymentMethod: string; status?: string; memo?: string;
      }): Promise<void> => {
        await tx.payment.create({
          data: {
            id: uuid(),
            contractId: args.contractId,
            paymentType: args.paymentType,
            amount: args.amount,
            paymentDate: args.paymentDate,
            paymentMethod: args.paymentMethod,
            status: args.status ?? 'COMPLETED',
            memo: args.memo ?? null,
            createdBy: adminId,
          },
        });
      };

      const appointment = async (args: {
        customerId: string; purposeCode: string; start: Date; end: Date; status: string;
        source?: 'CRM' | 'NAVER'; externalId?: string; notes?: string;
        naverUpdatedAt?: Date; syncedAt?: Date;
      }): Promise<string> => {
        const id = uuid();
        await tx.appointment.create({
          data: {
            id,
            customerId: args.customerId,
            source: args.source ?? 'CRM',
            externalId: args.externalId ?? null,
            purposeId: purposeId(args.purposeCode),
            scheduledStart: args.start,
            scheduledEnd: args.end,
            status: args.status,
            notes: args.notes ?? null,
            naverUpdatedAt: args.naverUpdatedAt ?? null,
            syncedAt: args.syncedAt ?? null,
          },
        });
        return id;
      };

      const consultation = async (args: {
        customerId: string; appointmentId?: string; consultedAt: Date; category: string; content: string;
      }): Promise<void> => {
        await tx.consultation.create({
          data: {
            id: uuid(),
            customerId: args.customerId,
            appointmentId: args.appointmentId ?? null,
            consultedAt: args.consultedAt,
            consultationCategory: args.category,
            content: args.content,
            staffId: adminId,
          },
        });
      };

      const repair = async (args: {
        customerId: string; repairType: string; requestDate: Date; dueDate?: Date; status: string;
        description: string; cost?: number; orderId?: string; orderItemId?: string; componentId?: string;
        rentalInventoryItemId?: string; notes?: string;
        events: Array<{ previousStatus?: string; newStatus: string; eventDate: Date }>;
      }): Promise<void> => {
        const id = uuid();
        await tx.repairRequest.create({
          data: {
            id,
            customerId: args.customerId,
            orderId: args.orderId ?? null,
            orderItemId: args.orderItemId ?? null,
            componentId: args.componentId ?? null,
            rentalInventoryItemId: args.rentalInventoryItemId ?? null,
            repairType: args.repairType,
            requestDate: args.requestDate,
            dueDate: args.dueDate ?? null,
            status: args.status,
            description: args.description,
            cost: args.cost ?? null,
            notes: args.notes ?? null,
          },
        });
        for (const e of args.events) {
          await tx.repairStatusEvent.create({
            data: {
              id: uuid(),
              repairRequestId: id,
              previousStatus: e.previousStatus ?? null,
              newStatus: e.newStatus,
              eventDate: e.eventDate,
              actorId: adminId,
            },
          });
        }
      };

      // 렌탈 재고 --------------------------------------------------------------
      const skuOf = async (componentType: string, design: string, color: string, size: string): Promise<string> => {
        const existing = await tx.rentalSku.findFirst({ where: { componentType, design, color, size } });
        if (existing) return existing.id;
        const id = uuid();
        await tx.rentalSku.create({ data: { id, componentType, design, color, size, active: true } });
        return id;
      };
      const inventoryIds: Record<string, string> = {};
      const inventory = async (
        managementCode: string,
        rentalSkuId: string,
        status: string,
        extra?: { availableFrom?: Date; notes?: string },
      ): Promise<string> => {
        const id = uuid();
        await tx.rentalInventoryItem.create({
          data: {
            id,
            managementCode,
            rentalSkuId,
            status,
            availableFrom: extra?.availableFrom ?? null,
            notes: extra?.notes ?? null,
            active: true,
            acquiredAt: dateOnly(-200),
          },
        });
        inventoryIds[managementCode] = id;
        return id;
      };
      const allocation = async (args: {
        componentId: string; managementCode: string; pickupDate: Date; returnDueDate: Date;
        availabilityEndDate: Date; status: 'RESERVED' | 'CHECKED_OUT' | 'RETURNED';
        assignedAt: Date; actualPickupAt?: Date; actualReturnAt?: Date;
      }): Promise<void> => {
        const id = uuid();
        const itemId = inventoryIds[args.managementCode];
        await tx.rentalAllocation.create({
          data: {
            id,
            orderItemComponentId: args.componentId,
            rentalInventoryItemId: itemId,
            pickupDate: args.pickupDate,
            returnDueDate: args.returnDueDate,
            availabilityEndDate: args.availabilityEndDate,
            actualPickupAt: args.actualPickupAt ?? null,
            actualReturnAt: args.actualReturnAt ?? null,
            status: args.status,
            assignedBy: adminId,
            assignedAt: args.assignedAt,
          },
        });
        const event = async (eventType: string, occurredAt: Date): Promise<void> => {
          await tx.rentalAllocationEvent.create({
            data: {
              id: uuid(),
              rentalAllocationId: id,
              eventType,
              newInventoryItemId: itemId,
              actorId: adminId,
              occurredAt,
            },
          });
        };
        await event('ASSIGNED', args.assignedAt);
        if (args.actualPickupAt) await event('PICKED_UP', args.actualPickupAt);
        if (args.actualReturnAt) await event('RETURNED', args.actualReturnAt);
      };

      // =====================================================================
      // 1) 신규 고객 6명
      // =====================================================================
      const 한지민 = await customer({
        name: '한지민', phone: '010-7701-1001', email: 'jimin.han@example.com', status: 'CONTRACTED',
        firstReservedAt: at(-28, 11), contractedAt: at(-24, 15),
        notes: '웨딩 패키지(맞춤 2벌 + 렌탈). 예식 D-30, 가봉 일정 우선 배정 요청',
      });
      const 오세훈 = await customer({
        name: '오세훈', phone: '010-7701-1002', email: 'sehun.oh@example.com', status: 'CONTRACTED',
        firstReservedAt: at(-18, 10), contractedAt: at(-16, 17),
        notes: '비즈니스 정장 + 셔츠 2장. 잔금 예정일 경과 — 결제 안내 필요',
      });
      const 서지우 = await customer({
        name: '서지우', phone: '010-7701-1003', status: 'CONTRACTED',
        firstReservedAt: at(-70, 13), contractedAt: at(-65, 14),
        notes: '렌탈 전용 고객. 반납 완료, 재이용 가능성 높음',
      });
      const 문가영 = await customer({
        name: '문가영', phone: '010-7701-1004', status: 'PROSPECT', firstReservedAt: at(0, 9),
        notes: '네이버 예약 유입, 예산 문의 단계',
      });
      const 배정훈 = await customer({
        name: '배정훈', phone: '010-7701-1005', status: 'CONTRACTED',
        firstReservedAt: at(-45, 16), contractedAt: at(-40, 11),
        notes: '개인 사정으로 계약 취소, 계약금 환불 완료',
      });
      const 윤도현 = await customer({
        name: '윤도현', phone: '010-7701-1006', email: 'dohyun.yun@example.com', status: 'CONTRACTED',
        firstReservedAt: at(-12, 15), contractedAt: at(-9, 16),
        notes: '행사용 렌탈 대여 중, 반납 예정일 임박',
      });
      console.log('customers: +6건');

      // =====================================================================
      // 2) 렌탈 SKU·실물 확장
      // =====================================================================
      const skuJktGry100 = await skuOf('JACKET', '쓰리피스 클래식', 'GREY', '100');
      const skuVstGry100 = await skuOf('VEST', '쓰리피스 베스트', 'GREY', '100');
      const skuShoBrn270 = await skuOf('SHOES', '더비 플레인토', 'BROWN', '270');
      const skuJktBlk100 = await skuOf('JACKET', '클래식 원버튼 턱시도', 'BLACK', '100');
      const skuJktBlk105 = await skuOf('JACKET', '클래식 원버튼 턱시도', 'BLACK', '105');
      const skuPntBlk32 = await skuOf('TROUSERS', '클래식 턱시도 팬츠', 'BLACK', '32');
      const skuPntBlk34 = await skuOf('TROUSERS', '클래식 턱시도 팬츠', 'BLACK', '34');
      const skuShtWht100 = await skuOf('SHIRT', '윙칼라 셔츠', 'WHITE', '100');
      const skuShoBlk275 = await skuOf('SHOES', '스트레이트팁 옥스포드', 'BLACK', '275');

      await inventory('JKT-GRY-100-001', skuJktGry100, 'RESERVED'); // 한지민 픽업 예정
      await inventory('JKT-GRY-100-002', skuJktGry100, 'AVAILABLE');
      await inventory('VST-GRY-100-001', skuVstGry100, 'RESERVED'); // 한지민 픽업 예정
      await inventory('VST-GRY-100-002', skuVstGry100, 'AVAILABLE');
      await inventory('SHO-BRN-270-001', skuShoBrn270, 'AVAILABLE');
      await inventory('SHO-BRN-270-002', skuShoBrn270, 'CHECKED_OUT'); // 윤도현 대여 중
      await inventory('JKT-BLK-100-004', skuJktBlk100, 'CHECKED_OUT'); // 윤도현 대여 중
      await inventory('JKT-BLK-105-003', skuJktBlk105, 'AVAILABLE');
      await inventory('PNT-BLK-32-005', skuPntBlk32, 'AVAILABLE');
      await inventory('PNT-BLK-34-003', skuPntBlk34, 'RETURNED_HOLD', { notes: '반납 검수 대기 (서지우 반납분)' });
      await inventory('SHT-WHT-100-003', skuShtWht100, 'AVAILABLE');
      await inventory('SHO-BLK-275-002', skuShoBlk275, 'AVAILABLE');
      console.log('rental_skus: +3건 / rental_inventory_items: +12건');

      // =====================================================================
      // 3) 한지민 — 웨딩 패키지 (맞춤 2 + 렌탈 3), 옵션·채촌·작업지시서 전체 흐름
      // =====================================================================
      const hjm = await createContract({
        contractNo: 'CTR-260625-101', customerId: 한지민, typeCode: 'WEDDING_PACKAGE_RENTAL',
        status: 'CONFIRMED', contractedAt: at(-24, 15), balanceDueDate: dateOnly(12),
        versions: [
          {
            versionNo: 1, versionStatus: 'SUPERSEDED', total: 3600000, deposit: 1500000,
            confirmedAt: at(-24, 15), completionDueDate: dateOnly(16), photoDate: dateOnly(21), weddingDate: dateOnly(30),
            lines: [
              { transactionType: 'CUSTOM', productCategory: 'SUIT', itemDescription: '맞춤 예복 정장', quantity: 2, unitPrice: 1400000 },
              { transactionType: 'RENTAL', productCategory: 'SUIT', itemDescription: '렌탈 촬영용 쓰리피스', quantity: 1, unitPrice: 500000 },
              { transactionType: 'RENTAL', productCategory: 'SHOES', itemDescription: '렌탈 구두', quantity: 1, unitPrice: 150000 },
            ],
          },
          {
            versionNo: 2, versionStatus: 'CONFIRMED', total: 4200000, deposit: 1500000,
            confirmedAt: at(-18, 14), completionDueDate: dateOnly(16), photoDate: dateOnly(21), weddingDate: dateOnly(30),
            changeReason: '맞춤 셔츠 2장 추가',
            lines: [
              { transactionType: 'CUSTOM', productCategory: 'SUIT', itemDescription: '맞춤 예복 정장', quantity: 2, unitPrice: 1400000 },
              { transactionType: 'CUSTOM', productCategory: 'SHIRT', itemDescription: '맞춤 드레스 셔츠', quantity: 2, unitPrice: 300000 },
              { transactionType: 'RENTAL', productCategory: 'SUIT', itemDescription: '렌탈 촬영용 쓰리피스', quantity: 1, unitPrice: 500000 },
              { transactionType: 'RENTAL', productCategory: 'SHOES', itemDescription: '렌탈 구두', quantity: 1, unitPrice: 150000 },
            ],
          },
        ],
      });
      const hjmLines = hjm.versionLineIds[1];

      const hjmCustomOrder = await order({
        orderNo: 'ORD-260625-101', contractId: hjm.contractId, transactionType: 'CUSTOM', status: 'IN_PROGRESS',
        completionDueDate: dateOnly(16), photoDate: dateOnly(21), weddingDate: dateOnly(30),
      });
      const hjmRentalOrder = await order({
        orderNo: 'ORD-260625-102', contractId: hjm.contractId, transactionType: 'RENTAL', status: 'IN_PROGRESS',
        completionDueDate: dateOnly(21), photoDate: dateOnly(21), weddingDate: dateOnly(30),
      });

      const hjmSuit1 = await orderItem({ orderId: hjmCustomOrder, lineId: hjmLines[0], productCategory: 'SUIT', sequenceNo: 1, displayName: '예복 정장 #1', status: 'PRODUCTION_IN_PROGRESS' });
      const hjmSuit2 = await orderItem({ orderId: hjmCustomOrder, lineId: hjmLines[0], productCategory: 'SUIT', sequenceNo: 2, displayName: '예복 정장 #2', status: 'OPTION_PENDING' });
      const hjmShirt1 = await orderItem({ orderId: hjmCustomOrder, lineId: hjmLines[1], productCategory: 'SHIRT', sequenceNo: 1, displayName: '드레스 셔츠 #1', status: 'READY_TO_ORDER' });
      const hjmShirt2 = await orderItem({ orderId: hjmCustomOrder, lineId: hjmLines[1], productCategory: 'SHIRT', sequenceNo: 2, displayName: '드레스 셔츠 #2', status: 'MEASUREMENT_PENDING' });

      const hjmSuit1Jacket = await component({ orderItemId: hjmSuit1, componentType: 'JACKET', status: 'PRODUCTION_IN_PROGRESS', expectedInboundDate: dateOnly(6) });
      const hjmSuit1Trousers = await component({ orderItemId: hjmSuit1, componentType: 'TROUSERS', status: 'PRODUCTION_IN_PROGRESS', expectedInboundDate: dateOnly(6) });
      const hjmSuit1Vest = await component({ orderItemId: hjmSuit1, componentType: 'VEST', status: 'RECEIVED', expectedInboundDate: dateOnly(-2), actualInboundAt: at(-2, 11) });
      await component({ orderItemId: hjmSuit2, componentType: 'JACKET', status: 'CREATED' });
      await component({ orderItemId: hjmSuit2, componentType: 'TROUSERS', status: 'CREATED' });
      await component({ orderItemId: hjmShirt1, componentType: 'SHIRT', status: 'CREATED', expectedInboundDate: dateOnly(9) });
      await component({ orderItemId: hjmShirt2, componentType: 'SHIRT', status: 'CREATED' });

      const hjmRentalSuit = await orderItem({ orderId: hjmRentalOrder, lineId: hjmLines[2], productCategory: 'SUIT', sequenceNo: 1, displayName: '렌탈 쓰리피스 #1', status: 'CREATED' });
      const hjmRentalShoes = await orderItem({ orderId: hjmRentalOrder, lineId: hjmLines[3], productCategory: 'SHOES', sequenceNo: 1, displayName: '렌탈 구두 #1', status: 'CREATED' });
      const hjmRentalJacket = await component({ orderItemId: hjmRentalSuit, componentType: 'JACKET', status: 'RESERVED' });
      const hjmRentalVest = await component({ orderItemId: hjmRentalSuit, componentType: 'VEST', status: 'RESERVED' });
      const hjmRentalShoesCmp = await component({ orderItemId: hjmRentalShoes, componentType: 'SHOES', status: 'CREATED' });

      const hjmMeasure = await measurement({
        customerId: 한지민, relatedOrderId: hjmCustomOrder, versionNo: 1, measurementDate: dateOnly(-20),
        measurementType: 'INITIAL', fitPreference: 'STANDARD', bodyNotes: '오른쪽 어깨가 약간 높음',
        completedAt: at(-20, 12), linkOrderItemIds: [hjmSuit1, hjmShirt1],
        rows: measurementRows({
          neck: 39.5, shoulder: 45.5, chest: 100, sleeve: 62, bodyLength: 74, wrist: 17.5, upperSize: '100',
          waist: 84, hip: 98, rise: 25.5, pantsLength: 102, thigh: 60, calf: 38, lowerSize: '33', shoeSize: 265,
        }),
      });
      const hjmFitting = await measurement({
        customerId: 한지민, relatedOrderId: hjmCustomOrder, versionNo: 2, measurementDate: dateOnly(-4),
        measurementType: 'FITTING', previousSessionId: hjmMeasure.id, fitPreference: 'SLIM',
        bodyNotes: '가봉 후 자켓 소매 0.5cm 축소', completedAt: at(-4, 15),
        rows: measurementRows({
          neck: 39.5, shoulder: 45.5, chest: 99, sleeve: 61.5, bodyLength: 74, wrist: 17, upperSize: '100',
          waist: 83, hip: 98, rise: 25.5, pantsLength: 101.5, thigh: 59, calf: 38, lowerSize: '33', shoeSize: 265,
        }),
      });

      const hjmSuit1Option = await optionSession({
        orderItemId: hjmSuit1, version: suitVersion,
        picks: ['A', 'A', 'B', 'A', 'B', 'A', 'A', 'B', 'A', 'A', 'A'],
        status: 'CONFIRMED', fabricName: 'Loro Piana 130수 차콜',
        startedAt: at(-22, 11), lastSavedAt: at(-21, 16), reviewedAt: at(-21, 17), confirmedAt: at(-21, 17, 30),
      });
      await optionSession({
        orderItemId: hjmSuit2, version: suitVersion, picks: ['A', 'B', 'A'],
        status: 'IN_PROGRESS', fabricName: 'VBC 110수 미드나잇 네이비',
        startedAt: at(-3, 14), lastSavedAt: at(-1, 15),
      });
      const hjmShirtOption = await optionSession({
        orderItemId: hjmShirt1, version: shirtVersion, picks: ['A', 'B', 'A'],
        status: 'CONFIRMED', fabricName: 'Thomas Mason 화이트 포플린',
        startedAt: at(-16, 10), lastSavedAt: at(-16, 11), reviewedAt: at(-16, 11, 30), confirmedAt: at(-16, 12),
      });

      await workOrder({
        orderItemId: hjmSuit1, orderNo: 'ORD-260625-101', productCategory: 'SUIT', sequenceNo: 1,
        optionSessionId: hjmSuit1Option, measurementSession: hjmMeasure, issuedAt: at(-19, 10), status: 'SENT',
      });
      await workOrder({
        orderItemId: hjmShirt1, orderNo: 'ORD-260625-101', productCategory: 'SHIRT', sequenceNo: 1,
        optionSessionId: hjmShirtOption, measurementSession: hjmMeasure, issuedAt: at(-15, 10), status: 'ISSUED',
      });

      await productionEvent({ orderItemId: hjmSuit1, componentId: hjmSuit1Jacket, eventType: 'PRODUCTION_REQUESTED', previousStatus: 'CREATED', newStatus: 'PRODUCTION_REQUESTED', eventDate: dateOnly(-19) });
      await productionEvent({ orderItemId: hjmSuit1, componentId: hjmSuit1Jacket, eventType: 'PRODUCTION_IN_PROGRESS', previousStatus: 'PRODUCTION_REQUESTED', newStatus: 'PRODUCTION_IN_PROGRESS', expectedDate: dateOnly(6), eventDate: dateOnly(-14) });
      await productionEvent({ orderItemId: hjmSuit1, componentId: hjmSuit1Vest, eventType: 'RECEIVED', previousStatus: 'PRODUCTION_IN_PROGRESS', newStatus: 'RECEIVED', eventDate: dateOnly(-2), notes: '베스트 선입고' });
      await productionEvent({ orderItemId: hjmSuit1, componentId: hjmSuit1Trousers, eventType: 'PRODUCTION_IN_PROGRESS', previousStatus: 'PRODUCTION_REQUESTED', newStatus: 'PRODUCTION_IN_PROGRESS', expectedDate: dateOnly(6), eventDate: dateOnly(-14) });

      await allocation({ componentId: hjmRentalJacket, managementCode: 'JKT-GRY-100-001', pickupDate: dateOnly(2), returnDueDate: dateOnly(6), availabilityEndDate: dateOnly(8), status: 'RESERVED', assignedAt: at(-5, 11) });
      await allocation({ componentId: hjmRentalVest, managementCode: 'VST-GRY-100-001', pickupDate: dateOnly(2), returnDueDate: dateOnly(6), availabilityEndDate: dateOnly(8), status: 'RESERVED', assignedAt: at(-5, 11) });
      void hjmRentalShoesCmp; // 구두는 미배정(배정 대기 데모)

      await payment({ contractId: hjm.contractId, paymentType: 'DEPOSIT', amount: 1500000, paymentDate: dateOnly(-24), paymentMethod: 'CARD', memo: '입금자: 한지민' });
      await payment({ contractId: hjm.contractId, paymentType: 'INTERIM', amount: 1000000, paymentDate: dateOnly(-10), paymentMethod: 'TRANSFER', memo: '중도금' });

      const hjmAp1 = await appointment({ customerId: 한지민, purposeCode: 'INITIAL_CONSULTATION', start: at(-28, 11), end: at(-28, 12), status: 'VISITED', notes: '웨딩 패키지 상담' });
      await appointment({ customerId: 한지민, purposeCode: 'FITTING', start: at(-4, 15), end: at(-4, 16), status: 'VISITED', notes: '1차 가봉 완료' });
      await appointment({ customerId: 한지민, purposeCode: 'RENTAL_PICKUP', start: at(2, 11), end: at(2, 11, 30), status: 'CONFIRMED', notes: '촬영용 렌탈 픽업' });
      await appointment({ customerId: 한지민, purposeCode: 'FITTING', start: at(9, 14), end: at(9, 15), status: 'RESERVED', notes: '2차 가봉' });
      await consultation({
        customerId: 한지민, appointmentId: hjmAp1, consultedAt: at(-28, 11, 20), category: '웨딩,맞춤정장,렌탈',
        content: '예식·촬영 일정 확인. 예복 2벌(신랑·혼주) 맞춤 + 촬영용 렌탈 쓰리피스. 예산 400만원대, 차콜 계열 선호.',
      });
      await consultation({
        customerId: 한지민, consultedAt: at(-4, 15, 40), category: '가봉,수선',
        content: '1차 가봉 결과 자켓 소매 0.5cm 축소, 바지 기장 1cm 조정 요청. 2차 가봉 일정 안내함.',
      });

      // =====================================================================
      // 4) 오세훈 — 비즈니스 맞춤, 입고 지연 + 잔금 미수
      // =====================================================================
      const osh = await createContract({
        contractNo: 'CTR-260707-102', customerId: 오세훈, typeCode: 'BUSINESS_SUIT_CUSTOM',
        status: 'CONFIRMED', contractedAt: at(-16, 17), balanceDueDate: dateOnly(-3),
        versions: [
          {
            versionNo: 1, versionStatus: 'CONFIRMED', total: 2100000, deposit: 700000,
            confirmedAt: at(-16, 17), completionDueDate: dateOnly(5),
            lines: [
              { transactionType: 'CUSTOM', productCategory: 'SUIT', itemDescription: '맞춤 비즈니스 정장', quantity: 1, unitPrice: 1500000 },
              { transactionType: 'CUSTOM', productCategory: 'SHIRT', itemDescription: '맞춤 셔츠', quantity: 2, unitPrice: 300000 },
            ],
          },
        ],
      });
      const oshLines = osh.versionLineIds[0];
      const oshOrder = await order({ orderNo: 'ORD-260707-102', contractId: osh.contractId, transactionType: 'CUSTOM', status: 'IN_PROGRESS', completionDueDate: dateOnly(5) });
      const oshSuit = await orderItem({ orderId: oshOrder, lineId: oshLines[0], productCategory: 'SUIT', sequenceNo: 1, displayName: '정장 #1', status: 'PARTIALLY_RECEIVED' });
      const oshShirt1 = await orderItem({ orderId: oshOrder, lineId: oshLines[1], productCategory: 'SHIRT', sequenceNo: 1, displayName: '셔츠 #1', status: 'RECEIVED' });
      const oshShirt2 = await orderItem({ orderId: oshOrder, lineId: oshLines[1], productCategory: 'SHIRT', sequenceNo: 2, displayName: '셔츠 #2', status: 'PRODUCTION_IN_PROGRESS' });
      const oshSuitJacket = await component({ orderItemId: oshSuit, componentType: 'JACKET', status: 'RECEIVED', expectedInboundDate: dateOnly(-3), actualInboundAt: at(-3, 10) });
      const oshSuitTrousers = await component({ orderItemId: oshSuit, componentType: 'TROUSERS', status: 'PRODUCTION_IN_PROGRESS', expectedInboundDate: dateOnly(-1), notes: '공장 입고 지연 — 재확인 필요' });
      await component({ orderItemId: oshShirt1, componentType: 'SHIRT', status: 'RECEIVED', expectedInboundDate: dateOnly(-6), actualInboundAt: at(-6, 11) });
      await component({ orderItemId: oshShirt2, componentType: 'SHIRT', status: 'PRODUCTION_IN_PROGRESS', expectedInboundDate: dateOnly(2) });

      const oshMeasure = await measurement({
        customerId: 오세훈, relatedOrderId: oshOrder, versionNo: 1, measurementDate: dateOnly(-15),
        measurementType: 'INITIAL', fitPreference: 'SLIM', completedAt: at(-15, 11),
        linkOrderItemIds: [oshSuit, oshShirt1, oshShirt2],
        rows: measurementRows({
          neck: 41, shoulder: 47, chest: 104, sleeve: 63.5, bodyLength: 75.5, wrist: 18, upperSize: '105',
          waist: 90, hip: 102, rise: 26, pantsLength: 103, thigh: 63, calf: 40, lowerSize: '35', shoeSize: 275,
        }),
      });
      const oshOption = await optionSession({
        orderItemId: oshSuit, version: suitVersion,
        picks: ['B', 'A', 'A', 'B', 'A', 'A', 'B', 'A', 'A', 'A', 'B'],
        status: 'CONFIRMED', fabricName: 'Reda 100수 미디엄 그레이',
        startedAt: at(-15, 13), lastSavedAt: at(-15, 14), reviewedAt: at(-15, 14, 30), confirmedAt: at(-15, 15),
      });
      await optionSession({
        orderItemId: oshShirt2, version: shirtVersion, picks: ['B', 'A', 'B'],
        status: 'REVIEW', fabricName: 'Canclini 라이트블루 옥스포드',
        startedAt: at(-2, 10), lastSavedAt: at(-2, 11), reviewedAt: at(-1, 9),
      });
      await workOrder({
        orderItemId: oshSuit, orderNo: 'ORD-260707-102', productCategory: 'SUIT', sequenceNo: 1,
        optionSessionId: oshOption, measurementSession: oshMeasure, issuedAt: at(-14, 9, 30), status: 'SENT',
      });
      await productionEvent({ orderItemId: oshSuit, componentId: oshSuitJacket, eventType: 'RECEIVED', previousStatus: 'PRODUCTION_IN_PROGRESS', newStatus: 'RECEIVED', eventDate: dateOnly(-3) });
      await productionEvent({ orderItemId: oshSuit, componentId: oshSuitTrousers, eventType: 'PRODUCTION_IN_PROGRESS', previousStatus: 'PRODUCTION_REQUESTED', newStatus: 'PRODUCTION_IN_PROGRESS', expectedDate: dateOnly(-1), eventDate: dateOnly(-12), notes: '입고 예정일 경과 — 지연' });
      await productionEvent({ orderItemId: oshSuit, eventType: 'ITEM_STATUS_AGGREGATED', previousStatus: 'PRODUCTION_IN_PROGRESS', newStatus: 'PARTIALLY_RECEIVED', eventDate: dateOnly(-3), notes: '자켓만 입고' });

      await payment({ contractId: osh.contractId, paymentType: 'DEPOSIT', amount: 700000, paymentDate: dateOnly(-16), paymentMethod: 'CARD', memo: '입금자: 오세훈' });
      const oshAp = await appointment({ customerId: 오세훈, purposeCode: 'INITIAL_CONSULTATION', start: at(-18, 10), end: at(-18, 11), status: 'VISITED' });
      await appointment({ customerId: 오세훈, purposeCode: 'FITTING', start: at(1, 19), end: at(1, 20), status: 'RESERVED', notes: '퇴근 후 가봉 요청' });
      await appointment({ customerId: 오세훈, purposeCode: 'PICKUP', start: at(6, 12), end: at(6, 12, 30), status: 'RESERVED', notes: '셔츠 #1 픽업' });
      await consultation({
        customerId: 오세훈, appointmentId: oshAp, consultedAt: at(-18, 10, 20), category: '비즈니스,맞춤정장',
        content: '출근용 정장 1벌 + 셔츠 2장. 슬림핏 선호, 그레이 계열. 잔금은 인수 시 카드 결제 예정.',
      });

      // =====================================================================
      // 5) 서지우 — 렌탈 완료(반납 완료 + 반납 후 수선)
      // =====================================================================
      const sjw = await createContract({
        contractNo: 'CTR-260512-103', customerId: 서지우, typeCode: 'WEDDING_PACKAGE_RENTAL',
        status: 'COMPLETED', contractedAt: at(-65, 14), balanceDueDate: null,
        versions: [
          {
            versionNo: 1, versionStatus: 'CONFIRMED', total: 900000, deposit: 300000,
            confirmedAt: at(-65, 14), completionDueDate: dateOnly(-40),
            lines: [
              { transactionType: 'RENTAL', productCategory: 'SUIT', itemDescription: '렌탈 예식용 턱시도', quantity: 1, unitPrice: 700000 },
              { transactionType: 'RENTAL', productCategory: 'SHOES', itemDescription: '렌탈 구두', quantity: 1, unitPrice: 200000 },
            ],
          },
        ],
      });
      const sjwLines = sjw.versionLineIds[0];
      const sjwOrder = await order({ orderNo: 'ORD-260512-103', contractId: sjw.contractId, transactionType: 'RENTAL', status: 'COMPLETED', completionDueDate: dateOnly(-40) });
      const sjwSuit = await orderItem({ orderId: sjwOrder, lineId: sjwLines[0], productCategory: 'SUIT', sequenceNo: 1, displayName: '렌탈 턱시도 #1', status: 'COMPLETED' });
      const sjwShoes = await orderItem({ orderId: sjwOrder, lineId: sjwLines[1], productCategory: 'SHOES', sequenceNo: 1, displayName: '렌탈 구두 #1', status: 'COMPLETED' });
      const sjwJacket = await component({ orderItemId: sjwSuit, componentType: 'JACKET', status: 'RELEASED', actualOutboundAt: at(-46, 10) });
      const sjwTrousers = await component({ orderItemId: sjwSuit, componentType: 'TROUSERS', status: 'RELEASED', actualOutboundAt: at(-46, 10) });
      const sjwShoesCmp = await component({ orderItemId: sjwShoes, componentType: 'SHOES', status: 'RELEASED', actualOutboundAt: at(-46, 10) });
      await allocation({ componentId: sjwJacket, managementCode: 'JKT-BLK-105-003', pickupDate: dateOnly(-46), returnDueDate: dateOnly(-42), availabilityEndDate: dateOnly(-40), status: 'RETURNED', assignedAt: at(-50, 10), actualPickupAt: at(-46, 10), actualReturnAt: at(-42, 15) });
      await allocation({ componentId: sjwTrousers, managementCode: 'PNT-BLK-34-003', pickupDate: dateOnly(-46), returnDueDate: dateOnly(-42), availabilityEndDate: dateOnly(-40), status: 'RETURNED', assignedAt: at(-50, 10), actualPickupAt: at(-46, 10), actualReturnAt: at(-42, 15) });
      await allocation({ componentId: sjwShoesCmp, managementCode: 'SHO-BLK-275-002', pickupDate: dateOnly(-46), returnDueDate: dateOnly(-42), availabilityEndDate: dateOnly(-40), status: 'RETURNED', assignedAt: at(-50, 10), actualPickupAt: at(-46, 10), actualReturnAt: at(-42, 15) });
      await tx.rentalInventoryStatusEvent.create({
        data: {
          id: uuid(), rentalInventoryItemId: inventoryIds['PNT-BLK-34-003'],
          previousStatus: 'CHECKED_OUT', newStatus: 'RETURNED_HOLD',
          reason: '반납 검수 대기', actorId: adminId, occurredAt: at(-42, 15, 30),
        },
      });
      await payment({ contractId: sjw.contractId, paymentType: 'DEPOSIT', amount: 300000, paymentDate: dateOnly(-65), paymentMethod: 'TRANSFER' });
      await payment({ contractId: sjw.contractId, paymentType: 'BALANCE', amount: 600000, paymentDate: dateOnly(-46), paymentMethod: 'CARD', memo: '픽업 시 잔금 완납' });
      await payment({ contractId: sjw.contractId, paymentType: 'REPAIR_FEE', amount: 40000, paymentDate: dateOnly(-38), paymentMethod: 'CASH', memo: '반납 후 수선비' });
      await appointment({ customerId: 서지우, purposeCode: 'RENTAL_PICKUP', start: at(-46, 10), end: at(-46, 10, 30), status: 'VISITED' });
      await appointment({ customerId: 서지우, purposeCode: 'RENTAL_RETURN', start: at(-42, 15), end: at(-42, 15, 30), status: 'VISITED' });
      await consultation({
        customerId: 서지우, consultedAt: at(-70, 13, 20), category: '렌탈,웨딩',
        content: '예식 당일 렌탈 턱시도·구두 상담. 사이즈 105 / 275 확인. 반납은 예식 다음날로 협의.',
      });

      // =====================================================================
      // 6) 배정훈 — 계약 취소 + 환불
      // =====================================================================
      const bjh = await createContract({
        contractNo: 'CTR-260611-105', customerId: 배정훈, typeCode: 'BUSINESS_SUIT_CUSTOM',
        status: 'CANCELLED', contractedAt: at(-40, 11), balanceDueDate: null,
        versions: [
          {
            versionNo: 1, versionStatus: 'CONFIRMED', total: 1300000, deposit: 400000,
            confirmedAt: at(-40, 11), completionDueDate: dateOnly(-5),
            lines: [
              { transactionType: 'CUSTOM', productCategory: 'SUIT', itemDescription: '맞춤 비즈니스 정장', quantity: 1, unitPrice: 1300000 },
            ],
          },
        ],
      });
      const bjhOrder = await order({ orderNo: 'ORD-260611-105', contractId: bjh.contractId, transactionType: 'CUSTOM', status: 'CANCELLED', completionDueDate: dateOnly(-5) });
      const bjhSuit = await orderItem({ orderId: bjhOrder, lineId: bjh.versionLineIds[0][0], productCategory: 'SUIT', sequenceNo: 1, displayName: '정장 #1', status: 'CANCELLED' });
      await component({ orderItemId: bjhSuit, componentType: 'JACKET', status: 'CANCELLED' });
      await component({ orderItemId: bjhSuit, componentType: 'TROUSERS', status: 'CANCELLED' });
      await payment({ contractId: bjh.contractId, paymentType: 'DEPOSIT', amount: 400000, paymentDate: dateOnly(-40), paymentMethod: 'CARD' });
      await payment({ contractId: bjh.contractId, paymentType: 'REFUND', amount: 400000, paymentDate: dateOnly(-33), paymentMethod: 'TRANSFER', memo: '고객 요청 취소 — 계약금 전액 환불' });
      await appointment({ customerId: 배정훈, purposeCode: 'INITIAL_CONSULTATION', start: at(-45, 16), end: at(-45, 17), status: 'VISITED' });
      await appointment({ customerId: 배정훈, purposeCode: 'FITTING', start: at(-30, 14), end: at(-30, 15), status: 'CANCELLED', notes: '계약 취소로 가봉 취소' });
      await consultation({
        customerId: 배정훈, consultedAt: at(-45, 16, 30), category: '맞춤정장',
        content: '출장 일정 변동 가능성 있어 납기 문의. 이후 개인 사정으로 계약 취소, 계약금 환불 처리.',
      });

      // =====================================================================
      // 7) 윤도현 — 렌탈 대여 중 (반납 임박)
      // =====================================================================
      const ydh = await createContract({
        contractNo: 'CTR-260712-106', customerId: 윤도현, typeCode: 'WEDDING_PACKAGE_RENTAL',
        status: 'CONFIRMED', contractedAt: at(-9, 16), balanceDueDate: dateOnly(3),
        versions: [
          {
            versionNo: 1, versionStatus: 'CONFIRMED', total: 750000, deposit: 250000,
            confirmedAt: at(-9, 16), completionDueDate: dateOnly(4),
            lines: [
              { transactionType: 'RENTAL', productCategory: 'SUIT', itemDescription: '렌탈 행사용 정장', quantity: 1, unitPrice: 550000 },
              { transactionType: 'RENTAL', productCategory: 'SHOES', itemDescription: '렌탈 구두', quantity: 1, unitPrice: 200000 },
            ],
          },
        ],
      });
      const ydhLines = ydh.versionLineIds[0];
      const ydhOrder = await order({ orderNo: 'ORD-260712-106', contractId: ydh.contractId, transactionType: 'RENTAL', status: 'IN_PROGRESS', completionDueDate: dateOnly(4) });
      const ydhSuit = await orderItem({ orderId: ydhOrder, lineId: ydhLines[0], productCategory: 'SUIT', sequenceNo: 1, displayName: '렌탈 정장 #1', status: 'RELEASED' });
      const ydhShoes = await orderItem({ orderId: ydhOrder, lineId: ydhLines[1], productCategory: 'SHOES', sequenceNo: 1, displayName: '렌탈 구두 #1', status: 'RELEASED' });
      const ydhJacket = await component({ orderItemId: ydhSuit, componentType: 'JACKET', status: 'RELEASED', actualOutboundAt: at(-4, 11) });
      const ydhShoesCmp = await component({ orderItemId: ydhShoes, componentType: 'SHOES', status: 'RELEASED', actualOutboundAt: at(-4, 11) });
      await allocation({ componentId: ydhJacket, managementCode: 'JKT-BLK-100-004', pickupDate: dateOnly(-4), returnDueDate: dateOnly(1), availabilityEndDate: dateOnly(3), status: 'CHECKED_OUT', assignedAt: at(-8, 10), actualPickupAt: at(-4, 11) });
      await allocation({ componentId: ydhShoesCmp, managementCode: 'SHO-BRN-270-002', pickupDate: dateOnly(-4), returnDueDate: dateOnly(1), availabilityEndDate: dateOnly(3), status: 'CHECKED_OUT', assignedAt: at(-8, 10), actualPickupAt: at(-4, 11) });
      await payment({ contractId: ydh.contractId, paymentType: 'DEPOSIT', amount: 250000, paymentDate: dateOnly(-9), paymentMethod: 'CARD' });
      await appointment({ customerId: 윤도현, purposeCode: 'RENTAL_PICKUP', start: at(-4, 11), end: at(-4, 11, 30), status: 'VISITED' });
      await appointment({ customerId: 윤도현, purposeCode: 'RENTAL_RETURN', start: at(1, 10), end: at(1, 10, 30), status: 'CONFIRMED', notes: '반납 예정 — 검수 후 잔금 정산' });
      await consultation({
        customerId: 윤도현, consultedAt: at(-12, 15, 20), category: '렌탈',
        content: '회사 행사용 렌탈 정장 문의. 브라운 구두 매칭 추천, 4일 대여로 확정.',
      });

      // =====================================================================
      // 8) 문가영 — 신규 문의 (네이버 예약 + 상담만)
      // =====================================================================
      const mgyAp = await appointment({
        customerId: 문가영, purposeCode: 'INITIAL_CONSULTATION', start: at(0, 16), end: at(0, 16, 30),
        status: 'RESERVED', source: 'NAVER', externalId: 'NV-DEMO-1004',
        naverUpdatedAt: at(-1, 12), syncedAt: at(0, 8), notes: '네이버 예약 유입 — 예산 문의',
      });
      await appointment({
        customerId: 문가영, purposeCode: 'INITIAL_CONSULTATION', start: at(3, 11), end: at(3, 11, 30),
        status: 'RESERVED', source: 'NAVER', externalId: 'NV-DEMO-1005',
        naverUpdatedAt: at(0, 9), syncedAt: at(0, 9, 10), notes: '동반 방문 예정',
      });
      await consultation({
        customerId: 문가영, appointmentId: mgyAp, consultedAt: at(0, 16, 20), category: '문의,맞춤정장',
        content: '첫 맞춤 정장 문의. 예산 150만원 내외, 납기 3주 가능 여부 확인 요청.',
      });

      // =====================================================================
      // 9) 수선 5건 (상태 4종)
      // =====================================================================
      await repair({
        customerId: 한지민, repairType: 'CUSTOM_DURING', requestDate: dateOnly(-4), dueDate: dateOnly(3),
        status: 'IN_PROGRESS', description: '가봉 반영 — 자켓 소매 0.5cm 축소, 바지 기장 1cm 조정', cost: 0,
        orderId: hjmCustomOrder, orderItemId: hjmSuit1, componentId: hjmSuit1Jacket,
        notes: '1차 가봉 결과 반영',
        events: [
          { newStatus: 'RECEIVED', eventDate: dateOnly(-4) },
          { previousStatus: 'RECEIVED', newStatus: 'IN_PROGRESS', eventDate: dateOnly(-3) },
        ],
      });
      await repair({
        customerId: 서지우, repairType: 'RENTAL_POST', requestDate: dateOnly(-42), dueDate: dateOnly(-38),
        status: 'RELEASED', description: '반납 턱시도 바지 밑단 풀림 수선', cost: 40000,
        rentalInventoryItemId: inventoryIds['PNT-BLK-34-003'], notes: '검수 시 발견, 수선 후 재고 복귀 예정',
        events: [
          { newStatus: 'RECEIVED', eventDate: dateOnly(-42) },
          { previousStatus: 'RECEIVED', newStatus: 'REQUESTED', eventDate: dateOnly(-42) },
          { previousStatus: 'REQUESTED', newStatus: 'IN_PROGRESS', eventDate: dateOnly(-41) },
          { previousStatus: 'IN_PROGRESS', newStatus: 'RETURNED_TO_SHOP', eventDate: dateOnly(-39) },
          { previousStatus: 'RETURNED_TO_SHOP', newStatus: 'CUSTOMER_NOTIFIED', eventDate: dateOnly(-39) },
          { previousStatus: 'CUSTOMER_NOTIFIED', newStatus: 'RELEASED', eventDate: dateOnly(-38) },
        ],
      });
      await repair({
        customerId: 오세훈, repairType: 'AFTER_SALE', requestDate: dateOnly(-1), dueDate: dateOnly(6),
        status: 'RECEIVED', description: '셔츠 #1 소매 기장 1cm 줄임', cost: 15000,
        orderId: oshOrder, orderItemId: oshShirt1,
        events: [{ newStatus: 'RECEIVED', eventDate: dateOnly(-1) }],
      });
      await repair({
        customerId: 윤도현, repairType: 'GENERAL', requestDate: dateOnly(-2), dueDate: dateOnly(4),
        status: 'IN_PROGRESS', description: '개인 소장 코트 단추 교체', cost: 12000,
        events: [
          { newStatus: 'RECEIVED', eventDate: dateOnly(-2) },
          { previousStatus: 'RECEIVED', newStatus: 'IN_PROGRESS', eventDate: dateOnly(-1) },
        ],
      });
      if (정우성) {
        await repair({
          customerId: 정우성.id, repairType: 'AFTER_SALE', requestDate: dateOnly(-20), dueDate: dateOnly(-14),
          status: 'RELEASED', description: '자켓 어깨 패드 조정', cost: 25000,
          events: [
            { newStatus: 'RECEIVED', eventDate: dateOnly(-20) },
            { previousStatus: 'RECEIVED', newStatus: 'REQUESTED', eventDate: dateOnly(-20) },
            { previousStatus: 'REQUESTED', newStatus: 'IN_PROGRESS', eventDate: dateOnly(-18) },
            { previousStatus: 'IN_PROGRESS', newStatus: 'RETURNED_TO_SHOP', eventDate: dateOnly(-16) },
            { previousStatus: 'RETURNED_TO_SHOP', newStatus: 'CUSTOMER_NOTIFIED', eventDate: dateOnly(-15) },
            { previousStatus: 'CUSTOMER_NOTIFIED', newStatus: 'RELEASED', eventDate: dateOnly(-14) },
          ],
        });
      }
      console.log('repair_requests: +5건');

      // =====================================================================
      // 10) 기존 데모 고객 이력 보강 (정우성 중심)
      // =====================================================================
      if (정우성) {
        const wsContract = await tx.contract.findFirst({ where: { customerId: 정우성.id } });
        const wsOrder = await tx.order.findFirst({
          where: { contract: { customerId: 정우성.id }, transactionType: 'CUSTOM' },
          include: { items: true },
        });
        const wsAp1 = await appointment({ customerId: 정우성.id, purposeCode: 'INITIAL_CONSULTATION', start: at(-90, 11), end: at(-90, 12), status: 'VISITED', notes: '맞춤 정장 + 행사 렌탈 상담' });
        const wsAp2 = await appointment({ customerId: 정우성.id, purposeCode: 'FITTING', start: at(-70, 15), end: at(-70, 16), status: 'VISITED', notes: '가봉 진행' });
        await appointment({ customerId: 정우성.id, purposeCode: 'PICKUP', start: at(-60, 15), end: at(-60, 15, 30), status: 'VISITED', notes: '맞춤 정장 인수' });
        await appointment({ customerId: 정우성.id, purposeCode: 'REPAIR_RECEIPT', start: at(-20, 11), end: at(-20, 11, 30), status: 'VISITED', notes: '자켓 어깨 패드 조정 접수' });
        await consultation({
          customerId: 정우성.id, appointmentId: wsAp1, consultedAt: at(-90, 11, 20), category: '맞춤정장,렌탈',
          content: '행사 일정에 맞춘 맞춤 정장 1벌 + 당일 렌탈 정장·구두 상담. 네이비 계열, 표준핏 선호.',
        });
        await consultation({
          customerId: 정우성.id, appointmentId: wsAp2, consultedAt: at(-70, 15, 30), category: '가봉',
          content: '가봉 결과 바지 기장 1.5cm 축소 요청. 자켓 품은 그대로 유지하기로 함.',
        });
        if (wsOrder && wsOrder.items.length > 0) {
          const wsMeasure = await measurement({
            customerId: 정우성.id, relatedOrderId: wsOrder.id, versionNo: 2, measurementDate: dateOnly(-70),
            measurementType: 'FITTING', fitPreference: 'STANDARD', bodyNotes: '가봉 반영: 바지 기장 1.5cm 축소',
            completedAt: at(-70, 16), linkOrderItemIds: [wsOrder.items[0].id],
            rows: measurementRows({
              neck: 40, shoulder: 46, chest: 102, sleeve: 62.5, bodyLength: 75, wrist: 17.5, upperSize: '100',
              waist: 88, hip: 100, rise: 26, pantsLength: 100.5, thigh: 61, calf: 39, lowerSize: '34', shoeSize: 270,
            }),
          });
          void wsMeasure;
        }
        if (wsContract) {
          await payment({ contractId: wsContract.id, paymentType: 'REPAIR_FEE', amount: 30000, paymentDate: dateOnly(-14), paymentMethod: 'CASH', memo: '어깨 패드 조정 수선비' });
        }
      }
      if (김민준) {
        await appointment({ customerId: 김민준.id, purposeCode: 'RENTAL_RETURN', start: at(4, 10), end: at(4, 10, 30), status: 'RESERVED', notes: '촬영 후 렌탈 반납' });
        await consultation({
          customerId: 김민준.id, consultedAt: at(-2, 17), category: '일정,렌탈',
          content: '촬영 일정 하루 당겨질 가능성 있어 렌탈 반납일 조정 문의. 반납 +1일 연장 가능 안내.',
        });
      }
      if (이서연) {
        await appointment({ customerId: 이서연.id, purposeCode: 'REPAIR_RECEIPT', start: at(5, 13), end: at(5, 13, 30), status: 'RESERVED', notes: '셔츠 소매 수선 접수 예정' });
        await consultation({
          customerId: 이서연.id, consultedAt: at(-1, 11), category: '입고,납기',
          content: '셔츠 #2 입고 지연 안내. 공장 재확인 후 3일 내 입고 예정으로 협의.',
        });
      }

      // =====================================================================
      // 11) 알림 규칙·발송 이력, 공유 메모
      // =====================================================================
      const templates = await tx.notificationTemplate.findMany();
      const templateId = (code: string): string | null => templates.find((t) => t.code === code)?.id ?? null;
      for (const r of [
        { code: 'FITTING_REMINDER', triggerType: 'APPOINTMENT_D1', autoSend: true },
        { code: 'RENTAL_RETURN_REMINDER', triggerType: 'RENTAL_RETURN_D1', autoSend: false },
      ]) {
        const tid = templateId(r.code);
        if (!tid) continue;
        await tx.notificationRule.create({
          data: { id: uuid(), templateId: tid, triggerType: r.triggerType, autoSend: r.autoSend, active: true },
        });
      }
      const history = async (args: {
        code: string; customerId: string; phone: string; status: string; sentAt?: Date;
        orderId?: string; errorMessage?: string; createdAt: Date;
      }): Promise<void> => {
        const template = templates.find((t) => t.code === args.code);
        await tx.notificationHistory.create({
          data: {
            id: uuid(),
            templateId: templateId(args.code),
            customerId: args.customerId,
            orderId: args.orderId ?? null,
            recipientPhone: args.phone,
            channel: template?.channel ?? 'ALIMTALK',
            body: template?.body ?? null,
            status: args.status,
            sentAt: args.sentAt ?? null,
            errorMessage: args.errorMessage ?? null,
            createdAt: args.createdAt,
          },
        });
      };
      await history({ code: 'FITTING_REMINDER', customerId: 한지민, phone: '010-7701-1001', status: 'SENT', sentAt: at(-5, 9), createdAt: at(-5, 9) });
      await history({ code: 'PICKUP_READY', customerId: 오세훈, phone: '010-7701-1002', status: 'SENT', sentAt: at(-3, 10), orderId: oshOrder, createdAt: at(-3, 10) });
      await history({ code: 'RENTAL_RETURN_REMINDER', customerId: 윤도현, phone: '010-7701-1006', status: 'SENT', sentAt: at(0, 9), orderId: ydhOrder, createdAt: at(0, 9) });
      await history({ code: 'RENTAL_RETURN_REMINDER', customerId: 서지우, phone: '010-7701-1003', status: 'FAILED', errorMessage: '수신 거부된 번호입니다.', createdAt: at(-43, 9) });
      if (정우성) {
        await history({ code: 'RENTAL_RETURN_REMINDER', customerId: 정우성.id, phone: 정우성.phone, status: 'SENT', sentAt: at(-1, 9), createdAt: at(-1, 9) });
      }
      if (김민준) {
        await history({ code: 'FITTING_REMINDER', customerId: 김민준.id, phone: 김민준.phone, status: 'REQUESTED', createdAt: at(0, 8, 30) });
      }

      for (const note of [
        { content: '한지민 고객 2차 가봉 시 자켓 소매 축소분 확인할 것 (1차 가봉 메모 참조)', createdAt: at(-3, 18) },
        { content: '오세훈 고객 바지 입고 지연 — 공장에 오늘 중 회신 요청함. 잔금 안내는 입고 확정 후 진행', createdAt: at(0, 10) },
        { content: 'PNT-BLK-34-003 반납 검수 완료되면 AVAILABLE로 전환 필요', createdAt: at(-1, 17) },
      ]) {
        await tx.sharedNote.create({
          data: { id: uuid(), content: note.content, authorId: adminId, status: 'ACTIVE', createdAt: note.createdAt },
        });
      }
      console.log('notification_rules: 2건 / notification_history: 6건 / shared_notes: +3건');
    },
    { maxWait: 15000, timeout: 300000 },
  );

  console.log('확장 시드 완료');
}

main()
  .catch((error) => {
    console.error('확장 시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
