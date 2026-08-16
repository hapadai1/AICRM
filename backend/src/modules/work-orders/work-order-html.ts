import ExcelJS from 'exceljs';
import { EMU_PER_PX, type DrawingItem } from './work-order-drawing';

/**
 * 작업지시서 워크시트를 화면 미리보기용 HTML 표로 옮긴다.
 *
 * 출력 파일과 **같은 워크북**을 그려서 "미리 본 것과 내려받은 것이 다르다"가 생기지 않게 한다.
 * 셀 병합·테두리·굵기·정렬·배경을 옮기고, 도식(그림·빨간 동그라미·지시선)은 셀 앵커를
 * 격자 좌표로 환산해 표 위에 겹쳐 그린다.
 */

/** 양식이 실제로 그려진 범위 — 그 아래는 빈 행이라 그리지 않는다. */
const LAST_ROW = 78;
const LAST_COL = 64;

/** 화면 표시 배율 (Excel 인쇄 배율 52%에 맞춘 값) */
const SCREEN_ZOOM = 0.65;

/** Excel 열 너비(문자 수) → px. Excel 기본 문자폭 7px + 여백 5px */
function colWidthPx(width: number | undefined): number {
  return Math.round((width ?? 8.43) * 7 + 5);
}

/** Excel 행 높이(pt) → px */
function rowHeightPx(height: number | undefined): number {
  return Math.round((height ?? 15) * (4 / 3));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ARGB(FFRRGGBB) → #RRGGBB. theme·indexed 색은 판단할 수 없어 undefined */
function toCssColor(color: Partial<ExcelJS.Color> | undefined): string | undefined {
  if (!color?.argb) return undefined;
  const argb = color.argb;
  return `#${argb.length === 8 ? argb.slice(2) : argb}`;
}

const BORDER_WIDTH: Record<string, string> = {
  hair: '1px solid',
  thin: '1px solid',
  dotted: '1px dotted',
  dashed: '1px dashed',
  medium: '2px solid',
  thick: '3px solid',
  double: '3px double',
};

function borderCss(side: Partial<ExcelJS.Border> | undefined): string | null {
  if (!side?.style) return null;
  const line = BORDER_WIDTH[side.style] ?? '1px solid';
  return `${line} ${toCssColor(side.color) ?? '#000'}`;
}

/** 셀 표시 문자열 — 리치텍스트·수식 결과·날짜를 모두 문자열로 편다. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    }
    if ('result' in value) return cellText((value as ExcelJS.CellFormulaValue).result ?? '');
    if ('text' in value) return String((value as ExcelJS.CellHyperlinkValue).text ?? '');
  }
  return '';
}

function cellStyle(cell: ExcelJS.Cell): string {
  const styles: string[] = [];
  const border = cell.border ?? {};
  const sides: Array<[keyof ExcelJS.Borders, string]> = [
    ['top', 'border-top'],
    ['bottom', 'border-bottom'],
    ['left', 'border-left'],
    ['right', 'border-right'],
  ];
  for (const [key, prop] of sides) {
    const css = borderCss(border[key] as Partial<ExcelJS.Border> | undefined);
    if (css) styles.push(`${prop}:${css}`);
  }

  const font = cell.font;
  if (font?.bold) styles.push('font-weight:700');
  if (font?.italic) styles.push('font-style:italic');
  if (font?.size) styles.push(`font-size:${Math.round(font.size * (4 / 3))}px`);
  const fontColor = toCssColor(font?.color);
  if (fontColor) styles.push(`color:${fontColor}`);

  const fill = cell.fill;
  if (fill?.type === 'pattern' && fill.pattern === 'solid') {
    const bg = toCssColor(fill.fgColor);
    if (bg) styles.push(`background:${bg}`);
  }

  const align = cell.alignment;
  styles.push(`text-align:${align?.horizontal ?? 'left'}`);
  const vertical = align?.vertical === 'middle' ? 'middle' : (align?.vertical ?? 'bottom');
  styles.push(`vertical-align:${vertical}`);
  if (align?.wrapText) {
    styles.push('white-space:pre-wrap');
  } else {
    // Excel과 같게: 줄바꿈 칸이 아니면 한 줄로 두고, 넘치면 옆으로 흘려 보여 준다.
    // 표 칸에 가둬 줄바꿈시키면 행 높이가 밀려 양식 자체가 무너진다.
    styles.push('white-space:nowrap', 'overflow:visible');
  }

  return styles.join(';');
}

/**
 * 줄바꿈 칸은 Excel처럼 **칸 높이에서 잘리게** 한다.
 *
 * 양식에는 좁은 한 칸에 긴 문구가 들어간 자리가 있다(조끼 메모 등). 표 칸에 그대로 두면
 * 한 글자씩 세로로 늘어지며 행 높이를 밀어 양식 전체가 어긋난다. Excel은 행 높이에서
 * 잘라 보여 주므로 같은 높이의 내부 상자에 넣고 넘치는 부분을 감춘다.
 * 줄바꿈이 아닌 칸은 한 줄이라 높이가 늘지 않으니 그대로 둔다(옆으로 흘려 보여 준다).
 */
function wrapCellContent(
  ws: ExcelJS.Worksheet,
  row: number,
  rowspan: number,
  cell: ExcelJS.Cell,
  html: string,
): string {
  if (!cell.alignment?.wrapText || html === '') return html;
  let height = 0;
  for (let r = row; r < row + rowspan; r += 1) height += rowHeightPx(ws.getRow(r).height);
  return `<div style="max-height:${height}px;overflow:hidden">${html}</div>`;
}

/** 병합 범위 문자열('A1:C2') → 좌상단 주소별 span, 가려지는 셀 집합 */
function indexMerges(ws: ExcelJS.Worksheet): {
  spans: Map<string, { colspan: number; rowspan: number }>;
  covered: Set<string>;
} {
  const spans = new Map<string, { colspan: number; rowspan: number }>();
  const covered = new Set<string>();
  for (const range of ws.model.merges ?? []) {
    const [start, end] = range.split(':');
    const tl = ws.getCell(start);
    const br = ws.getCell(end);
    spans.set(start, {
      colspan: Number(br.col) - Number(tl.col) + 1,
      rowspan: Number(br.row) - Number(tl.row) + 1,
    });
    for (let r = Number(tl.row); r <= Number(br.row); r += 1) {
      for (let c = Number(tl.col); c <= Number(br.col); c += 1) {
        if (r === Number(tl.row) && c === Number(tl.col)) continue;
        covered.add(`${r}:${c}`);
      }
    }
  }
  return { spans, covered };
}

/** 셀 격자 기준 좌표 계산기 (도식 배치용) */
function gridGeometry(ws: ExcelJS.Worksheet) {
  /** 0-based 열 인덱스의 왼쪽 x (px) */
  const colLeft = (col: number): number => {
    let x = 0;
    for (let c = 1; c <= col; c += 1) x += colWidthPx(ws.getColumn(c).width);
    return x;
  };
  /** 0-based 행 인덱스의 위쪽 y (px) */
  const rowTop = (row: number): number => {
    let y = 0;
    for (let r = 1; r <= row; r += 1) y += rowHeightPx(ws.getRow(r).height);
    return y;
  };
  return {
    x: (a: { col: number; colOff: number }) => colLeft(a.col) + a.colOff / EMU_PER_PX,
    y: (a: { row: number; rowOff: number }) => rowTop(a.row) + a.rowOff / EMU_PER_PX,
  };
}

/**
 * 도식(그림·빨간 동그라미·지시선)을 표 위에 겹쳐 그린다.
 *
 * 표만 그리면 어느 부위를 가리키는 지시인지 알 수 없어 미리보기 구실을 못 한다.
 * 셀 앵커(열·행 + EMU 오프셋)를 격자 좌표로 환산해 같은 자리에 얹는다.
 */
function renderDrawingLayer(ws: ExcelJS.Worksheet, items: DrawingItem[]): string {
  if (items.length === 0) return '';
  const geo = gridGeometry(ws);
  const boxes: string[] = [];
  const lines: string[] = [];

  for (const item of items) {
    const left = geo.x(item.from);
    const top = geo.y(item.from);
    const width = Math.max(1, geo.x(item.to) - left);
    const height = Math.max(1, geo.y(item.to) - top);
    const place = `left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${width.toFixed(1)}px;height:${height.toFixed(1)}px`;

    if (item.kind === 'image') {
      boxes.push(`<img src="${item.src}" style="position:absolute;${place}">`);
      continue;
    }
    if (item.kind === 'line') {
      // 앵커 사각형의 대각선이 선이다. flip이 걸리면 반대쪽 대각선을 잇는다.
      const x1 = item.flipH ? left + width : left;
      const x2 = item.flipH ? left : left + width;
      const y1 = item.flipV ? top + height : top;
      const y2 = item.flipV ? top : top + height;
      lines.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ` +
          `stroke="${item.strokeColor ?? '#000'}" stroke-width="${item.strokeWidthPx}"/>`,
      );
      continue;
    }
    const style = [
      'position:absolute',
      'box-sizing:border-box',
      place,
      item.strokeColor ? `border:${item.strokeWidthPx}px solid ${item.strokeColor}` : '',
      item.fillColor ? `background:${item.fillColor}` : '',
      item.kind === 'ellipse' ? 'border-radius:50%' : '',
    ]
      .filter(Boolean)
      .join(';');
    boxes.push(`<div style="${style}"></div>`);
  }

  const svg =
    lines.length > 0
      ? `<svg style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible" xmlns="http://www.w3.org/2000/svg">${lines.join('')}</svg>`
      : '';
  return `<div style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none">${boxes.join('')}${svg}</div>`;
}

/**
 * 워크시트 → HTML 문서 (iframe srcdoc로 그대로 띄울 수 있는 완결형).
 * 화면 표시 전용이며 저장·전달 대상은 어디까지나 xlsx 파일이다.
 */
export function renderWorksheetHtml(
  ws: ExcelJS.Worksheet,
  drawing: DrawingItem[] = [],
  // 그릴 범위. 기본값은 작업지시서 양식(송파) 크기 — 양식이 아닌 임의 xlsx는 실제 사용 범위를 넘긴다.
  bounds: { lastRow: number; lastCol: number } = { lastRow: LAST_ROW, lastCol: LAST_COL },
): string {
  const { lastRow, lastCol } = bounds;
  const { spans, covered } = indexMerges(ws);

  const cols: string[] = [];
  for (let c = 1; c <= lastCol; c += 1) {
    cols.push(`<col style="width:${colWidthPx(ws.getColumn(c).width)}px">`);
  }

  const rows: string[] = [];
  for (let r = 1; r <= lastRow; r += 1) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= lastCol; c += 1) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = row.getCell(c);
      const span = spans.get(cell.address);
      const attrs = [
        span && span.colspan > 1 ? ` colspan="${span.colspan}"` : '',
        span && span.rowspan > 1 ? ` rowspan="${span.rowspan}"` : '',
        ` style="${cellStyle(cell)}"`,
      ].join('');
      const text = escapeHtml(cellText(cell.value)).replace(/\r?\n/g, '<br>');
      cells.push(`<td${attrs}>${wrapCellContent(ws, r, span?.rowspan ?? 1, cell, text)}</td>`);
    }
    rows.push(`<tr style="height:${rowHeightPx(row.height)}px">${cells.join('')}</tr>`);
  }

  return [
    '<!doctype html><html lang="ko"><head><meta charset="utf-8">',
    '<style>',
    'body{margin:0;padding:12px;background:#fff;font-family:"맑은 고딕","Malgun Gothic",sans-serif;}',
    // 양식 원본 폭이 1500px 남짓이라 화면에 담기지 않는다. Excel 인쇄 배율(52%)에
    // 가깝게 줄여 한눈에 보이게 하고, 남는 폭은 스크롤로 둔다.
    `#sheet{zoom:${SCREEN_ZOOM};}`,
    'table{border-collapse:collapse;table-layout:fixed;}',
    'td{font-size:13px;line-height:1.15;padding:0 1px;}',
    '</style></head><body>',
    `<div id="sheet"><div style="position:relative;display:inline-block">`,
    `<table><colgroup>${cols.join('')}</colgroup>`,
    `<tbody>${rows.join('')}</tbody></table>`,
    renderDrawingLayer(ws, drawing),
    '</div></div>',
    '</body></html>',
  ].join('');
}
