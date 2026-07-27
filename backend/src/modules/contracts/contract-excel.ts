import ExcelJS from 'exceljs';

/**
 * 표준 계약서 Excel (v2 설계서 03 §5).
 *
 * 가봉지시서(`production/fitting-sheet-excel.ts`)와 같이 exceljs로 워크북을 직접 그린다.
 * 작업지시서식 템플릿 덮어쓰기·preserveTemplateDrawings는 쓰지 않는다(지켜야 할 원본 xlsx 없음).
 *
 * 가격 규칙(D7): 엑셀은 **세부가격 제외, 총액(총 계약금액)만** 출력한다.
 * 서명 이미지는 addImage로 셀에 앵커해 삽입한다.
 */

export interface ContractExcelLine {
  /** 대분류 라벨: 정장/셔츠/구두 */
  category: string;
  /** 세부 품목 라벨: 상의·하의·베스트/셔츠/구두 */
  components: string[];
  quantity: number;
}

export interface ContractExcelOptionLine {
  /** 스타일 옵션명 (엑셀은 가격 제외) */
  optionName: string;
}

export interface ContractExcelData {
  contractNo: string;
  status: string;
  contractedAt: Date | null;
  customer: { name: string; phone: string | null };
  contractType: string | null;
  lines: ContractExcelLine[];
  options: ContractExcelOptionLine[];
  /** D7: 엑셀은 총액만 */
  totalAmount: number;
  completionDueDate: Date | null;
  photoDate: Date | null;
  weddingDate: Date | null;
  signature: { pngBuffer: Buffer; signerName: string; signedAt: Date } | null;
  issuedAt: Date;
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

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '초안',
  CONFIRMED: '계약완료',
  CHANGED: '변경',
  CANCELLED: '취소',
};

function styleLabelCell(cell: ExcelJS.Cell): void {
  cell.font = { bold: true };
  cell.fill = LABEL_FILL;
  cell.border = THIN_BORDER;
  cell.alignment = { vertical: 'middle' };
}

function styleValueCell(cell: ExcelJS.Cell): void {
  cell.border = THIN_BORDER;
  cell.alignment = { vertical: 'middle' };
}

function dateOnly(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '-';
}

function dateTime(value: Date): string {
  return value.toISOString().slice(0, 16).replace('T', ' ');
}

