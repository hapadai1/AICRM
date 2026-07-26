/**
 * 맞춤 구두 계약 데모 시드
 *
 * 스타일 컨설팅(/options)은 "맞춤(CUSTOM) 주문의 품목"만 대상으로 삼는데,
 * 기존 시드에는 구두가 렌탈로만 들어 있어 품목 목록에 구두가 한 건도 나오지 않았다.
 * 그래서 구두를 맞춤으로 계약한 데이터를 넣어 구두 옵션 세트(스타일 1단계 29종)가
 * 실제로 화면에 걸리도록 한다.
 *
 * 넣는 것 — 고객 2명 / 계약 2건 / 맞춤 주문 2건 / 품목 4건(구두 3 · 정장 1)
 *   1) 강태오 — 구두 맞춤(SHOES_CUSTOM) 2켤레
 *        · 구두 #1 스타일 확정(CONFIRMED) → 채촌 대기
 *        · 구두 #2 미시작 → 스타일 컨설팅 대기
 *   2) 임재현 — 정장·구두 맞춤(SUIT_SHOES_CUSTOM)
 *        · 정장 #1 스타일 확정 / 구두 #1 진행중(IN_PROGRESS)
 * 구두 세트는 단계가 하나뿐이라 "진행중"은 선택값이 아직 없는 상태로 둔다.
 *
 * - 전제: prisma/seed.ts + seed-demo.ts + seed-shoes-design-options.ts 실행 완료
 * - 재실행 안전: 마커 계약(CTR-260723-201) 존재 시 스킵
 * - 실행: npm run seed:shoes-custom
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

/** 이 시드가 만든 데이터인지 알아보는 표식 */
const MARKER_CONTRACT_NO = 'CTR-260723-201';

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

