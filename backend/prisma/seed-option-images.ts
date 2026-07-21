/**
 * 옵션 선택지 이미지 시드
 * - 옵션 세트(정장·셔츠·구두)의 모든 단계에 대해 선택지 A(#1)/B(#2) 이미지를 생성한다.
 * - 데모 시드가 넣어둔 1x1 투명 PNG placeholder를 실제로 식별 가능한 SVG 썸네일로 교체한다.
 * - 재실행 안전: 이미 이 스크립트가 만든 이미지(originalName이 opt_로 시작)면 내용만 갱신한다.
 * - 실행: npm run seed:option-images
 */
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const prisma = new PrismaClient();

const SVG_MIME = 'image/svg+xml';

/** 품목별 색상(배경 그라데이션·강조색) */
const CATEGORY_THEME: Record<string, { from: string; to: string; accent: string; label: string }> = {
  SUIT: { from: '#eef2ff', to: '#dbe3ff', accent: '#3b5bdb', label: '정장' },
  SHIRT: { from: '#e6fcf5', to: '#c3fae8', accent: '#0ca678', label: '셔츠' },
  SHOES: { from: '#fff4e6', to: '#ffe8cc', accent: '#e8590c', label: '구두' },
};

/** XML 특수문자 이스케이프 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 선택지명을 최대 2줄로 나눈다 (한 줄 9자 기준) */
function wrap(text: string, perLine = 9): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > perLine && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length > 2) return [lines[0], `${lines.slice(1).join(' ').slice(0, perLine - 1)}…`];
  return lines;
}

/**
 * 단계·선택지별로 다른 라인아트 모티프.
 * stageCode 해시로 6종 중 하나를 고르고, 선택지(A/B)에 따라 변형을 준다.
 */
function motif(stageCode: string, isB: boolean, accent: string): string {
  const kind = [...stageCode].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 6;
  const s = `stroke="${accent}" fill="none" stroke-width="2.5" stroke-linecap="round"`;
  switch (kind) {
    case 0: // 단추/원형
      return isB
        ? `<g ${s}><circle cx="60" cy="52" r="9"/><circle cx="60" cy="80" r="9"/><circle cx="60" cy="108" r="9"/></g>`
        : `<g ${s}><circle cx="60" cy="66" r="9"/><circle cx="60" cy="96" r="9"/></g>`;
    case 1: // 라펠/브이
      return isB
        ? `<g ${s}><path d="M40 40 L60 80 L80 40"/><path d="M46 84 L60 104 L74 84"/></g>`
        : `<g ${s}><path d="M40 40 L60 90 L80 40"/></g>`;
    case 2: // 포켓/사각
      return isB
        ? `<g ${s}><rect x="38" y="52" width="44" height="26" rx="3"/><rect x="38" y="86" width="44" height="26" rx="3"/></g>`
        : `<g ${s}><rect x="38" y="62" width="44" height="34" rx="3"/><path d="M38 74 H82"/></g>`;
    case 3: // 스티치/사선
      return isB
        ? `<g ${s}><path d="M36 108 L84 48"/><path d="M46 112 L94 52"/></g>`
        : `<g ${s} stroke-dasharray="6 5"><path d="M36 108 L84 48"/></g>`;
    case 4: // 밑단/수평선
      return isB
        ? `<g ${s}><path d="M34 62 H86"/><path d="M34 82 H86"/><path d="M34 102 H86"/></g>`
        : `<g ${s}><path d="M34 72 H86"/><path d="M34 96 H86"/></g>`;
    default: // 토캡/곡선
      return isB
        ? `<g ${s}><path d="M34 100 Q60 44 86 100"/><path d="M46 100 Q60 70 74 100"/></g>`
        : `<g ${s}><path d="M34 100 Q60 52 86 100"/></g>`;
  }
}

