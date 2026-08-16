import ExcelJS from 'exceljs';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import JSZip from 'jszip';
import { resolve } from 'path';
import { loadFormDrawing } from './work-order-drawing';
import { renderWorksheetHtml } from './work-order-html';
import {
  BODY_COLUMN,
  CELL,
  FINISH_INCH_COLUMN,
  LOWER_MEASUREMENT_ROWS,
  LOWER_NOTE_MEASUREMENT_MAP,
  MEASUREMENT_ROW_MAP,
  NOT_FILLABLE_FIELDS,
  PREPRINTED_FIELDS,
  UPPER_MEASUREMENT_ROWS,
} from './work-order-template-map';

/**
 * 정장 작업지시서 Excel 생성 — **실물 공장 양식(송파)** 템플릿에 값만 채운다.
 *
 * 양식은 병합·서식·도식 이미지가 고정이라 코드로 다시 그리지 않는다.
 * `templates/suit-work-order.xlsx`를 열어 매핑된 칸만 덮어쓰고 저장한다
 * (좌표·매핑 근거는 work-order-template-map.ts).
 *
 * 채우지 못하는 칸은 비워 둔 채 인쇄되어 현장에서 손으로 적는다 —
 * 목록은 NOT_FILLABLE_FIELDS.
 */
export interface WorkOrderExcelOption {
  stageCode: string;
  stageName: string;
  choiceName: string;
}

export interface WorkOrderExcelMeasurement {
  /** 채촌 항목 코드 (MEASUREMENT_ITEMS.code) */
  code: string;
  /** 화면명 — 양식에 없는 항목을 추가요청사항에 적을 때 쓴다 */
  label: string;
  value: string;
  unit: string;
}

export interface WorkOrderExcelData {
  customerName: string;
  customerPhone: string | null;
  /**
   * 고객 신체 정보 (v2 A2 / 설계서 06 §2.5). 양식의 '키/몸무게'(J3)·'연령대'(Y3) 칸에
   * 출력한다. 채촌 신체열(F)과는 별개의 참고 정보라 서로 덮어쓰지 않는다.
   */
  customerHeightCm: number | null;
  customerWeightKg: number | null;
  customerAge: number | null;
  orderNo: string;
  itemLabel: string;
  productCategory: string;
  sequenceNo: number;
  fabricName: string | null;
  issuedAt: Date;
  note: string | null;
  /** 주문일 (order.createdAt 또는 계약일) */
  orderDate: string | null;
  /** 최근 가봉일 */
  fittingDate: string | null;
  /** 완성 예정일 (order.completionDueDate) */
  completionDate: string | null;
  /** 구성품 수량 (자켓/바지/베스트) */
  componentCounts: { jacket: number; trousers: number; vest: number };
  measurementDate: string;
  measurementVersionNo: number;
  options: WorkOrderExcelOption[];
  measurements: WorkOrderExcelMeasurement[];
  /**
   * 부위별 원단·컬러·패턴 (v2 D3 / 설계서 04 §2.5). 있으면 상의/하의 원단 칸을
   * 부위별 값으로 채우고 컬러·패턴은 해당 추가요청사항에 병기한다.
   * 없으면(하위호환) fabricName 단일값을 상·하의에 함께 출력한다.
   */
  components?: {
    JACKET?: WorkOrderComponentAttr;
    TROUSERS?: WorkOrderComponentAttr;
    VEST?: WorkOrderComponentAttr;
  };
}

export interface WorkOrderComponentAttr {
  fabricName?: string | null;
  colorName?: string | null;
  patternName?: string | null;
  notes?: string | null;
}

const TEMPLATE_FILE = 'templates/suit-work-order.xlsx';

/**
 * 작업지시서 시트 이름. 템플릿은 매장에서 받은 원본 파일 **그대로**라 호칭별 치수
 * 대조표 시트(`바지`·`바지 (2)`·`자켓`)가 함께 들어 있다. 시트를 지우면 그 시트를
 * 가리키는 정의된 이름이 깨지므로, 지우지 않고 출력 시 숨긴다.
 */
export const FORM_SHEET_NAME = '작업지시서 (송파)';
const REFERENCE_SHEET_NAMES = ['바지 (2)', '바지', '자켓'];

