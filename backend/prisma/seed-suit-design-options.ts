/**
 * 정장 옵션 세트를 '디자인 상담' 자료 기준 11단계·29선택지로 맞춘다.
 *
 * 버전을 새로 올리지 않고 **첫 버전(V1)을 제자리 갱신**한다.
 * 버전을 올리면 이미 만들어진 선택 세션이 옛 버전을 계속 참조해 화면에 옛 단계·사진이
 * 남고, 세션마다 어느 버전을 보는지 갈려 데이터가 어긋난다. 단계·선택지 행을 지우지 않고
 * 내용만 바꾸면 기존 선택값의 참조가 그대로 살아 있어 그런 문제가 생기지 않는다.
 *
 * - 선택지 사진은 prisma/assets/suit-design/*.jpg (PDF에서 추출한 원본).
 *   추출은 assets/extract-suit-design-images.py가 담당하며 PDF가 바뀔 때만 다시 돌린다.
 * - V1 말고 다른 버전이 남아 있으면 그 세션들을 V1으로 옮기고 버전을 정리한다.
 * - 실행: npm run seed:suit-design
 *         SUIT_DESIGN_IMAGES_ONLY=1 npm run seed:suit-design  (사진만 갱신)
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

  // 사진만 갱신: 자산을 다시 뽑았을 때 버전을 새로 만들지 않고 파일 내용만 바꾼다.
  // files 레코드를 originalName으로 재사용하므로 이미 연결된 선택지가 그대로 새 사진을 가리킨다.
  if (process.env.SUIT_DESIGN_IMAGES_ONLY === '1') {
    let n = 0;
    for (const stage of STAGES) {
      for (const [i, choice] of stage.choices.entries()) {
        await ensureFile(stage.code, choice.imageSlot ?? CODES[i]);
        n += 1;
      }
    }
    console.log(`선택지 사진 ${n}건을 갱신했습니다. (버전은 그대로)`);
    return;
  }

  const author = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!author) throw new Error('사용자가 없습니다. 기본 시드를 먼저 실행하세요.');

  // 사진을 먼저 확보한다 — 중간에 실패해도 옵션이 반쯤 바뀌지 않게.
  const imageIds = new Map<string, string>();
  for (const stage of STAGES) {
    for (const [i, choice] of stage.choices.entries()) {
      imageIds.set(`${stage.code}_${CODES[i]}`, await ensureFile(stage.code, choice.imageSlot ?? CODES[i]));
    }
  }

  // 기준 버전 = 이 세트의 첫 버전. 없으면 만든다.
  let base = await prisma.optionSetVersion.findFirst({
    where: { optionSetId: set.id },
    orderBy: { versionNo: 'asc' },
  });
  if (!base) {
    base = await prisma.optionSetVersion.create({
      data: {
        id: randomUUID(),
        optionSetId: set.id,
        versionNo: 1,
        status: 'DRAFT',
        description: MARKER,
        createdBy: author.id,
      },
    });
  }
  const baseId = base.id;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.optionStage.findMany({
      where: { optionSetVersionId: baseId },
      orderBy: { sequenceNo: 'asc' },
      include: { choices: true },
    });

    // 단계코드를 한 번에 바꾸면 (버전, 코드) 유일 제약에 걸린다.
    // 예전 6단계가 VENT인데 새 4단계도 VENT라 순서대로 갱신하면 중간에 충돌한다.
    // 그래서 임시 코드로 비워둔 뒤 최종 코드를 넣는다.
    for (const stage of existing) {
      await tx.optionStage.update({
        where: { id: stage.id },
        data: { stageCode: `TMP_${stage.sequenceNo}_${stage.id.slice(0, 8)}` },
      });
    }

    for (const [index, seed] of STAGES.entries()) {
      const sequenceNo = index + 1;
      let stage = existing.find((s) => s.sequenceNo === sequenceNo);

      if (!stage) {
        const created = await tx.optionStage.create({
          data: {
            id: randomUUID(),
            optionSetVersionId: baseId,
            stageCode: seed.code,
            stageName: seed.name,
            sequenceNo,
            required: true,
            active: true,
          },
        });
        stage = { ...created, choices: [] };
      } else {
        await tx.optionStage.update({
          where: { id: stage.id },
          data: { stageCode: seed.code, stageName: seed.name, required: true, active: true },
        });
      }

      for (const [i, choice] of seed.choices.entries()) {
        const code = CODES[i];
        const imageFileId = imageIds.get(`${seed.code}_${code}`)!;
        const current = stage.choices.find((c) => c.choiceCode === code);
        if (current) {
          // 행을 지우지 않고 내용만 바꾼다 — 기존 선택값이 이 행을 가리키고 있다.
          await tx.optionChoice.update({
            where: { id: current.id },
            data: {
              choiceName: choice.name,
              extraPrice: choice.extraPrice ?? 0,
              imageFileId,
              active: true,
            },
          });
        } else {
          await tx.optionChoice.create({
            data: {
              id: randomUUID(),
              optionStageId: stage.id,
              choiceCode: code,
              choiceName: choice.name,
              extraPrice: choice.extraPrice ?? 0,
              imageFileId,
              active: true,
            },
          });
        }
      }

      // 새 구성에 없는 선택지는 지우지 않고 내린다(선택값이 참조 중일 수 있다).
      for (const c of stage.choices) {
        if (!CODES.slice(0, seed.choices.length).includes(c.choiceCode as (typeof CODES)[number])) {
          await tx.optionChoice.update({ where: { id: c.id }, data: { active: false } });
        }
      }
    }

    // 11단계를 넘는 예전 단계도 지우지 않고 내린다.
    for (const stage of existing) {
      if (stage.sequenceNo > STAGES.length) {
        await tx.optionStage.update({
          where: { id: stage.id },
          data: { stageCode: `RETIRED_${stage.sequenceNo}`, active: false },
        });
      }
    }

    await tx.optionSetVersion.update({
      where: { id: baseId },
      data: { status: 'ACTIVE', description: MARKER, effectiveFrom: new Date() },
    });
    await tx.optionSet.update({ where: { id: set.id }, data: { activeVersionId: baseId } });
  });

  const moved = await consolidateOtherVersions(set.id, baseId);

  const choiceCount = STAGES.reduce((sum, s) => sum + s.choices.length, 0);
  const priced = STAGES.flatMap((s) => s.choices).filter((c) => c.extraPrice);
  console.log(`정장 옵션 V${base.versionNo} 갱신 — ${STAGES.length}단계 / ${choiceCount}선택지`);
  if (moved.sessions > 0 || moved.versions > 0)
    console.log(`다른 버전 정리 — 세션 ${moved.sessions}건 이전, 버전 ${moved.versions}개 삭제`);
  console.log(
    `추가금액 선택지 ${priced.length}건: ${priced
      .map((c) => `${c.name} +${c.extraPrice!.toLocaleString()}원`)
      .join(', ')}`,
  );
}

/**
 * 기준 버전 외의 버전에 붙은 세션을 기준 버전으로 옮기고 그 버전을 지운다.
 * 단계는 순번으로, 선택지는 코드(A/B/C)로 짝지어 선택값을 그대로 살린다.
 * 짝이 없으면(예전 버전에만 있던 선택지) 그 선택값만 버린다.
 */
