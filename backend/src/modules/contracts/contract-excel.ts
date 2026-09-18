import ExcelJS from 'exceljs';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import JSZip from 'jszip';
import { resolve } from 'path';

/**
 * 계약서 Excel — 매장 계약서 양식(`templates/suit-agency-contract.xlsx`)에 값만 채운다.
 *
 * 2026-09-18 현업이 정리한 최종 양식으로 교체했다. 이전 양식에서 코드로 손보던 정렬(박스 좌우 여백,
 * 체크리스트·특약 좌측 정렬, 서명 줄 가운데, 감사 문구 여백, 모서리 장식 어긋남)이 양식 자체에
 * 반영돼 있어, 코드는 **칸에 값을 넣는 일만** 한다. 프레임은 B~AX열, 표 박스는 C~AW열이다.
 *
 * 종이 계약서를 그대로 옮긴 양식이라 칸 위치가 고정이다. 작업지시서(`work-orders/work-order-excel.ts`)와
 * 같이 템플릿을 열어 매핑된 셀만 덮어쓰고, ExcelJS가 버리는 드로잉(로고·QR·모서리 장식)은 ZIP 단계에서
 * 템플릿 원본을 다시 붙인다. 서명 두 장(계약담당자·고객)도 그 드로잉에 그림으로 얹는다.
 *
 * 가격 규칙(D7): 엑셀은 세부가격 없이 TOTAL(총 계약금액)만 싣는다.
 */

export type ContractPaymentMethod = 'CASH' | 'TRANSFER' | 'CARD';
export type ContractAsPeriod = 'SIX_MONTHS' | 'ONE_YEAR' | 'LIFETIME';

export interface ContractExcelData {
  /** 'YYYY-MM-DD' */
  contractDate: string | null;
  customer: { name: string; phone: string | null };
  /** 'YYYY-MM-DD' */
  photoDate: string | null;
  /** 'YYYY-MM-DD' */
  weddingDate: string | null;
  /** MEMO 칸 내용 — 줄 단위 (품목 요약·필요일정·자유 메모를 서비스가 조립한다) */
  memoLines: string[];
  asPeriod: string | null;
  /** D7: 엑셀은 총액만 */
  totalAmount: number;
  paymentMethod: string | null;
  depositorName: string | null;
  /** 'YYYY-MM-DD' */
  paymentDate: string | null;
  /** 고객 체크리스트 전체 동의 여부 */
  checklistAgreed: boolean;
  urgentProductionTerm: boolean;
  trFabricTerm: boolean;
  staff: { name: string | null; signaturePng: Buffer | null };
  customerSign: { name: string | null; signaturePng: Buffer | null };
}

const TEMPLATE_FILE = 'templates/suit-agency-contract.xlsx';
const SHEET_PART = 'xl/worksheets/sheet1.xml';
const DRAWING_PART = 'xl/drawings/drawing1.xml';
const DRAWING_RELS_PART = 'xl/drawings/_rels/drawing1.xml.rels';
const SHEET_RELS_PART = 'xl/worksheets/_rels/sheet1.xml.rels';

const UNCHECKED = '□';
const CHECKED = '☑';