/** 템플릿에서 작업지시서 시트를 집어낸다 (첫 시트가 아니다) */
export function getFormSheet(wb: ExcelJS.Workbook): ExcelJS.Worksheet {
  const ws = wb.getWorksheet(FORM_SHEET_NAME);
  if (!ws) {
    throw new Error(`작업지시서 시트를 찾을 수 없습니다: ${FORM_SHEET_NAME}`);
  }
  return ws;
}

/** 선택 표시가 들어간 칸 강조 (양식이 흑백 인쇄라 굵게 + 옅은 회색) */
const MARK_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF2F2F2' },
};

function templatePath(): string {
  const path = resolve(__dirname, TEMPLATE_FILE);
  if (!existsSync(path)) {
    throw new Error(`작업지시서 양식 템플릿을 찾을 수 없습니다: ${path}`);
  }
  return path;
}

/** 양식 기본 글꼴 크기 — 열 너비(문자 수)가 이 크기 기준이다. */
const BASE_FONT_SIZE = 11;
/** 칸에 맞추려고 줄여도 이보다 작게는 안 줄인다(읽을 수 없어진다). */
const MIN_FONT_SIZE = 8;

/** 이 셀이 속한 병합 블록의 가로 폭 (Excel 열 너비 단위 = 기본 글꼴 숫자 한 칸) */
function blockWidthChars(ws: ExcelJS.Worksheet, address: string): number {
  const cell = ws.getCell(address);
  let firstCol = Number(cell.col);
  let lastCol = firstCol;
  for (const range of ws.model.merges ?? []) {
    const [start, end] = range.split(':');
    if (start !== address) continue;
    firstCol = Number(ws.getCell(start).col);
    lastCol = Number(ws.getCell(end).col);
    break;
  }
  let width = 0;
  for (let c = firstCol; c <= lastCol; c += 1) width += ws.getColumn(c).width ?? 8.43;
  return width;
}

/** 한글·한자는 숫자 두 칸 폭으로 잡는다 */
function textWidthChars(text: string): number {
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return width;
}

/**
 * 칸보다 긴 값이면 그 셀의 글꼴을 줄여 한 줄에 들어가게 한다.
 *
 * 양식은 손글씨용이라 값 칸 글꼴이 크게 잡혀 있어(예: 주문일 20pt) 날짜 한 개도
 * 넘친다. Excel은 옆 칸이 비었을 때만 흘려 보여 주므로 라벨이 붙은 칸에서는 잘리고,
 * 미리보기 HTML에서는 줄바꿈돼 양식이 무너진다. 파일·미리보기 양쪽을 함께 고친다.
 */
function fitFontSize(ws: ExcelJS.Worksheet, address: string, text: string): void {
  const cell = ws.getCell(address);
  if (cell.alignment?.wrapText) return; // 줄바꿈 칸(추가요청사항)은 여러 줄이 정상
  const size = cell.font?.size ?? BASE_FONT_SIZE;
  const capacity = (blockWidthChars(ws, address) * BASE_FONT_SIZE) / size;
  const needed = textWidthChars(text);
  if (needed <= capacity) return;
  const fitted = Math.floor((blockWidthChars(ws, address) * BASE_FONT_SIZE) / needed);
  cell.font = { ...(cell.font ?? {}), size: Math.max(MIN_FONT_SIZE, Math.min(size, fitted)) };
}

/** 병합 블록 좌상단에 값 쓰기. 빈 값이면 인쇄된 기본값을 건드리지 않는다. */
function put(ws: ExcelJS.Worksheet, address: string, value: string | null | undefined): void {
  if (value === null || value === undefined || value === '') return;
  ws.getCell(address).value = value;
  fitFontSize(ws, address, value);
}

/**
 * 수량 칸. 양식의 '벌' 칸에는 날짜 표시형식이 걸려 있어 숫자를 그대로 넣으면
 * 1900년대 날짜로 보인다 — 표시형식을 일반으로 되돌리고 쓴다.
 */
function putCount(ws: ExcelJS.Worksheet, address: string, count: number): void {
  if (count <= 0) return;
  const cell = ws.getCell(address);
  cell.numFmt = 'General';
  cell.value = count;
}

/** 인쇄된 보조문구 추출 (양식 일부는 서식이 섞인 리치텍스트다) */
function printedText(value: ExcelJS.CellValue): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && 'richText' in value) {
    return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('').trim();
  }
  return '';
}

