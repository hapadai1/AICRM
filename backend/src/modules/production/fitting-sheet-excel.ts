import ExcelJS from 'exceljs';
import { FITTING_AREA_CODES, fittingAreaName } from './fitting.constants';

/**
 * 가봉 수정지시서 Excel (개발설계서 05 G-04).
 *
 * 설계 PDF 1페이지 가봉 단계의 "가봉 전달: 결과 공장 전달"에 쓰는 문서다.
 * 공장 전달은 이메일 수동 발송이므로 시스템은 첨부할 문서만 만들고,
 * 전송은 하지 않는다. 실제 공장 양식을 받으면 셀 매핑을 교체한다.
 */

export interface FittingSheetData {
  customerName: string;
  orderNo: string;
  itemLabel: string;
  fittingDate: Date;
  nextAppointmentDate: Date | null;
  notes: string | null;
  adjustments: Array<{
    areaCode: string;
    area: string;
    instruction: string;
    componentType: string | null;
    componentSequenceNo: number | null;
  }>;
}

const COMPONENT_TYPE_NAMES: Record<string, string> = {
  JACKET: '자켓',
  TROUSERS: '바지',
  VEST: '베스트',
  SHIRT: '셔츠',
  SHOES: '구두',
};

const LABEL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFEFEFEF' },
};

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  bottom: { style: 'thin' },
  left: { style: 'thin' },
  right: { style: 'thin' },
};

function styleLabelCell(cell: ExcelJS.Cell): void {
  cell.font = { bold: true };
  cell.fill = LABEL_FILL;
  cell.border = THIN_BORDER;
}

function styleValueCell(cell: ExcelJS.Cell): void {
  cell.border = THIN_BORDER;
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function componentLabel(type: string | null, seq: number | null): string {
  if (!type) return '전체';
  const name = COMPONENT_TYPE_NAMES[type] ?? type;
  return seq != null ? `${name} #${seq}` : name;
}

export async function buildFittingSheetExcel(data: FittingSheetData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AICRM';
  const ws = wb.addWorksheet('가봉 수정지시서');
  ws.columns = [{ width: 14 }, { width: 18 }, { width: 16 }, { width: 44 }];

  ws.mergeCells('A1:D1');
  const title = ws.getCell('A1');
  title.value = '가봉 수정지시서';
  title.font = { bold: true, size: 16 };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  const infoRows: Array<[string, string, string, string]> = [
    ['고객명', data.customerName, '주문번호', data.orderNo],
    ['품목', data.itemLabel, '가봉일', toDateOnly(data.fittingDate)],
    [
      '다음 예약',
      data.nextAppointmentDate ? toDateOnly(data.nextAppointmentDate) : '-',
      '비고',
      data.notes ?? '-',
    ],
  ];
  let rowNo = 3;
  for (const [l1, v1, l2, v2] of infoRows) {
    const row = ws.getRow(rowNo);
    row.getCell(1).value = l1;
    row.getCell(2).value = v1;
    row.getCell(3).value = l2;
    row.getCell(4).value = v2;
    styleLabelCell(row.getCell(1));
    styleValueCell(row.getCell(2));
    styleLabelCell(row.getCell(3));
    styleValueCell(row.getCell(4));
    rowNo += 1;
  }

  // 수정 지시 — 표준 항목(실루엣·균형·여유분·길이) 순서로 묶어 공장이 읽기 쉽게 한다.
  rowNo += 1;
  ws.mergeCells(`A${rowNo}:D${rowNo}`);
  const header = ws.getCell(`A${rowNo}`);
  header.value = '수정 지시';
  header.font = { bold: true, size: 12 };
  rowNo += 1;

  const head = ws.getRow(rowNo);
  head.getCell(1).value = '확인 항목';
  head.getCell(2).value = '대상';
  head.getCell(3).value = '세부 부위';
  head.getCell(4).value = '지시 내용';
  for (let c = 1; c <= 4; c += 1) styleLabelCell(head.getCell(c));
  rowNo += 1;

  const ordered = [...data.adjustments].sort(
    (a, b) =>
      FITTING_AREA_CODES.indexOf(a.areaCode as never) -
      FITTING_AREA_CODES.indexOf(b.areaCode as never),
  );

  if (ordered.length === 0) {
    const row = ws.getRow(rowNo);
    ws.mergeCells(`A${rowNo}:D${rowNo}`);
    row.getCell(1).value = '수정 지시 없음';
    styleValueCell(row.getCell(1));
    rowNo += 1;
  } else {
    for (const adj of ordered) {
      const row = ws.getRow(rowNo);
      row.getCell(1).value = fittingAreaName(adj.areaCode);
      row.getCell(2).value = componentLabel(adj.componentType, adj.componentSequenceNo);
      row.getCell(3).value = adj.area;
      row.getCell(4).value = adj.instruction;
      row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
      for (let c = 1; c <= 4; c += 1) styleValueCell(row.getCell(c));
      rowNo += 1;
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return out as unknown as Buffer;
}