function buildSvg(args: {
  category: string;
  stageName: string;
  choiceName: string;
  choiceCode: string;
  stageCode: string;
  sequenceNo: number;
}): string {
  const theme = CATEGORY_THEME[args.category] ?? CATEGORY_THEME.SUIT;
  const isB = args.choiceCode === 'B';
  const slotLabel = isB ? '#2' : '#1';
  const lines = wrap(args.choiceName);
  const titleY = lines.length === 1 ? 128 : 120;
  const nameLines = lines
    .map(
      (line, i) =>
        `<text x="120" y="${titleY + i * 20}" font-size="16" font-weight="700" fill="#212529" text-anchor="middle">${esc(line)}</text>`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="170" viewBox="0 0 240 170" role="img" aria-label="${esc(`${args.stageName} ${slotLabel} ${args.choiceName}`)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${theme.from}"/>
      <stop offset="100%" stop-color="${theme.to}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="240" height="170" rx="10" fill="url(#bg)" stroke="${theme.accent}" stroke-opacity="0.25"/>
  <text x="14" y="24" font-size="11" fill="${theme.accent}" font-weight="600">${esc(theme.label)} · ${args.sequenceNo}단계</text>
  <text x="14" y="42" font-size="13" fill="#495057">${esc(args.stageName)}</text>
  <g transform="translate(60,0)">${motif(args.stageCode, isB, theme.accent)}</g>
  <rect x="182" y="12" width="44" height="24" rx="12" fill="${theme.accent}"/>
  <text x="204" y="29" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">${slotLabel}</text>
  ${nameLines}
</svg>
`;
}

function storageRoot(): string {
  return resolve(process.env.FILE_STORAGE_PATH ?? './storage');
}

async function main(): Promise<void> {
  const sets = await prisma.optionSet.findMany({
    include: {
      versions: {
        include: {
          stages: {
            orderBy: { sequenceNo: 'asc' },
            include: { choices: { orderBy: { choiceCode: 'asc' } } },
          },
        },
      },
    },
  });
  if (sets.length === 0) throw new Error('옵션 세트가 없습니다. 기본 시드를 먼저 실행하세요.');

  let created = 0;
  let updated = 0;

  for (const set of sets) {
    for (const version of set.versions) {
      for (const stage of version.stages) {
        for (const choice of stage.choices) {
          const svg = buildSvg({
            category: set.productCategory,
            stageName: stage.stageName,
            choiceName: choice.choiceName,
            choiceCode: choice.choiceCode,
            stageCode: stage.stageCode,
            sequenceNo: stage.sequenceNo,
          });
          const buffer = Buffer.from(svg, 'utf8');
          const originalName = `opt_${set.productCategory}_${stage.stageCode}_${choice.choiceCode}.svg`;
          const existing = await prisma.file.findUnique({ where: { id: choice.imageFileId } });

          if (existing && existing.originalName.startsWith('opt_')) {
            // 이 스크립트가 만든 파일 → 내용만 갱신
            const absolutePath = join(storageRoot(), existing.storageKey);
            mkdirSync(dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, buffer);
            await prisma.file.update({
              where: { id: existing.id },
              data: {
                originalName,
                mimeType: SVG_MIME,
                sizeBytes: BigInt(buffer.length),
                checksumSha256: createHash('sha256').update(buffer).digest('hex'),
              },
            });
            updated += 1;
            continue;
          }

          const fileId = randomUUID();
          const storageKey = `option-choices/${fileId}.svg`;
          const absolutePath = join(storageRoot(), storageKey);
          mkdirSync(dirname(absolutePath), { recursive: true });
          writeFileSync(absolutePath, buffer);
          await prisma.file.create({
            data: {
              id: fileId,
              storageKey,
              originalName,
              mimeType: SVG_MIME,
              sizeBytes: BigInt(buffer.length),
              checksumSha256: createHash('sha256').update(buffer).digest('hex'),
            },
          });
          await prisma.optionChoice.update({
            where: { id: choice.id },
            data: { imageFileId: fileId },
          });
          created += 1;
        }
      }
    }
  }

  console.log(`옵션 선택지 이미지: 신규 ${created}건 / 갱신 ${updated}건`);
}

main()
  .catch((error) => {
    console.error('옵션 이미지 시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