/** 양식 셀 주소 — 병합 블록의 좌상단 (최종 양식 2026-09-18) */
export const CONTRACT_CELLS = {
  store: 'C4',
  /** "년·월·일" 글자 칸 — 숫자를 앞에 붙인다 */
  contractDate: ['K2', 'O2', 'S2'],
  customerName: 'I6',
  phone: 'AD6',
  photoDate: ['I7', 'O7', 'U7'],
  weddingDate: ['AG7', 'AM7', 'AS7'],
  /**
   * MEMO — 양식은 라벨(C9:K12)만 병합돼 있고 값 칸은 비어 있다.
   * 값은 라벨 바로 오른쪽(L열)·AS 첫 줄과 같은 10행에서 시작해 박스 안쪽(AG14)까지 병합한다.
   * 병합은 좌상단 서식을 범위 전체에 덮어써 박스 선을 지우므로, 테두리를 저장해 두고 되돌린다.
   */
  memo: { value: 'L10:AG14' },
  asPeriod: { SIX_MONTHS: 'AH10', ONE_YEAR: 'AH11', LIFETIME: 'AH12' } as Record<string, string>,
  total: 'I16',
  paymentMethod: { CASH: 'AH16', TRANSFER: 'AM16', CARD: 'AS16' } as Record<string, string>,
  depositorName: 'I17',
  paymentDate: ['AG17', 'AM17', 'AS17'],
  /** 고객 체크리스트 체크박스 (문구가 이어지는 줄은 체크박스가 없다) */
  checklist: ['C25', 'C26', 'C28', 'C29', 'C31', 'C33', 'C35', 'C37', 'C38', 'C39', 'C40', 'C41'],
  urgentProductionTerm: 'C54',
  trFabricTerm: 'C55',
} as const;

/**
 * 서명 줄 (48행 계약담당자 · 50행 고객).
 * 양식은 라벨(Z:AF)·"서명"(AM:AR)만 있고 이름 칸이 없다 — 그 사이(AG:AL)를 이름 칸으로 병합한다.
 * 라벨은 두 줄의 콜론이 세로로 맞도록 오른쪽 정렬한다(양식은 48행만 가운데 정렬).
 */
const SIGN_LINES = [
  { row: 48, label: 'Z48:AF48', name: 'AG48:AL48', signText: 'AM48:AR48' },
  { row: 50, label: 'Z50:AF50', name: 'AG50:AL50', signText: 'AM50:AR50' },
];

/** "서명" 글자 칸 AM:AR의 0-based 열 경계 — 서명 그림을 이 칸 가운데에 얹는다 */
const SIGN_TEXT_FIRST_COL = 38;
const SIGN_TEXT_LAST_COL = 44;
/** 서명 그림이 넓어질 때 넘지 않을 오른쪽 한계 (박스 오른쪽 AW) */
const SIGN_AREA_LAST_COL = 49;

/**
 * 인쇄 영역 — 양식은 B2:AY57로, 프레임 오른쪽(AX) 밖의 좁은 AY열이 들어가 좌우 가운데가
 * 반 칸 어긋난다. 프레임까지(B2:AX57)로 줄여 좌우 여백을 맞춘다.
 */
const PRINT_AREA = 'B2:AX57';

/**
 * 메모 줄 수별 글자 크기 — MEMO 박스(10~14행, 약 120pt)에 들어가는 줄 수 기준 (Excel 렌더링으로 확인).
 * 맑은 고딕은 줄 간격이 넓어 10pt 7줄·9pt 8줄·8pt 9줄이 들어간다. 그보다 길면 아래가 잘린다.
 */
function memoFontSize(lineCount: number): number {
  if (lineCount <= 7) return 10;
  if (lineCount === 8) return 9;
  return 8;
}

/** 서명 위에 깔리는 "서명" 글자 색 — 서명 그림이 잘 보이도록 연하게 */
const FADED_SIGN_TEXT = 'FFC8C8C8';

/** 서명 그림 최대 크기(px) — 칸보다 크면 비율을 지켜 줄인다 */
const SIGNATURE_MAX_WIDTH_PX = 160;
const SIGNATURE_MAX_HEIGHT_PX = 44;

const EMU_PER_PT = 12700;
/** 양식 열 너비(1.83자)의 대략적인 pt — 서명 비율에 맞춰 몇 칸을 쓸지 정하는 데만 쓴다 */
const FORM_COLUMN_PT = 9.75;

function templatePath(): string {
  const path = resolve(__dirname, TEMPLATE_FILE);
  if (!existsSync(path)) {
    throw new Error(`계약서 양식 템플릿을 찾을 수 없습니다: ${path}`);
  }
  return path;
}

