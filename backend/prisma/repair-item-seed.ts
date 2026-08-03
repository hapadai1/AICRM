import { randomUUID as uuid } from 'crypto';

/**
 * 데모 수선 건의 대상 품목 한 줄 만들기 (시드 공용).
 *
 * 수선 진행은 줄(수선요청)과 벌(입고·출고)로 나뉘므로, 시드도 건 상태에 맞춰
 * 줄의 requestedAt과 벌 상태를 채워야 화면이 그 건을 제대로 그린다.
 * 벌 상태를 직접 주면(unitStatuses) 부분 입고·부분 출고 같은 중간 상황도 만들 수 있다.
 */
export function repairItemRow(
  targetProduct: string,
  quantity: number,
  repairStatus: string,
  requestDate: Date,
  unitStatuses?: string[],
) {
  const requested = ['REQUESTED', 'RETURNED_TO_SHOP', 'CUSTOMER_NOTIFIED', 'RELEASED'].includes(
    repairStatus,
  );
  const unitStatus =
    repairStatus === 'RELEASED'
      ? 'RELEASED'
      : ['RETURNED_TO_SHOP', 'CUSTOMER_NOTIFIED'].includes(repairStatus)
        ? 'RETURNED'
        : 'PENDING';
  return {
    id: uuid(),
    targetProduct,
    quantity,
    sequenceNo: 1,
    requestedAt: requested ? requestDate : null,
    units: {
      create: Array.from({ length: quantity }, (_, index) => ({
        id: uuid(),
        unitNo: index + 1,
        status: unitStatuses?.[index] ?? unitStatus,
      })),
    },
  };
}