/** 선택 표시(O) — 양식이 선택지를 인쇄해 두고 동그라미 치는 칸 */
function mark(ws: ExcelJS.Worksheet, address: string): void {
  const cell = ws.getCell(address);
  cell.value = 'O';
  cell.font = { ...(cell.font ?? {}), bold: true };
  cell.fill = MARK_FILL;
  cell.alignment = { ...(cell.alignment ?? {}), horizontal: 'center', vertical: 'middle' };
}

function fmtDate(value: Date | string | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.toISOString().slice(0, 10);
}

/** 부위 attr의 컬러·패턴·비고를 "컬러: n / 패턴: n" 형태로 묶는다 (원단명 제외). */
function fabricExtras(attr?: WorkOrderComponentAttr): string {
  if (!attr) return '';
  return [
    attr.colorName ? `컬러: ${attr.colorName}` : '',
    attr.patternName ? `패턴: ${attr.patternName}` : '',
    attr.notes ? `비고: ${attr.notes}` : '',
  ]
    .filter(Boolean)
    .join(' / ');
}

/**
 * 옵션 단계 → 양식 칸 매핑.
 * 반환값 false면 이 양식에 대응 칸이 없다는 뜻이라 추가요청사항으로 넘긴다.
 */
function applyOption(ws: ExcelJS.Worksheet, option: WorkOrderExcelOption): boolean {
  const choice = option.choiceName;
  switch (option.stageCode) {
    case 'JACKET_BUTTON':
      put(ws, CELL.button, choice);
      return true;
    case 'LAPEL':
      put(ws, CELL.lapelShape, choice);
      return true;
    case 'POCKET': {
      // 양식은 플랩/아웃/입술/미니 네 칸 중 하나에 표시하는 방식
      const target =
        choice.includes('플랩') ? CELL.pocketFlap
        : choice.includes('아웃') ? CELL.pocketOut
        : choice.includes('제티드') ? CELL.pocketJetted
        : null;
      if (!target) return false;
      mark(ws, target);
      return true;
    }
    case 'VENT':
      put(ws, CELL.ventStyle, choice);
      return true;
    case 'SLEEVE_BUTTON':
      put(ws, CELL.sleeveButtonStyle, choice);
      return true;
    case 'STITCH':
      // 호시 = 스티치
      put(ws, CELL.hoshi, choice);
      return true;
    case 'LINING':
      put(ws, CELL.lining, choice);
      // 언컨 칸은 언컨스트럭티드 선택 여부만 표시한다
      put(ws, CELL.uncon, choice.includes('언컨') ? 'O' : '-');
      return true;
    case 'TROUSER_PLEAT': {
      const count =
        choice.includes('노턱') ? '0 (노턱)'
        : choice.includes('원턱') ? '1 (원턱)'
        : choice.includes('투턱') ? '2 (투턱)'
        : choice;
      put(ws, CELL.pleatCount, count);
      return true;
    }
    case 'TROUSER_HEM':
      put(ws, CELL.cabra, choice.includes('카브라') ? '있음' : '없음');
      return true;
    case 'TROUSER_WAIST':
      if (choice.includes('벨트고리')) {
        put(ws, CELL.beltLoop, 'O');
      } else {
        put(ws, CELL.beltLoop, '-');
        // 사이드어드저스트는 값 칸 없이 라벨만 있는 양식이라 라벨을 강조한다
        const label = ws.getCell(CELL.sideAdjustLabel);
        label.font = { ...(label.font ?? {}), bold: true };
        label.fill = MARK_FILL;
      }
      return true;
    default:
      return false;
  }
}

/** 인치 분수 표기의 최소 단위 — 재단 관례에 맞춘 1/8인치 (매장 확인 2026-07-29). */
const INCH_DENOMINATOR = 8;

/**
 * cm → inch 분수 표기 (1/8인치 단위 반올림). 예: 82.5 → `32 1/2`, 84 → `33 1/8`.
 * 매장은 인치를 소수로 읽지 않으므로 셀에 숫자가 아니라 문자열로 적는다 (설계서 05 §3).
 * 프런트 `frontend/src/api/measurements.ts` `formatInch()`와 같은 규칙이다.
 */