async function consolidateOtherVersions(
  optionSetId: string,
  baseId: string,
): Promise<{ sessions: number; versions: number }> {
  const others = await prisma.optionSetVersion.findMany({
    where: { optionSetId, id: { not: baseId } },
    include: { stages: { include: { choices: true } } },
  });
  if (others.length === 0) return { sessions: 0, versions: 0 };

  const baseStages = await prisma.optionStage.findMany({
    where: { optionSetVersionId: baseId },
    include: { choices: true },
  });
  const baseBySeq = new Map(baseStages.map((s) => [s.sequenceNo, s]));

  let sessions = 0;
  for (const version of others) {
    const stageById = new Map(version.stages.map((s) => [s.id, s]));
    const choiceById = new Map(version.stages.flatMap((s) => s.choices).map((c) => [c.id, c]));

    const list = await prisma.optionSelectionSession.findMany({
      where: { optionSetVersionId: version.id },
      include: { values: true },
    });

    for (const session of list) {
      await prisma.$transaction(async (tx) => {
        for (const value of session.values) {
          const oldStage = stageById.get(value.optionStageId);
          const oldChoice = choiceById.get(value.optionChoiceId);
          const newStage = oldStage ? baseBySeq.get(oldStage.sequenceNo) : undefined;
          const newChoice = newStage?.choices.find((c) => c.choiceCode === oldChoice?.choiceCode);
          if (!newStage || !newChoice) {
            await tx.optionSelectionValue.delete({ where: { id: value.id } });
            continue;
          }
          await tx.optionSelectionValue.update({
            where: { id: value.id },
            data: {
              optionStageId: newStage.id,
              optionChoiceId: newChoice.id,
              extraPriceSnapshot: newChoice.extraPrice,
            },
          });
        }
        const oldCurrent = session.currentStageId ? stageById.get(session.currentStageId) : undefined;
        await tx.optionSelectionSession.update({
          where: { id: session.id },
          data: {
            optionSetVersionId: baseId,
            currentStageId: oldCurrent ? (baseBySeq.get(oldCurrent.sequenceNo)?.id ?? null) : null,
          },
        });
      });
      sessions += 1;
    }

    await prisma.$transaction(async (tx) => {
      await tx.optionChoice.deleteMany({ where: { optionStage: { optionSetVersionId: version.id } } });
      await tx.optionStage.deleteMany({ where: { optionSetVersionId: version.id } });
      await tx.optionSetVersion.delete({ where: { id: version.id } });
    });
  }
  return { sessions, versions: others.length };
}

main()
  .catch((error) => {
    console.error('정장 디자인 옵션 시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