async function main(): Promise<void> {
  const marker = await prisma.contract.findUnique({ where: { contractNo: MARKER_CONTRACT_NO } });
  if (marker) {
    console.log(`맞춤 구두 데모 스킵: ${MARKER_CONTRACT_NO} 계약이 이미 존재합니다.`);
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
      throw new Error(`옵션 세트(${category})의 활성 버전이 없습니다. 옵션 시드를 먼저 실행하세요.`);
    }
    return set.activeVersion;
  };
  const suitVersion = optionVersionOf('SUIT');
  const shoesVersion = optionVersionOf('SHOES');
  type OptionVersion = typeof shoesVersion;

  await prisma.$transaction(
    async (tx: Tx) => {
      // =====================================================================
      // 공통 헬퍼 (seed-more.ts와 같은 형태)
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
        versionNo: number; total: number; deposit: number; confirmedAt: Date;
        completionDueDate?: Date; lines: LineDef[];
      }): Promise<{ contractId: string; lineIds: string[] }> => {
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
        const versionId = uuid();
        await tx.contractVersion.create({
          data: {
            id: versionId,
            contractId,
            versionNo: args.versionNo,
            versionStatus: 'CONFIRMED',
            totalAmount: args.total,
            depositAmount: args.deposit,
            balanceAmount: args.total - args.deposit,
            completionDueDate: args.completionDueDate ?? null,
            confirmedBy: adminId,
            confirmedAt: args.confirmedAt,
            createdBy: adminId,
          },
        });
        const lineIds: string[] = [];
        for (let i = 0; i < args.lines.length; i += 1) {
          const l = args.lines[i];
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
        await tx.contract.update({ where: { id: contractId }, data: { currentVersionId: versionId } });
        return { contractId, lineIds };
      };

      const order = async (args: {
        orderNo: string; contractId: string; status: string; completionDueDate?: Date;
      }): Promise<string> => {
        const id = uuid();
        await tx.order.create({
          data: {
            id,
            orderNo: args.orderNo,
            contractId: args.contractId,
            transactionType: 'CUSTOM',
            status: args.status,
            completionDueDate: args.completionDueDate ?? null,
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
        orderItemId: string; componentType: string; status: string; expectedInboundDate?: Date;
      }): Promise<string> => {
        const id = uuid();
        await tx.orderItemComponent.create({
          data: {
            id,
            orderItemId: args.orderItemId,
            componentType: args.componentType,
            sequenceNo: 1,
            status: args.status,
            expectedInboundDate: args.expectedInboundDate ?? null,
          },
        });
        return id;
      };

      /**
       * 옵션 선택 세션. picks는 단계 순서대로의 선택지 코드다.
       * 구두는 단계가 하나라 picks가 비면 "1단계 진행중(선택 전)"이 된다.
       */
      const optionSession = async (args: {
        orderItemId: string; version: OptionVersion; picks: string[];
        status: 'IN_PROGRESS' | 'REVIEW' | 'CONFIRMED'; fabricName?: string;
        startedAt: Date; lastSavedAt: Date; reviewedAt?: Date; confirmedAt?: Date;
      }): Promise<string> => {
        const sessionId = uuid();
        const nextStage = args.version.stages[args.picks.length] ?? args.version.stages[0] ?? null;
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
          if (!choice) break;
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

      // =====================================================================
      // 1) 강태오 — 구두 맞춤 2켤레
      // =====================================================================
      const 강태오 = await customer({
        name: '강태오', phone: '010-7702-2001', email: 'taeo.kang@example.com', status: 'CONTRACTED',
        firstReservedAt: at(-14, 11), contractedAt: at(-11, 15),
        notes: '맞춤 구두 2켤레(블랙 정장용 · 브라운 캐주얼). 발볼 넓은 편 — 라스트 상담 필요',
      });
      const kto = await createContract({
        contractNo: MARKER_CONTRACT_NO, customerId: 강태오, typeCode: 'SHOES_CUSTOM',
        status: 'CONFIRMED', contractedAt: at(-11, 15), balanceDueDate: dateOnly(18),
        versionNo: 1, total: 1700000, deposit: 700000, confirmedAt: at(-11, 15),
        completionDueDate: dateOnly(25),
        lines: [
          { transactionType: 'CUSTOM', productCategory: 'SHOES', itemDescription: '맞춤 구두', quantity: 2, unitPrice: 850000 },
        ],
      });
      const ktoOrder = await order({
        orderNo: 'ORD-260723-201', contractId: kto.contractId, status: 'IN_PROGRESS',
        completionDueDate: dateOnly(25),
      });
      const ktoShoes1 = await orderItem({
        orderId: ktoOrder, lineId: kto.lineIds[0], productCategory: 'SHOES', sequenceNo: 1,
        displayName: '맞춤 구두 #1', status: 'MEASUREMENT_PENDING',
      });
      const ktoShoes2 = await orderItem({
        orderId: ktoOrder, lineId: kto.lineIds[0], productCategory: 'SHOES', sequenceNo: 2,
        displayName: '맞춤 구두 #2', status: 'OPTION_PENDING',
      });
      await component({ orderItemId: ktoShoes1, componentType: 'SHOES', status: 'CREATED', expectedInboundDate: dateOnly(20) });
      await component({ orderItemId: ktoShoes2, componentType: 'SHOES', status: 'CREATED' });

      // 구두는 단계가 하나 — 스타일 하나를 고르면 그대로 확정이다.
      const shoesStyle = shoesVersion.stages[0]?.choices ?? [];
      const styleAt = (index: number): string[] => {
        const choice = shoesStyle[index] ?? shoesStyle[0];
        return choice ? [choice.choiceCode] : [];
      };
      await optionSession({
        orderItemId: ktoShoes1, version: shoesVersion, picks: styleAt(2),
        status: 'CONFIRMED', fabricName: '블랙 카프',
        startedAt: at(-10, 11), lastSavedAt: at(-10, 11, 20),
        reviewedAt: at(-10, 11, 30), confirmedAt: at(-10, 11, 40),
      });
      // 구두 #2는 세션 자체를 만들지 않는다 — 스타일 컨설팅 "미시작" 상태 확인용.

      // =====================================================================
      // 2) 임재현 — 정장·구두 맞춤
      // =====================================================================
      const 임재현 = await customer({
        name: '임재현', phone: '010-7702-2002', email: 'jaehyun.lim@example.com', status: 'CONTRACTED',
        firstReservedAt: at(-6, 14), contractedAt: at(-4, 16),
        notes: '면접·행사용 정장 1벌과 매칭 구두 1켤레. 구두 스타일은 다음 방문 때 결정',
      });
      const ljh = await createContract({
        contractNo: 'CTR-260723-202', customerId: 임재현, typeCode: 'SUIT_SHOES_CUSTOM',
        status: 'CONFIRMED', contractedAt: at(-4, 16), balanceDueDate: dateOnly(24),
        versionNo: 1, total: 2350000, deposit: 1000000, confirmedAt: at(-4, 16),
        completionDueDate: dateOnly(30),
        lines: [
          { transactionType: 'CUSTOM', productCategory: 'SUIT', itemDescription: '맞춤 정장', quantity: 1, unitPrice: 1450000 },
          { transactionType: 'CUSTOM', productCategory: 'SHOES', itemDescription: '맞춤 구두', quantity: 1, unitPrice: 900000 },
        ],
      });
      const ljhOrder = await order({
        orderNo: 'ORD-260723-202', contractId: ljh.contractId, status: 'IN_PROGRESS',
        completionDueDate: dateOnly(30),
      });
      const ljhSuit = await orderItem({
        orderId: ljhOrder, lineId: ljh.lineIds[0], productCategory: 'SUIT', sequenceNo: 1,
        displayName: '맞춤 정장 #1', status: 'MEASUREMENT_PENDING',
      });
      const ljhShoes = await orderItem({
        orderId: ljhOrder, lineId: ljh.lineIds[1], productCategory: 'SHOES', sequenceNo: 1,
        displayName: '맞춤 구두 #1', status: 'OPTION_PENDING',
      });
      await component({ orderItemId: ljhSuit, componentType: 'JACKET', status: 'CREATED' });
      await component({ orderItemId: ljhSuit, componentType: 'TROUSERS', status: 'CREATED' });
      await component({ orderItemId: ljhShoes, componentType: 'SHOES', status: 'CREATED' });

      await optionSession({
        orderItemId: ljhSuit, version: suitVersion,
        picks: ['A', 'B', 'A', 'A', 'B', 'A', 'B', 'A', 'A', 'B', 'A'],
        status: 'CONFIRMED', fabricName: 'VBC 110수 차콜 그레이',
        startedAt: at(-3, 13), lastSavedAt: at(-3, 14), reviewedAt: at(-3, 14, 20), confirmedAt: at(-3, 14, 30),
      });
      // 구두는 상담만 시작하고 스타일은 아직 안 골랐다 — 1단계 진행중.
      await optionSession({
        orderItemId: ljhShoes, version: shoesVersion, picks: [],
        status: 'IN_PROGRESS', fabricName: '다크 브라운',
        startedAt: at(-1, 15), lastSavedAt: at(-1, 15, 10),
      });

      console.log('맞춤 구두 데모: 고객 2 / 계약 2 / 주문 2 / 품목 4(구두 3) / 옵션 세션 3');
    },
    { timeout: 60_000 },
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