function cellText(value: ExcelJS.CellValue): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'richText' in value) {
    return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
  }
  return value == null ? '' : String(value);
}

/**
 * 셀 서식 바꾸기. ExcelJS는 템플릿에서 읽은 셀끼리 **같은 서식 객체를 공유**해서
 * `cell.font = …` 로 고치면 같은 서식을 쓰는 다른 셀까지 바뀐다.
 * 서식 객체를 통째로 새로 만들어 그 셀에만 적용한다.
 */
function restyle(cell: ExcelJS.Cell, patch: Partial<ExcelJS.Style>): void {
  cell.style = { ...cell.style, ...patch };
}

/** 인쇄된 체크박스(□)를 체크(☑)로 바꾼다 — 문구는 그대로 둔다. */
function check(ws: ExcelJS.Worksheet, address: string): void {
  const cell = ws.getCell(address);
  const text = cellText(cell.value);
  if (!text.includes(UNCHECKED)) return;
  cell.value = text.replace(UNCHECKED, CHECKED);
}

/** "년·월·일" 글자 칸 세 개에 숫자를 앞붙인다 — 종이에 손으로 쓰는 자리와 같다. */
function putDate(ws: ExcelJS.Worksheet, cells: readonly string[], value: string | null): void {
  if (!value) return;
  const [year, month, day] = value.slice(0, 10).split('-');
  [year, month, day].forEach((part, i) => {
    const cell = ws.getCell(cells[i]);
    cell.value = `${part} ${cellText(cell.value).trim()}`;
  });
}

function putValue(
  ws: ExcelJS.Worksheet,
  address: string,
  value: string | number,
  font: Partial<ExcelJS.Font> = {},
): ExcelJS.Cell {
  const cell = ws.getCell(address);
  cell.value = value;
  restyle(cell, {
    font: { ...(cell.font ?? {}), size: 12, ...font },
    alignment: { horizontal: 'center', vertical: 'middle' },
  });
  return cell;
}

/** 010-1234-5678 → "010 - 1234 - 5678" (양식에 "010 -"가 인쇄돼 있다) */
export function formatContractPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  const m = /^(01\d)(\d{3,4})(\d{4})$/.exec(digits);
  return m ? `${m[1]} - ${m[2]} - ${m[3]}` : phone;
}

/** 범위 안 셀들의 테두리 — 병합이 서식을 덮어써 박스 선이 지워지므로 저장해 두고 되돌린다 */
function captureBorders(ws: ExcelJS.Worksheet, range: string): Map<string, Partial<ExcelJS.Borders>> {
  const [start, end] = range.split(':').map((a) => ws.getCell(a));
  const borders = new Map<string, Partial<ExcelJS.Borders>>();
  for (let row = Number(start.row); row <= Number(end.row); row += 1) {
    for (let col = Number(start.col); col <= Number(end.col); col += 1) {
      const cell = ws.getRow(row).getCell(col);
      borders.set(cell.address, { ...(cell.border ?? {}) });
    }
  }
  return borders;
}

function restoreBorders(ws: ExcelJS.Worksheet, borders: Map<string, Partial<ExcelJS.Borders>>): void {
  for (const [address, border] of borders) restyle(ws.getCell(address), { border });
}

/** MEMO 값 칸을 병합해 채운다. 박스 선은 병합 전에 저장해 두고 되돌린다. */
function fillMemo(ws: ExcelJS.Worksheet, lines: string[]): void {
  if (lines.length === 0) return;
  const range = CONTRACT_CELLS.memo.value;
  const borders = captureBorders(ws, range);
  ws.mergeCells(range);
  const value = ws.getCell(range.split(':')[0]);
  value.value = lines.join('\n');
  restyle(value, {
    font: { name: '맑은 고딕', size: memoFontSize(lines.length) },
    alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
  });
  restoreBorders(ws, borders);
}

