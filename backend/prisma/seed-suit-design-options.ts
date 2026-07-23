/**
 * 정장 옵션 세트를 '디자인 상담' 자료 기준으로 새 버전(11단계·29선택지)으로 등록한다.
 *
 * - 선택지 사진은 prisma/assets/suit-design/*.jpg (PDF에서 추출한 원본).
 *   추출은 assets/extract-suit-design-images.py가 담당하며 PDF가 바뀔 때만 다시 돌린다.
 * - 기존 ACTIVE 버전을 덮어쓰지 않고 새 DRAFT를 만들어 활성화한다.
 *   진행 중인 선택 세션은 이전 버전을 계속 참조하므로 영향받지 않는다.
 * - 실행: npm run seed:suit-design  (이미 반영돼 있으면 건너뜀, SUIT_DESIGN_FORCE=1로 강제)
 */
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

const prisma = new PrismaClient();

/** 이 스크립트가 만든 버전임을 알아보는 표식 */
const MARKER = '디자인 상담 자료 기준 정장 옵션';
const ASSET_DIR = resolve(__dirname, 'assets/suit-design');

interface ChoiceSeed {
  name: string;
  /** 계약금액에 더해지는 추가금액(원) */
  extraPrice?: number;
  /**
   * 자산 파일명 접미사. 기본은 선택지 순서(A/B/C)와 같다.
   * 원본 PDF의 사진·라벨이 어긋난 단계에서만 지정한다.
   */
  imageSlot?: 'A' | 'B' | 'C';
}

interface StageSeed {
  code: string;
  name: string;
  choices: ChoiceSeed[];
}

/** PDF 3~13페이지 순서 그대로 (2페이지 TR원단은 옵션이 아니라 설명 자료라 제외) */
const STAGES: StageSeed[] = [
  {
    code: 'JACKET_BUTTON',
    name: '자켓 디자인',
    // 원본 PDF 3페이지는 사진과 라벨이 서로 바뀌어 있다(왼쪽이 더블인데 '싱글 버튼'으로 표기).
    // 옷 모양을 기준으로 바로잡아 연결한다.
    choices: [
      { name: '싱글 버튼', imageSlot: 'B' },
      { name: '더블 버튼', extraPrice: 33000, imageSlot: 'A' },
    ],
  },
  {
    code: 'LAPEL',
    name: '라펠 디자인',
    choices: [{ name: '노치드' }, { name: '피크드' }, { name: '숄카라' }],
  },
  {
    code: 'POCKET',
    name: '포켓 디자인',
    choices: [{ name: '플랩포켓' }, { name: '제티드포켓' }, { name: '아웃포켓' }],
  },
  {
    code: 'VENT',
    name: '뒷트임 디자인',
    choices: [{ name: '양쪽트임' }, { name: '중간트임' }, { name: '트임없음' }],
  },
  {
    code: 'SLEEVE_BUTTON',
    name: '소매 디자인',
    choices: [{ name: '기본버튼' }, { name: '페이크버튼' }, { name: '리얼버튼', extraPrice: 33000 }],
  },
  {
    code: 'LAPEL_HOLE',
    name: '라펠홀 디자인',
    choices: [{ name: '라펠홀 없음' }, { name: '페이크라펠홀' }, { name: '리얼라펠홀' }],
  },
  {
    code: 'STITCH',
    name: '스티치 디자인',
    choices: [{ name: '스티치', extraPrice: 33000 }, { name: '스티치 없음' }],
  },
  {
    code: 'LINING',
    name: '안감 디자인',
    choices: [
      { name: '전체안감' },
      { name: '반안감' },
      { name: '언컨스트럭티드', extraPrice: 77000 },
    ],
  },
  {
    code: 'TROUSER_PLEAT',
    name: '바지 디자인',
    choices: [{ name: '노턱' }, { name: '원턱' }, { name: '투턱' }],
  },
  {
    code: 'TROUSER_HEM',
    name: '바지 밑단 디자인',
    choices: [{ name: '기본' }, { name: '카브라(턴업)' }],
  },
  {
    code: 'TROUSER_WAIST',
    name: '바지 허리 디자인',
    choices: [{ name: '벨트고리' }, { name: '사이드어드저스트' }],
  },
];

const CODES = ['A', 'B', 'C'] as const;

function storageRoot(): string {
  return resolve(process.env.FILE_STORAGE_PATH ?? './storage');
}

/**
 * 자산 파일을 저장소로 복사하고 files 레코드를 만든다.
 * originalName으로 기존 레코드를 재사용해 재실행 시 파일이 불어나지 않게 한다.
 */