export async function buildContractExcel(data: ContractExcelData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AICRM';
  const ws = wb.addWorksheet('계약서');
  ws.columns = [{ width: 16 }, { width: 24 }, { width: 16 }, { width: 24 }];

  // 제목
  ws.mergeCells('A1:D1');
  const title = ws.getCell('A1');
  title.value = '계 약 서';
  title.font = { bold: true, size: 18 };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 32;

  let rowNo = 3;

  // 헤더표 (라벨-값 2열)
  const headerRows: Array<[string, string, string, string]> = [
    ['계약번호', data.contractNo, '계약상태', STATUS_LABEL[data.status] ?? data.status],
    ['고객명', data.customer.name, '연락처', data.customer.phone ?? '-'],
    ['계약구분', data.contractType ?? '-', '계약일', dateOnly(data.contractedAt)],
    ['완성예정일', dateOnly(data.completionDueDate), '촬영일', dateOnly(data.photoDate)],
    ['예식일', dateOnly(data.weddingDate), '', ''],
  ];
  for (const [l1, v1, l2, v2] of headerRows) {
    const row = ws.getRow(rowNo);
    row.getCell(1).value = l1;
    row.getCell(2).value = v1;
    row.getCell(3).value = l2;
    row.getCell(4).value = v2;
    styleLabelCell(row.getCell(1));
    styleValueCell(row.getCell(2));
    if (l2) {
      styleLabelCell(row.getCell(3));
      styleValueCell(row.getCell(4));
    }
    rowNo += 1;
  }

  // 품목표 (대분류·세부품목·개수 — 가격 열 없음)
  rowNo += 1;
  const itemHead = ws.getCell(`A${rowNo}`);
  itemHead.value = '계약 품목';
  itemHead.font = { bold: true, size: 12 };
  rowNo += 1;

  const itemHeaderRow = ws.getRow(rowNo);
  itemHeaderRow.getCell(1).value = '품목';
  ws.mergeCells(`B${rowNo}:C${rowNo}`);
  itemHeaderRow.getCell(2).value = '세부품목';
  itemHeaderRow.getCell(4).value = '개수';
  styleLabelCell(itemHeaderRow.getCell(1));
  styleLabelCell(itemHeaderRow.getCell(2));
  styleLabelCell(itemHeaderRow.getCell(3));
  styleLabelCell(itemHeaderRow.getCell(4));
  rowNo += 1;

  if (data.lines.length === 0) {
    ws.mergeCells(`A${rowNo}:D${rowNo}`);
    const row = ws.getRow(rowNo);
    row.getCell(1).value = '계약 품목 없음';
    styleValueCell(row.getCell(1));
    rowNo += 1;
  } else {
    for (const line of data.lines) {
      const row = ws.getRow(rowNo);
      row.getCell(1).value = line.category;
      ws.mergeCells(`B${rowNo}:C${rowNo}`);
      row.getCell(2).value = line.components.join(' · ');
      row.getCell(4).value = line.quantity;
      styleValueCell(row.getCell(1));
      styleValueCell(row.getCell(2));
      styleValueCell(row.getCell(3));
      styleValueCell(row.getCell(4));
      row.getCell(4).alignment = { horizontal: 'center', vertical: 'middle' };
      rowNo += 1;
    }
  }

  // 옵션표 (옵션명만 — 없으면 구역 생략)
  if (data.options.length > 0) {
    rowNo += 1;
    const optHead = ws.getCell(`A${rowNo}`);
    optHead.value = '스타일 옵션';
    optHead.font = { bold: true, size: 12 };
    rowNo += 1;

    const optHeaderRow = ws.getRow(rowNo);
    ws.mergeCells(`A${rowNo}:D${rowNo}`);
    optHeaderRow.getCell(1).value = '옵션명';
    styleLabelCell(optHeaderRow.getCell(1));
    styleLabelCell(optHeaderRow.getCell(2));
    styleLabelCell(optHeaderRow.getCell(3));
    styleLabelCell(optHeaderRow.getCell(4));
    rowNo += 1;

    for (const opt of data.options) {
      const row = ws.getRow(rowNo);
      ws.mergeCells(`A${rowNo}:D${rowNo}`);
      row.getCell(1).value = opt.optionName;
      styleValueCell(row.getCell(1));
      styleValueCell(row.getCell(2));
      styleValueCell(row.getCell(3));
      styleValueCell(row.getCell(4));
      rowNo += 1;
    }
  }

  // 금액 (총액만 — D6/D7)
  rowNo += 1;
  const amountRow = ws.getRow(rowNo);
  ws.mergeCells(`A${rowNo}:B${rowNo}`);
  amountRow.getCell(1).value = '총 계약금액';
  ws.mergeCells(`C${rowNo}:D${rowNo}`);
  amountRow.getCell(3).value = data.totalAmount;
  amountRow.getCell(3).numFmt = '#,##0"원"';
  styleLabelCell(amountRow.getCell(1));
  styleLabelCell(amountRow.getCell(2));
  styleValueCell(amountRow.getCell(3));
  styleValueCell(amountRow.getCell(4));
  amountRow.getCell(3).font = { bold: true, size: 12 };
  amountRow.getCell(3).alignment = { horizontal: 'right', vertical: 'middle' };
  rowNo += 1;

  // 서명
  rowNo += 2;
  ws.mergeCells(`A${rowNo}:D${rowNo}`);
  const consent = ws.getCell(`A${rowNo}`);
  consent.value = '위 계약 내용에 동의합니다.';
  consent.alignment = { horizontal: 'center', vertical: 'middle' };
  rowNo += 1;

  if (data.signature) {
    const imageRowStart = rowNo;
    for (let r = 0; r < 5; r += 1) ws.getRow(imageRowStart + r).height = 24;
    const imageId = wb.addImage({ buffer: data.signature.pngBuffer as unknown as ExcelJS.Buffer, extension: 'png' });
    // A~B열, 5행 범위에 서명 이미지를 앵커한다.
    ws.addImage(imageId, {
      tl: { col: 0, row: imageRowStart - 1 },
      ext: { width: 220, height: 110 },
      editAs: 'oneCell',
    });
    rowNo += 5;

    const signInfo = ws.getRow(rowNo);
    signInfo.getCell(1).value = '서명자';
    signInfo.getCell(2).value = data.signature.signerName;
    signInfo.getCell(3).value = '서명일시';
    signInfo.getCell(4).value = dateTime(data.signature.signedAt);
    styleLabelCell(signInfo.getCell(1));
    styleValueCell(signInfo.getCell(2));
    styleLabelCell(signInfo.getCell(3));
    styleValueCell(signInfo.getCell(4));
    rowNo += 1;
  } else {
    const row = ws.getRow(rowNo);
    ws.mergeCells(`A${rowNo}:D${rowNo}`);
    row.getCell(1).value = '(미서명)';
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    styleValueCell(row.getCell(1));
    rowNo += 1;
  }

  // 푸터 (출력일시)
  rowNo += 1;
  ws.mergeCells(`A${rowNo}:D${rowNo}`);
  const footer = ws.getCell(`A${rowNo}`);
  footer.value = `출력일시: ${dateTime(data.issuedAt)}`;
  footer.font = { size: 9, color: { argb: 'FF888888' } };
  footer.alignment = { horizontal: 'right' };

  const out = await wb.xlsx.writeBuffer();
  return out as unknown as Buffer;
}