/**
 * 서명 줄을 채운다: 라벨 오른쪽 정렬 · 이름 칸 병합 후 이름 · 서명이 있으면 "서명" 글자를 연하게.
 * 이름이 칸보다 길면 글자를 줄여 한 칸에 넣는다.
 */
function fillSignLine(
  ws: ExcelJS.Worksheet,
  line: (typeof SIGN_LINES)[number],
  name: string | null,
  signed: boolean,
): void {
  const label = ws.getCell(line.label.split(':')[0]);
  restyle(label, { alignment: { horizontal: 'right', vertical: 'middle' } });

  ws.mergeCells(line.name);
  const nameCell = ws.getCell(line.name.split(':')[0]);
  if (name) nameCell.value = name;
  restyle(nameCell, {
    font: { ...(label.font ?? {}) },
    alignment: { horizontal: 'left', vertical: 'middle', indent: 1, shrinkToFit: true },
  });

  if (signed) {
    const signText = ws.getCell(line.signText.split(':')[0]);
    restyle(signText, { font: { ...(signText.font ?? {}), color: { argb: FADED_SIGN_TEXT } } });
  }
}

async function buildContractWorkbook(data: ContractExcelData): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath());
  const ws = wb.worksheets[0];
  const c = CONTRACT_CELLS;

  // 매장이 하나뿐이라 항상 체크한다 (현업 확정 2026-09-17).
  check(ws, c.store);
  putDate(ws, c.contractDate, data.contractDate);

  if (data.customer.name) putValue(ws, c.customerName, data.customer.name, { bold: true });
  // 양식에 "010 -"가 인쇄돼 있지만, 010이 아닌 번호도 있어 칸 전체를 번호로 바꿔 쓴다.
  const phone = formatContractPhone(data.customer.phone);
  if (phone) putValue(ws, c.phone, phone, { bold: true });

  putDate(ws, c.photoDate, data.photoDate);
  putDate(ws, c.weddingDate, data.weddingDate);

  fillMemo(ws, data.memoLines);

  if (data.asPeriod && c.asPeriod[data.asPeriod]) check(ws, c.asPeriod[data.asPeriod]);

  const total = putValue(ws, c.total, data.totalAmount, { bold: true });
  restyle(total, { numFmt: '#,##0' });
  if (data.paymentMethod && c.paymentMethod[data.paymentMethod]) check(ws, c.paymentMethod[data.paymentMethod]);
  if (data.depositorName) putValue(ws, c.depositorName, data.depositorName);
  putDate(ws, c.paymentDate, data.paymentDate);

  if (data.checklistAgreed) c.checklist.forEach((address) => check(ws, address));

  fillSignLine(ws, SIGN_LINES[0], data.staff.name, !!data.staff.signaturePng);
  fillSignLine(ws, SIGN_LINES[1], data.customerSign.name, !!data.customerSign.signaturePng);

  if (data.urgentProductionTerm) check(ws, c.urgentProductionTerm);
  if (data.trFabricTerm) check(ws, c.trFabricTerm);

  ws.pageSetup.printArea = PRINT_AREA;
  ws.pageSetup.verticalCentered = true;

  return wb;
}

export async function buildContractExcel(data: ContractExcelData): Promise<Buffer> {
  const wb = await buildContractWorkbook(data);
  const out = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  const signatures: SignatureImage[] = [];
  if (data.staff.signaturePng) {
    signatures.push({ key: 'staff', png: data.staff.signaturePng, row: SIGN_LINES[0].row });
  }
  if (data.customerSign.signaturePng) {
    signatures.push({ key: 'customer', png: data.customerSign.signaturePng, row: SIGN_LINES[1].row });
  }
  return attachDrawing(out, rowHeights(wb.worksheets[0]), signatures);
}

// ---------------------------------------------------------------------------
// 드로잉 — 템플릿 그림 복원 + 서명 그림 추가
// ---------------------------------------------------------------------------