export function formatInch(cm: number): string {
  const eighths = Math.round((Math.abs(cm) / 2.54) * INCH_DENOMINATOR);
  if (eighths === 0) return '0';
  const sign = cm < 0 ? '-' : '';
  const whole = Math.floor(eighths / INCH_DENOMINATOR);
  const rest = eighths % INCH_DENOMINATOR;
  if (rest === 0) return `${sign}${whole}`;
  // 분모가 8이라 약분 인자는 항상 2의 거듭제곱이다 (2/8 → 1/4, 4/8 → 1/2).
  let numerator = rest;
  let denominator = INCH_DENOMINATOR;
  while (numerator % 2 === 0) {
    numerator /= 2;
    denominator /= 2;
  }
  const fraction = `${numerator}/${denominator}`;
  return whole === 0 ? `${sign}${fraction}` : `${sign}${whole} ${fraction}`;
}

/**
 * 채촌 값을 '신체' 열에 쓴다. 인쇄된 보조문구((옆) 등)는 앞에 남긴다.
 *
 * 반환:
 *  - unmapped: 신체열·하의요청사항 어디에도 매핑되지 않아 상의 비고 [치수]로 흘려보낼 값
 *  - lowerNotes: 앞마다/뒷마다처럼 하의 추가요청사항(AA75)에 "앞: n"으로 적을 라벨 값
 *    (설계서 05 §2.2)
 *
 * cm→inch(설계서 05 §3): 신체(F)=cm 원값, 완성(인치)(P)=1/8인치 단위 분수. 항목 행 동일.
 */
function applyMeasurements(
  ws: ExcelJS.Worksheet,
  measurements: WorkOrderExcelMeasurement[],
): { unmapped: string[]; lowerNotes: string[] } {
  const unmapped: string[] = [];
  const lowerNotes: string[] = [];
  for (const m of measurements) {
    // 앞마다/뒷마다는 신체열이 아니라 하의 추가요청사항에 라벨과 함께 적는다.
    const lowerLabel = LOWER_NOTE_MEASUREMENT_MAP.get(m.code);
    if (lowerLabel) {
      lowerNotes.push(`${lowerLabel}: ${m.value}`);
      continue;
    }
    const row = MEASUREMENT_ROW_MAP.get(m.code);
    if (!row) {
      unmapped.push(`${m.label} ${m.value}${m.unit === 'CM' ? 'cm' : ''}`);
      continue;
    }
    const address = `${BODY_COLUMN}${row}`;
    const cell = ws.getCell(address);
    const printed = printedText(cell.value);
    const text = printed ? `${printed} ${m.value}` : m.value;
    cell.value = text;
    fitFontSize(ws, address, text);

    // 완성(인치) 열: 수치형이면 cm→inch 분수 표기로 기입 (설계서 05 §3)
    const cm = Number(String(m.value).replace(/[^\d.-]/g, ''));
    if (Number.isFinite(cm) && cm > 0) {
      const inchAddress = `${FINISH_INCH_COLUMN}${row}`;
      ws.getCell(inchAddress).value = formatInch(cm);
    }
  }
  return { unmapped, lowerNotes };
}

/**
 * '키/몸무게' 칸 문자열 (설계서 06 §2.5). 둘 다 선택 입력이라 있는 값만 적는다.
 * 예: 175cm / 68kg · 175cm · 68kg · (둘 다 없으면 null → 인쇄된 빈칸 유지)
 */
export function formatBodySpec(
  heightCm: number | null,
  weightKg: number | null,
): string | null {
  const parts: string[] = [];
  if (heightCm != null) parts.push(`${heightCm}cm`);
  if (weightKg != null) parts.push(`${weightKg}kg`);
  return parts.length > 0 ? parts.join(' / ') : null;
}

