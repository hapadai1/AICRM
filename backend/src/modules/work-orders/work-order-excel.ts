import ExcelJS from 'exceljs';

/**
 * MVP 기본 양식 작업지시서 Excel 생성 (통합설계서 §10.3).
 * 옵션 이미지 없이 옵션명·치수 정보만 출력한다. 실제 공장 양식이 제공되면
 * 셀 매핑 템플릿으로 교체한다.
 */
export interface WorkOrderExcelData {
  customerName: string;
  orderNo: string;
  itemLabel: string;
  productCategory: string;
  sequenceNo: number;
  fabricName: string | null;
  versionNo: number;
  issuedAt: Date;
  note: string | null;
  measurementDate: string;
  measurementVersionNo: number;
  options: Array<{ stageName: string; choiceName: string }>;
  measurements: Array<{ name: string; value: string; unit: string }>;
}

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

export async function buildWorkOrderExcel(data: WorkOrderExcelData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AICRM';
  wb.created = data.issuedAt;
  const ws = wb.addWorksheet('작업지시서');
  ws.columns = [{ width: 18 }, { width: 30 }, { width: 18 }, { width: 30 }];

  // 제목
  ws.mergeCells('A1:D1');
  const title = ws.getCell('A1');
  title.value = `작업지시서 V${data.versionNo}`;
  title.font = { bold: true, size: 16 };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // 기본 정보
  const infoRows: Array<[string, string, string, string]> = [
    ['고객명', data.customerName, '주문번호', data.orderNo],
    ['품목', `${data.itemLabel} (${data.productCategory} #${data.sequenceNo})`, '원단', data.fabricName ?? '-'],
    ['버전', `V${data.versionNo}`, '출력일', data.issuedAt.toISOString()],
    ['채촌일', `${data.measurementDate} (채촌 V${data.measurementVersionNo})`, '비고', data.note ?? '-'],
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

  // 옵션 표
  rowNo += 1;
  ws.mergeCells(`A${rowNo}:D${rowNo}`);
  const optionHeader = ws.getCell(`A${rowNo}`);
  optionHeader.value = '옵션 선택';
  optionHeader.font = { bold: true, size: 12 };
  rowNo += 1;
  const optionHead = ws.getRow(rowNo);
  optionHead.getCell(1).value = '단계';
  optionHead.getCell(2).value = '선택 옵션';
  styleLabelCell(optionHead.getCell(1));
  styleLabelCell(optionHead.getCell(2));
  rowNo += 1;
  for (const option of data.options) {
    const row = ws.getRow(rowNo);
    row.getCell(1).value = option.stageName;
    row.getCell(2).value = option.choiceName;
    styleValueCell(row.getCell(1));
    styleValueCell(row.getCell(2));
    rowNo += 1;
  }

  // 채촌 표
  rowNo += 1;
  ws.mergeCells(`A${rowNo}:D${rowNo}`);
  const measurementHeader = ws.getCell(`A${rowNo}`);
  measurementHeader.value = `채촌 (측정일 ${data.measurementDate})`;
  measurementHeader.font = { bold: true, size: 12 };
  rowNo += 1;
  const measurementHead = ws.getRow(rowNo);
  measurementHead.getCell(1).value = '항목';
  measurementHead.getCell(2).value = '값';
  measurementHead.getCell(3).value = '단위';
  styleLabelCell(measurementHead.getCell(1));
  styleLabelCell(measurementHead.getCell(2));
  styleLabelCell(measurementHead.getCell(3));
  rowNo += 1;
  for (const measurement of data.measurements) {
    const row = ws.getRow(rowNo);
    row.getCell(1).value = measurement.name;
    row.getCell(2).value = measurement.value;
    row.getCell(3).value = measurement.unit;
    styleValueCell(row.getCell(1));
    styleValueCell(row.getCell(2));
    styleValueCell(row.getCell(3));
    rowNo += 1;
  }

  const out = await wb.xlsx.writeBuffer();
  return out as unknown as Buffer;
}