interface SignatureImage {
  key: 'staff' | 'customer';
  png: Buffer;
  /** 1-based 서명 줄 행 */
  row: number;
}

/** 행 높이(pt) 조회 — 서명 그림의 세로 범위 계산용 */
type RowHeightPt = (row: number) => number;

function rowHeights(sheet: ExcelJS.Worksheet): RowHeightPt {
  return (row) => sheet.getRow(row).height ?? 15;
}

/** PNG IHDR에서 가로·세로 px를 읽는다. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * 서명 그림 앵커 — "서명" 글자 칸 한가운데에 얹는다.
 *
 * 셀 기준 twoCellAnchor로 적는다. 절대 좌표(px)는 열 너비 환산이 글꼴·OS마다 달라
 * (Mac Excel은 행 높이 pt를 px로 1:1 처리한다) 칸에서 어긋나지만, 셀 앵커는 Excel이
 * 셀 위치를 직접 계산한다. 세로는 윗행 가운데~아랫행 가운데(행 높이 pt라 오차 없음),
 * 가로는 서명 비율에 맞는 칸 수를 "서명" 칸 가운데에서 좌우로 펴되 이름 칸은 넘지 않는다.
 *
 * 캔버스 PNG는 흰 배경이라 흰색을 투명으로 지정해(clrChange) 양식 글자·선이 비치게 한다 —
 * 종이에 "서명" 글자 위로 서명하는 것과 같은 모양이 된다.
 */
function signatureAnchorXml(image: SignatureImage, rowPt: RowHeightPt, relId: string, shapeId: number): string {
  const { width, height } = pngSize(image.png);
  const scale = Math.min(SIGNATURE_MAX_WIDTH_PX / width, SIGNATURE_MAX_HEIGHT_PX / height);
  const ratio = (width * scale) / (height * scale);

  const { row } = image;
  const above = rowPt(row - 1) / 2;
  const below = rowPt(row + 1) / 2;
  const heightPt = above + rowPt(row) + below;

  const centerCol = Math.round((SIGN_TEXT_FIRST_COL + SIGN_TEXT_LAST_COL) / 2);
  const cols = Math.min(
    SIGN_AREA_LAST_COL - SIGN_TEXT_FIRST_COL,
    Math.max(4, Math.round((ratio * heightPt) / FORM_COLUMN_PT)),
  );
  const fromCol = Math.max(SIGN_TEXT_FIRST_COL, centerCol - Math.floor(cols / 2));
  const toCol = fromCol + cols;

  const marker = (tag: 'from' | 'to', col: number, rowIndex: number, rowOffPt: number) =>
    `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${rowIndex}</xdr:row><xdr:rowOff>${Math.round(rowOffPt * EMU_PER_PT)}</xdr:rowOff></xdr:${tag}>`;
  // 0-based 행 인덱스: 윗행 = row-2, 아랫행 = row
  const from = marker('from', fromCol, row - 2, above);
  const to = marker('to', toCol, row, below);
  const cx = Math.round(cols * FORM_COLUMN_PT * EMU_PER_PT);
  const cy = Math.round(heightPt * EMU_PER_PT);
  const name = image.key === 'staff' ? '계약담당자 서명' : '고객 서명';

  return (
    `<xdr:twoCellAnchor editAs="oneCell">${from}${to}` +
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${shapeId}" name="${name}"/>` +
    `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}">` +
    `<a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom>` +
    `<a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>` +
    `</a:blip><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>` +
    `<xdr:clientData/></xdr:twoCellAnchor>`
  );
}

/** 시트 XML에서 <drawing>이 들어갈 자리 — 스키마 순서상 이 요소들보다 앞이어야 한다. */
const AFTER_DRAWING = [
  '<legacyDrawing',
  '<legacyDrawingHF',
  '<picture',
  '<oleObjects',
  '<controls',
  '<webPublishItems',
  '<tableParts',
  '<extLst',
  '</worksheet>',
];