/** 템플릿을 열어 값까지 채운 워크북. 파일 저장과 화면 미리보기가 이걸 함께 쓴다. */
export async function buildWorkOrderWorkbook(data: WorkOrderExcelData): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath());
  const ws = getFormSheet(wb);
  wb.creator = 'AICRM';
  wb.created = data.issuedAt;

  // 치수 대조표 시트는 공장에 넘길 문서가 아니라 숨긴다(삭제하면 정의된 이름이 깨진다).
  for (const name of REFERENCE_SHEET_NAMES) {
    const sheet = wb.getWorksheet(name);
    if (sheet) sheet.state = 'hidden';
  }
  // 파일을 열었을 때 작업지시서 시트가 바로 보이게 한다(탭 순서상 마지막이다).
  const formTabIndex = wb.worksheets.findIndex((sheet) => sheet.name === FORM_SHEET_NAME);
  wb.views = [
    {
      activeTab: formTabIndex,
      firstSheet: formTabIndex,
      x: 0,
      y: 0,
      width: 20000,
      height: 20000,
      visibility: 'visible',
    },
  ];

  // --- 기본 정보 ---------------------------------------------------------
  put(ws, CELL.customerName, data.customerName);
  put(ws, CELL.phone, data.customerPhone);
  put(ws, CELL.bodySpec, formatBodySpec(data.customerHeightCm, data.customerWeightKg));
  put(ws, CELL.ageGroup, data.customerAge != null ? `${data.customerAge}세` : null);
  put(ws, CELL.orderDate, fmtDate(data.orderDate));
  put(ws, CELL.fittingDate, fmtDate(data.fittingDate));
  put(ws, CELL.completionDate, fmtDate(data.completionDate));
  putCount(ws, CELL.jacketQty, data.componentCounts.jacket);
  putCount(ws, CELL.trousersQty, data.componentCounts.trousers);
  putCount(ws, CELL.vestQty, data.componentCounts.vest);

  // 원단·컬러·패턴: 부위별 값이 있으면 상의/하의 원단 칸을 부위별로 채우고
  // 컬러·패턴은 추가요청사항에 병기한다(설계서 04 §2.5). 없으면 하위호환으로
  // fabricName 단일값을 상·하의에 함께 넣는다.
  const componentNoteLines: string[] = [];
  if (data.components) {
    const jacket = data.components.JACKET;
    const trousers = data.components.TROUSERS;
    const vest = data.components.VEST;
    put(ws, CELL.upperFabricName, jacket?.fabricName ?? data.fabricName);
    put(ws, CELL.lowerFabricName, trousers?.fabricName ?? data.fabricName);
    const jacketExtra = fabricExtras(jacket);
    if (jacketExtra) componentNoteLines.push(`[상의] ${jacketExtra}`);
    const trousersExtra = fabricExtras(trousers);
    if (trousersExtra) componentNoteLines.push(`[하의] ${trousersExtra}`);
    // 베스트 전용 칸이 없어 상의 추가요청사항에 라인으로 출력한다(설계서 04 M4).
    const vestParts = [vest?.fabricName, fabricExtras(vest)].filter(Boolean).join(' / ');
    if (vestParts) componentNoteLines.push(`[베스트] ${vestParts}`);
  } else {
    put(ws, CELL.upperFabricName, data.fabricName);
    put(ws, CELL.lowerFabricName, data.fabricName);
  }

  // --- 옵션 --------------------------------------------------------------
  const unmappedOptions: string[] = [];
  for (const option of data.options) {
    if (!applyOption(ws, option)) {
      unmappedOptions.push(`${option.stageName}: ${option.choiceName}`);
    }
  }

  // --- 채촌 --------------------------------------------------------------
  const { unmapped: unmappedMeasurements, lowerNotes } = applyMeasurements(ws, data.measurements);

  // 앞마다/뒷마다는 하의 추가요청사항(AA75)에 "앞: n / 뒤: n"으로 기입한다 (설계서 05 §2.2).
  if (lowerNotes.length > 0) {
    const lowerCell = ws.getCell(CELL.lowerNote);
    const printed = printedText(lowerCell.value); // 인쇄 보조문구 보존
    lowerCell.value = [printed, `[마다] ${lowerNotes.join(' / ')}`].filter(Boolean).join('\n');
    lowerCell.alignment = { ...(lowerCell.alignment ?? {}), wrapText: true, vertical: 'top' };
  }

  // --- 추가요청사항 (양식 칸이 없는 값 + 출력 이력) ------------------------
  const noteLines: string[] = [];
  if (data.note) noteLines.push(data.note);
  // 부위별 컬러·패턴·베스트 원단 (양식 전용 칸이 없어 상의 추가요청사항에 병기)
  for (const line of componentNoteLines) noteLines.push(line);
  if (unmappedOptions.length > 0) noteLines.push(`[옵션] ${unmappedOptions.join(' / ')}`);
  if (unmappedMeasurements.length > 0) noteLines.push(`[치수] ${unmappedMeasurements.join(' / ')}`);
  noteLines.push(
    `[출력] ${data.orderNo} ${data.itemLabel}(${data.productCategory}#${data.sequenceNo}) · ` +
      `작업지시서 V${0} ${fmtDate(data.issuedAt)} · ` +
      `채촌 V${data.measurementVersionNo} ${data.measurementDate}`,
  );
  const noteCell = ws.getCell(CELL.upperNote);
  noteCell.value = noteLines.join('\n');
  noteCell.alignment = { ...(noteCell.alignment ?? {}), wrapText: true, vertical: 'top' };

  return wb;
}

