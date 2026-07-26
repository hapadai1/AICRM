import JSZip from 'jszip';
import { readFile } from 'fs/promises';

/**
 * 양식 도식(그림·도형) 읽기 — 화면 미리보기에 얹기 위한 최소 파서.
 *
 * 도식은 데이터와 무관한 **양식 고정 요소**라 템플릿에서 한 번만 읽어 캐시한다.
 * 출력 파일의 드로잉은 템플릿 바이트를 그대로 옮겨 붙이므로(`preserveTemplateDrawings`)
 * 저장본 미리보기에도 같은 도식을 쓰면 된다.
 *
 * ExcelJS는 도형(xdr:sp·xdr:cxnSp)을 다루지 못해 직접 읽는다. 대상이 고정된 파일 하나뿐이라
 * 범용 DrawingML 파서 대신 필요한 요소(그림 / 타원·선·사각형 · 위치)만 뽑는다.
 */

/** EMU → px (Excel 기준 96dpi) */
const EMU_PER_PX = 9525;

export interface DrawingAnchor {
  /** 셀 기준 위치 (0-based col/row + EMU 오프셋) */
  from: { col: number; colOff: number; row: number; rowOff: number };
  to: { col: number; colOff: number; row: number; rowOff: number };
}

export interface DrawingImage extends DrawingAnchor {
  kind: 'image';
  /** data: URI (미리보기 HTML에 그대로 심는다) */
  src: string;
}

export interface DrawingShape extends DrawingAnchor {
  kind: 'ellipse' | 'line' | 'rect';
  strokeColor: string | null;
  strokeWidthPx: number;
  fillColor: string | null;
  flipH: boolean;
  flipV: boolean;
}

export type DrawingItem = DrawingImage | DrawingShape;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  emf: 'image/emf',
};

function pickAnchor(xml: string): DrawingAnchor | null {
  const read = (tag: 'from' | 'to') => {
    const block = new RegExp(`<xdr:${tag}>([\\s\\S]*?)</xdr:${tag}>`).exec(xml);
    if (!block) return null;
    const num = (name: string) => {
      const m = new RegExp(`<xdr:${name}>(-?\\d+)</xdr:${name}>`).exec(block[1]);
      return m ? Number(m[1]) : 0;
    };
    return { col: num('col'), colOff: num('colOff'), row: num('row'), rowOff: num('rowOff') };
  };
  const from = read('from');
  const to = read('to');
  return from && to ? { from, to } : null;
}

/** spPr 안에서 채우기·선 색을 뽑는다. 선 색은 <a:ln> 안쪽 것만 본다. */
function readStyle(xml: string): Pick<DrawingShape, 'strokeColor' | 'strokeWidthPx' | 'fillColor'> {
  const spPr = /<xdr:spPr[^>]*>([\s\S]*?)<\/xdr:spPr>/.exec(xml)?.[1] ?? '';
  const lnStart = spPr.indexOf('<a:ln');
  const beforeLn = lnStart >= 0 ? spPr.slice(0, lnStart) : spPr;
  const ln = lnStart >= 0 ? spPr.slice(lnStart) : '';

  const fillColor = beforeLn.includes('<a:noFill/>')
    ? null
    : (/<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(beforeLn)?.[1] ?? null);
  const strokeColor = ln.includes('<a:noFill/>')
    ? null
    : (/<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(ln)?.[1] ?? null);
  const widthEmu = Number(/<a:ln[^>]*\bw="(\d+)"/.exec(ln)?.[1] ?? 0);

  return {
    strokeColor: strokeColor ? `#${strokeColor}` : null,
    // 선 두께는 EMU가 아니라 1/12700 pt 단위다. 화면에서는 1px 밑으로 안 내린다.
    strokeWidthPx: Math.max(1, Math.round(widthEmu / 12700 / 0.75)),
    fillColor: fillColor ? `#${fillColor}` : null,
  };
}

function shapeKind(xml: string): DrawingShape['kind'] | null {
  const prst = /<a:prstGeom prst="([A-Za-z0-9]+)"/.exec(xml)?.[1];
  if (prst === 'ellipse') return 'ellipse';
  if (prst === 'line' || prst === 'straightConnector1') return 'line';
  if (prst === 'rect') return 'rect';
  return null;
}

/** 템플릿 zip에서 도식 목록을 만든다 (앵커 순서 = 그리기 순서) */
async function parseDrawing(zip: JSZip): Promise<DrawingItem[]> {
  const drawingFile = zip.file('xl/drawings/drawing1.xml');
  if (!drawingFile) return [];
  const xml = await drawingFile.async('string');

  // r:embed → 미디어 파일 경로
  const relsXml = (await zip.file('xl/drawings/_rels/drawing1.xml.rels')?.async('string')) ?? '';
  const relTargets = new Map<string, string>();
  for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relTargets.set(m[1], m[2].replace('../', 'xl/'));
  }
  const dataUriCache = new Map<string, string>();
  const toDataUri = async (relId: string): Promise<string | null> => {
    const target = relTargets.get(relId);
    if (!target) return null;
    const cached = dataUriCache.get(target);
    if (cached) return cached;
    const file = zip.file(target);
    if (!file) return null;
    const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
    const buffer = await file.async('nodebuffer');
    const uri = `data:${IMAGE_MIME[ext] ?? 'image/png'};base64,${buffer.toString('base64')}`;
    dataUriCache.set(target, uri);
    return uri;
  };

  const items: DrawingItem[] = [];
  for (const match of xml.matchAll(/<xdr:twoCellAnchor[^>]*>[\s\S]*?<\/xdr:twoCellAnchor>/g)) {
    const block = match[0];
    const anchor = pickAnchor(block);
    if (!anchor) continue;

    const embed = /<a:blip[^>]*r:embed="([^"]+)"/.exec(block)?.[1];
    if (embed) {
      const src = await toDataUri(embed);
      if (src) items.push({ kind: 'image', src, ...anchor });
      continue;
    }

    const kind = shapeKind(block);
    if (!kind) continue;
    items.push({
      kind,
      ...anchor,
      ...readStyle(block),
      flipH: /<a:xfrm[^>]*flipH="1"/.test(block),
      flipV: /<a:xfrm[^>]*flipV="1"/.test(block),
    });
  }
  return items;
}

let cached: Promise<DrawingItem[]> | null = null;

/** 템플릿 도식 (프로세스당 한 번만 읽는다) */
export function loadFormDrawing(templatePath: string): Promise<DrawingItem[]> {
  if (!cached) {
    cached = readFile(templatePath)
      .then((buffer) => JSZip.loadAsync(buffer))
      .then(parseDrawing)
      .catch((error) => {
        cached = null; // 다음 요청에서 다시 시도
        throw error;
      });
  }
  return cached;
}

export { EMU_PER_PX };