/**
 * ExcelJS 출력에 양식 드로잉을 붙인다.
 *
 * ExcelJS는 셀 기준 앵커(모서리 장식)만 읽고 절대 좌표 그림(로고·QR)은 버린다. 그래서 드로잉 내용을
 * 템플릿 원본으로 되돌리고 서명 그림을 더한다. 시트→드로잉 관계는 ExcelJS가 만든 것이 있으면 그대로 쓰고,
 * 없으면(그림을 하나도 읽지 못한 경우) 새로 잇는다.
 * (최종 양식의 모서리 장식은 셀 기준 앵커라 행 높이·인쇄 배율이 달라도 제자리에 붙는다.)
 */
async function attachDrawing(
  output: Buffer,
  rowPt: RowHeightPt,
  signatures: SignatureImage[],
): Promise<Buffer> {
  const [template, produced] = await Promise.all([
    JSZip.loadAsync(await readFile(templatePath())),
    JSZip.loadAsync(output),
  ]);

  const mediaExtensions = new Set<string>();
  for (const name of Object.keys(template.files)) {
    const entry = template.files[name];
    if (entry.dir || !name.startsWith('xl/media/')) continue;
    produced.file(name, await entry.async('nodebuffer'));
    mediaExtensions.add(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
  }

  let drawing = await template.file(DRAWING_PART)!.async('string');
  let drawingRels = await template.file(DRAWING_RELS_PART)!.async('string');
  signatures.forEach((image, i) => {
    const relId = `rIdSignature${i + 1}`;
    const mediaName = `contract-signature-${image.key}.png`;
    produced.file(`xl/media/${mediaName}`, image.png);
    mediaExtensions.add('png');
    drawingRels = drawingRels.replace(
      '</Relationships>',
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/></Relationships>`,
    );
    drawing = drawing.replace('</xdr:wsDr>', `${signatureAnchorXml(image, rowPt, relId, 100 + i)}</xdr:wsDr>`);
  });
  produced.file(DRAWING_PART, drawing);
  produced.file(DRAWING_RELS_PART, drawingRels);

  // 시트 → 드로잉 관계 (ExcelJS가 이미 이어 뒀으면 그대로 쓴다)
  let sheet = await produced.file(SHEET_PART)!.async('string');
  if (!sheet.includes('<drawing ')) {
    const drawingRelId = 'rIdContractDrawing';
    const drawingRel = `<Relationship Id="${drawingRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`;
    const existingSheetRels = produced.file(SHEET_RELS_PART);
    produced.file(
      SHEET_RELS_PART,
      existingSheetRels
        ? (await existingSheetRels.async('string')).replace('</Relationships>', `${drawingRel}</Relationships>`)
        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRel}</Relationships>`,
    );
    const insertAt = Math.min(...AFTER_DRAWING.map((tag) => sheet.indexOf(tag)).filter((i) => i >= 0));
    sheet = `${sheet.slice(0, insertAt)}<drawing r:id="${drawingRelId}"/>${sheet.slice(insertAt)}`;
    produced.file(SHEET_PART, sheet);
  }

  const typesFile = produced.file('[Content_Types].xml')!;
  let types = await typesFile.async('string');
  if (!types.includes('/xl/drawings/drawing1.xml')) {
    types = types.replace(
      '</Types>',
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>',
    );
  }
  // 이미지 확장자 선언이 빠지면 Excel이 파일을 못 연다 (양식에는 .tmp 그림도 있다).
  for (const ext of mediaExtensions) {
    if (types.includes(`Extension="${ext}"`)) continue;
    const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'tmp' ? 'image/png' : `image/${ext}`;
    types = types.replace(/(<Types\b[^>]*>)/, `$1<Default Extension="${ext}" ContentType="${mime}"/>`);
  }
  produced.file('[Content_Types].xml', types);

  return produced.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