/**
 * ExcelJS가 다시 쓴 드로잉을 **템플릿 원본으로 되돌린다.**
 *
 * 양식의 도식은 그림(xdr:pic)만이 아니라 **도형**(xdr:sp — 빨간 동그라미·점선 지시선)으로
 * 이뤄져 있다. ExcelJS는 도형을 모르는 탓에 읽을 때 전부 그림으로 뭉뚱그리고, 쓸 때
 * 크기·위치를 `0`으로 적어 버린다. 그래서 값만 채워도 도식이 검은 덩어리로 깨진다.
 *
 * 값(시트 XML)은 ExcelJS 결과를 쓰고, 드로잉·이미지 부품만 템플릿 바이트 그대로 덮어
 * 원본 도식을 지킨다. 시트가 참조하는 관계 id는 ExcelJS가 이미 drawing1로 맞춰 둔다.
 */
async function preserveTemplateDrawings(output: Buffer): Promise<Buffer> {
  const [template, produced] = await Promise.all([
    JSZip.loadAsync(await readFile(templatePath())),
    JSZip.loadAsync(output),
  ]);

  const partNames = Object.keys(template.files).filter(
    (name) => !template.files[name].dir && (name.startsWith('xl/drawings/') || name.startsWith('xl/media/')),
  );
  for (const name of partNames) {
    produced.file(name, await template.files[name].async('nodebuffer'));
  }

  // 이미지 확장자 선언이 빠지면 Excel이 파일을 못 연다. ExcelJS가 이미 넣지만 확인해 채운다.
  const typesPath = '[Content_Types].xml';
  const typesFile = produced.file(typesPath);
  if (typesFile) {
    let types = await typesFile.async('string');
    const extensions = new Set(
      partNames
        .filter((n) => n.startsWith('xl/media/'))
        .map((n) => n.slice(n.lastIndexOf('.') + 1).toLowerCase()),
    );
    for (const ext of extensions) {
      if (types.includes(`Extension="${ext}"`)) continue;
      const declaration = `<Default Extension="${ext}" ContentType="image/${ext === 'jpg' ? 'jpeg' : ext}"/>`;
      types = types.replace(/(<Types\b[^>]*>)/, `$1${declaration}`);
    }
    produced.file(typesPath, types);
  }

  return produced.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function buildWorkOrderExcel(data: WorkOrderExcelData): Promise<Buffer> {
  const wb = await buildWorkOrderWorkbook(data);
  const out = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  return preserveTemplateDrawings(out);
}

/**
 * 구두(SHOES) 간이 작업지시서 (설계서 06 §5-a·A6).
 *
 * 구두는 전용 공장 양식이 없어 정장 송파 템플릿(suit-work-order.xlsx)을 쓰지 않고,
 * exceljs로 병합·도식 없는 **메모형 시트**를 새로 그린다. 고객·주문·품목·확정 옵션·채촌·메모를
 * 나열한다. 정장/셔츠는 기존 buildWorkOrderExcel(송파 템플릿)을 그대로 쓴다.
 */
export async function buildShoesWorkOrderExcel(data: WorkOrderExcelData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AICRM';
  wb.created = data.issuedAt;
  const ws = wb.addWorksheet('구두 작업지시서');
  ws.columns = [{ width: 18 }, { width: 48 }];

  const titleRow = ws.addRow(['구두 작업지시서', '']);
  titleRow.font = { bold: true, size: 14 };
  ws.mergeCells(`A${titleRow.number}:B${titleRow.number}`);
  ws.addRow([]);

  const label = (text: string, value: string | number | null | undefined) => {
    const row = ws.addRow([text, value == null || value === '' ? '-' : value]);
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { vertical: 'top' };
    row.getCell(2).alignment = { vertical: 'top', wrapText: true };
    return row;
  };

  const section = (text: string) => {
    const row = ws.addRow([text, '']);
    row.getCell(1).font = { bold: true, size: 12 };
    row.getCell(1).fill = MARK_FILL;
    row.getCell(2).fill = MARK_FILL;
    ws.mergeCells(`A${row.number}:B${row.number}`);
    return row;
  };

  section('기본 정보');
  label('고객명', data.customerName);
  label('연락처', data.customerPhone);
  // 고객 신체 정보 (설계서 06 §2.5 — 구두 메모형에도 동일 출력)
  label('키/몸무게', formatBodySpec(data.customerHeightCm, data.customerWeightKg));
  label('연령', data.customerAge != null ? `${data.customerAge}세` : null);
  label('주문번호', data.orderNo);
  label('품목', `${data.itemLabel} (${data.productCategory}#${data.sequenceNo})`);
  label('주문일', fmtDate(data.orderDate));
  label('완성예정일', fmtDate(data.completionDate));
  label('작업지시서', `V${0} · ${fmtDate(data.issuedAt)}`);

  ws.addRow([]);
  section('확정 옵션');
  if (data.options.length === 0) {
    label('옵션', '-');
  } else {
    for (const o of data.options) label(o.stageName, o.choiceName);
  }

  ws.addRow([]);
  section(`채촌 (V${data.measurementVersionNo} · ${data.measurementDate})`);
  if (data.measurements.length === 0) {
    label('채촌', '-');
  } else {
    for (const m of data.measurements) {
      label(m.label, `${m.value}${m.unit === 'CM' ? 'cm' : ''}`);
    }
  }

  ws.addRow([]);
  section('메모');
  const memoRow = ws.addRow(['', data.note ?? '-']);
  ws.mergeCells(`A${memoRow.number}:B${memoRow.number}`);
  memoRow.getCell(1).value = data.note ?? '-';
  memoRow.getCell(1).alignment = { vertical: 'top', wrapText: true };

  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

/** 출력 전 확인용 HTML. 파일과 같은 워크북을 그리므로 내용이 어긋나지 않는다. */
export async function buildWorkOrderPreviewHtml(data: WorkOrderExcelData): Promise<string> {
  const [wb, drawing] = await Promise.all([
    buildWorkOrderWorkbook(data),
    loadFormDrawing(templatePath()),
  ]);
  return renderWorksheetHtml(getFormSheet(wb), drawing);
}

/** 이미 저장된 출력본 파일을 그대로 그린다 (출력 이력 보기) */
export async function renderStoredWorkOrderHtml(filePath: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  // 저장본의 도식은 템플릿 바이트를 그대로 옮겨 붙인 것이라 템플릿 도식과 같다.
  return renderWorksheetHtml(getFormSheet(wb), await loadFormDrawing(templatePath()));
}

/**
 * 최종 작업지시서로 올린 **임의 xlsx**를 표로 그린다 (2026-08-16).
 * 시스템 양식(송파 시트)이면 도식까지 얹어 원본 그대로, 아니면 첫 시트를 실제 사용 범위만큼
 * 표로 그린다 — 담당자가 작업지시서를 받아 고친 파일이 아니라 다른 양식이어도 미리보기가 되게.
 */
export async function renderStoredXlsxHtml(filePath: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const formSheet = wb.getWorksheet(FORM_SHEET_NAME);
  if (formSheet) return renderWorksheetHtml(formSheet, await loadFormDrawing(templatePath()));

  const ws = wb.worksheets[0];
  if (!ws) throw new Error('시트를 찾을 수 없습니다.');
  // 빈 셀까지 다 그리면 표가 지나치게 커지므로 실제 사용 범위로 (상한 400×64) 자른다.
  const lastRow = Math.min(Math.max(ws.actualRowCount || ws.rowCount || 1, 1), 400);
  const lastCol = Math.min(Math.max(ws.actualColumnCount || ws.columnCount || 1, 1), 64);
  return renderWorksheetHtml(ws, [], { lastRow, lastCol });
}

export { NOT_FILLABLE_FIELDS, PREPRINTED_FIELDS, UPPER_MEASUREMENT_ROWS, LOWER_MEASUREMENT_ROWS };