async function ensureFile(stageCode: string, slot: string): Promise<string> {
  const source = join(ASSET_DIR, `${stageCode}_${slot}.jpg`);
  if (!existsSync(source))
    throw new Error(
      `선택지 이미지가 없습니다: ${source}\n` +
        'assets/extract-suit-design-images.py를 먼저 실행하세요.',
    );

  const buffer = readFileSync(source);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const originalName = `suit-design_${stageCode}_${slot}.jpg`;

  const existing = await prisma.file.findFirst({ where: { originalName } });
  if (existing) {
    // 이미지가 바뀌었을 수 있으니 저장소 파일과 메타는 갱신한다.
    const absolute = join(storageRoot(), existing.storageKey);
    mkdirSync(dirname(absolute), { recursive: true });
    copyFileSync(source, absolute);
    await prisma.file.update({
      where: { id: existing.id },
      data: { sizeBytes: BigInt(buffer.length), checksumSha256: checksum },
    });
    return existing.id;
  }

  const id = randomUUID();
  const storageKey = `option-choices/suit-design/${id}.jpg`;
  const absolute = join(storageRoot(), storageKey);
  mkdirSync(dirname(absolute), { recursive: true });
  copyFileSync(source, absolute);
  await prisma.file.create({
    data: {
      id,
      storageKey,
      originalName,
      mimeType: 'image/jpeg',
      sizeBytes: BigInt(buffer.length),
      checksumSha256: checksum,
    },
  });
  return id;
}

async function main(): Promise<void> {
  const set = await prisma.optionSet.findUnique({ where: { productCategory: 'SUIT' } });
  if (!set) throw new Error('정장 옵션 세트가 없습니다. 기본 시드를 먼저 실행하세요.');

  if (set.activeVersionId && process.env.SUIT_DESIGN_FORCE !== '1') {
    const active = await prisma.optionSetVersion.findUnique({
      where: { id: set.activeVersionId },
      select: { versionNo: true, description: true },
    });
    if (active?.description === MARKER) {
      console.log(
        `이미 V${active.versionNo}로 반영돼 있습니다. 다시 만들려면 SUIT_DESIGN_FORCE=1로 실행하세요.`,
      );
      return;
    }
  }

  const author = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!author) throw new Error('사용자가 없습니다. 기본 시드를 먼저 실행하세요.');

  // 이미지 먼저 확보 — 중간에 실패해도 버전이 반쯤 만들어지지 않게 한다.
  const imageIds = new Map<string, string>();
  for (const stage of STAGES) {
    for (const [i, choice] of stage.choices.entries()) {
      const slot = choice.imageSlot ?? CODES[i];
      imageIds.set(`${stage.code}_${CODES[i]}`, await ensureFile(stage.code, slot));
    }
  }

  const last = await prisma.optionSetVersion.aggregate({
    where: { optionSetId: set.id },
    _max: { versionNo: true },
  });
  const versionNo = (last._max.versionNo ?? 0) + 1;

  await prisma.$transaction(async (tx) => {
    const version = await tx.optionSetVersion.create({
      data: {
        id: randomUUID(),
        optionSetId: set.id,
        versionNo,
        status: 'DRAFT',
        description: MARKER,
        createdBy: author.id,
      },
    });

    for (const [index, stage] of STAGES.entries()) {
      await tx.optionStage.create({
        data: {
          id: randomUUID(),
          optionSetVersionId: version.id,
          stageCode: stage.code,
          stageName: stage.name,
          sequenceNo: index + 1,
          required: true,
          active: true,
          choices: {
            create: stage.choices.map((choice, i) => ({
              id: randomUUID(),
              choiceCode: CODES[i],
              choiceName: choice.name,
              extraPrice: choice.extraPrice ?? 0,
              imageFileId: imageIds.get(`${stage.code}_${CODES[i]}`)!,
              active: true,
            })),
          },
        },
      });
    }

    // 활성화: 기존 ACTIVE는 RETIRED로 내리고 이 버전을 세트의 활성 버전으로 건다.
    await tx.optionSetVersion.updateMany({
      where: { optionSetId: set.id, status: 'ACTIVE' },
      data: { status: 'RETIRED' },
    });
    await tx.optionSetVersion.update({
      where: { id: version.id },
      data: { status: 'ACTIVE', effectiveFrom: new Date() },
    });
    await tx.optionSet.update({
      where: { id: set.id },
      data: { activeVersionId: version.id },
    });
  });

  const choiceCount = STAGES.reduce((sum, s) => sum + s.choices.length, 0);
  const priced = STAGES.flatMap((s) => s.choices).filter((c) => c.extraPrice);
  console.log(`정장 옵션 V${versionNo} 활성화 — ${STAGES.length}단계 / ${choiceCount}선택지`);
  console.log(
    `추가금액 선택지 ${priced.length}건: ${priced
      .map((c) => `${c.name} +${c.extraPrice!.toLocaleString()}원`)
      .join(', ')}`,
  );
}

main()
  .catch((error) => {
    console.error('정장 디자인 옵션 시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
