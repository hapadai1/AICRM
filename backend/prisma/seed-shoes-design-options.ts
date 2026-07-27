/**
 * 구두 옵션 세트를 '스타일 1단계'로 맞춘다.
 *
 * 구두는 정장·셔츠처럼 부위별로 고르는 게 아니라 완성된 스타일 하나를 고른다.
 * 그래서 단계를 나누지 않고 **한 단계(구두 스타일)에 스타일 전부를 선택지로** 넣는다.
 * 화면(OptionStagePage)이 한 단계의 선택지를 그리드로 한 번에 뿌리므로,
 * 이 구성이 그대로 "스타일을 한 번에 보여주고 하나를 고른다"가 된다.
 *
 * 스타일 목록·사진은 docs/data/구두/*(사진 한 장 = 스타일 하나, 파일명이 곧 스타일명)에서 온다.
 * 원본이 6~10MB짜리 촬영본이라 assets/extract-shoes-design-images.py로 줄여 둔
 * prisma/assets/shoes-design/*.jpg 를 읽는다. 사진이 바뀔 때만 그 스크립트를 다시 돌린다.
 *
 * 정장(seed-suit-design-options.ts)·셔츠와 같은 방식으로 **첫 버전(V1)을 제자리 갱신**한다.
 * 버전을 올리면 이미 만들어진 선택 세션이 옛 버전을 계속 참조해 화면에 옛 단계·사진이
 * 남고, 세션마다 어느 버전을 보는지 갈려 데이터가 어긋난다. 단계·선택지 행을 지우지 않고
 * 내용만 바꾸면 기존 선택값의 참조가 그대로 살아 있어 그런 문제가 생기지 않는다.
 *
 * - 예전 구성(토 스타일·가죽·아웃솔 3단계)의 2·3단계는 지운다 — 구두는 한 단계짜리 세트다.
 * - 스타일이 26종을 넘어 선택지 코드는 A~Z 다음 AA~ 를 쓴다(option_choices.choice_code VARCHAR(2)).
 * - 스타일별 추가금액은 아직 받은 값이 없어 전부 0이다. 단가가 정해지면 EXTRA_PRICE에 적는다.
 * - V1 말고 다른 버전이 남아 있으면 그 세션들을 V1으로 옮기고 버전을 정리한다.
 * - 실행: npm run seed:shoes-design
 */
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';

const prisma = new PrismaClient();

/** 이 스크립트가 만든 버전임을 알아보는 표식 */
const MARKER = '스타일 1단계 구두 옵션';
const ASSET_DIR = resolve(__dirname, 'assets/shoes-design');

const STAGE_CODE = 'SHOE_STYLE';
const STAGE_NAME = '스타일';

/** 스타일별 추가금액(원). 여기 없는 스타일은 0. */
const EXTRA_PRICE: Record<string, number> = {};

/** 선택지 코드 — A~Z 다음 AA~AN (백엔드 src/modules/options/choice-codes.ts와 같은 목록) */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const CODES = [...LETTERS, ...LETTERS.slice(0, 14).map((c) => `A${c}`)];

/** 자산 폴더의 사진 = 스타일. 파일명(확장자 제외)이 스타일명이고, 가나다순이 화면 순서다. */
function loadStyles(): string[] {
  if (!existsSync(ASSET_DIR))
    throw new Error(
      `구두 스타일 사진이 없습니다: ${ASSET_DIR}\n` +
        'python3 prisma/assets/extract-shoes-design-images.py 를 먼저 실행하세요.',
    );
  const styles = readdirSync(ASSET_DIR)
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => f.slice(0, -4))
    .sort((a, b) => a.localeCompare(b, 'ko'));
  if (styles.length === 0) throw new Error(`구두 스타일 사진이 없습니다: ${ASSET_DIR}`);
  if (styles.length > CODES.length)
    throw new Error(`스타일이 ${styles.length}종이라 선택지 코드(${CODES.length}개)가 모자랍니다.`);
  return styles;
}

function storageRoot(): string {
  return resolve(process.env.FILE_STORAGE_PATH ?? './storage');
}

/**
 * 스타일 사진을 저장소로 복사하고 files 레코드를 만든다.
 * originalName으로 기존 레코드를 재사용해 재실행 시 파일이 불어나지 않게 한다.
 */
async function ensureImage(style: string): Promise<string> {
  const source = join(ASSET_DIR, `${style}.jpg`);
  const buffer = readFileSync(source);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const originalName = `shoes-design_${style}.jpg`;

  const existing = await prisma.file.findFirst({ where: { originalName } });
  if (existing) {
    // 사진이 바뀌었을 수 있으니 저장소 파일과 메타는 갱신한다.
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
  const storageKey = `option-choices/shoes-design/${id}.jpg`;
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
  const styles = loadStyles();

  const set = await prisma.optionSet.findUnique({ where: { productCategory: 'SHOES' } });
  if (!set) throw new Error('구두 옵션 세트가 없습니다. 기본 시드를 먼저 실행하세요.');

  const author = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!author) throw new Error('사용자가 없습니다. 기본 시드를 먼저 실행하세요.');

  // 사진을 먼저 확보한다 — 중간에 실패해도 옵션이 반쯤 바뀌지 않게.
  const imageIds = new Map<string, string>();
  for (const style of styles) imageIds.set(style, await ensureImage(style));

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
    // 그래서 임시 코드로 비워둔 뒤 최종 코드를 넣는다.
    for (const stage of existing) {
      await tx.optionStage.update({
        where: { id: stage.id },
        data: { stageCode: `TMP_${stage.sequenceNo}_${stage.id.slice(0, 8)}` },
      });
    }

    let stage = existing.find((s) => s.sequenceNo === 1);
    if (!stage) {
      const created = await tx.optionStage.create({
        data: {
          id: randomUUID(),
          optionSetVersionId: baseId,
          stageCode: STAGE_CODE,
          stageName: STAGE_NAME,
          sequenceNo: 1,
          required: true,
          active: true,
        },
      });
      stage = { ...created, choices: [] };
    } else {
      await tx.optionStage.update({
        where: { id: stage.id },
        data: { stageCode: STAGE_CODE, stageName: STAGE_NAME, required: true, active: true },
      });
    }

    for (const [i, style] of styles.entries()) {
      const code = CODES[i];
      const imageFileId = imageIds.get(style)!;
      const extraPrice = EXTRA_PRICE[style] ?? 0;
      const current = stage.choices.find((c) => c.choiceCode === code);
      if (current) {
        // 행을 지우지 않고 내용만 바꾼다 — 기존 선택값이 이 행을 가리키고 있다.
        await tx.optionChoice.update({
          where: { id: current.id },
          data: {
            choiceName: style,
            // 공장 표기도 스타일명 그대로다(예전 구성에서 남은 값이 있으면 덮는다).
            factoryLabel: style,
            extraPrice,
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
            choiceName: style,
            factoryLabel: style,
            extraPrice,
            imageFileId,
            active: true,
          },
        });
      }
    }

    // 새 구성에 없는 선택지는 지우지 않고 내린다(선택값이 참조 중일 수 있다).
    const liveCodes = new Set(CODES.slice(0, styles.length));
    for (const c of stage.choices) {
      if (!liveCodes.has(c.choiceCode))
        await tx.optionChoice.update({ where: { id: c.id }, data: { active: false } });
    }

    // 예전 구성의 2·3단계(가죽·아웃솔)는 지운다.
    // 비활성으로 내려두면 화면에는 안 나와도 관리자 옵션 표와 '단계 수'에는 계속 3단계로 남는다.
    // 구두는 스타일 한 단계짜리 세트이므로 흔적을 남기지 않는다(그 단계의 옛 선택값도 함께 지운다).
    const stale = existing.filter((s) => s.sequenceNo > 1).map((s) => s.id);
    if (stale.length > 0) {
      await tx.optionSelectionValue.deleteMany({ where: { optionStageId: { in: stale } } });
      await tx.optionSelectionSession.updateMany({
        where: { currentStageId: { in: stale } },
        data: { currentStageId: stage.id },
      });
      await tx.optionChoice.deleteMany({ where: { optionStageId: { in: stale } } });
      await tx.optionStage.deleteMany({ where: { id: { in: stale } } });
    }

    await tx.optionSetVersion.update({
      where: { id: baseId },
      data: { status: 'ACTIVE', description: MARKER, effectiveFrom: new Date() },
    });
    await tx.optionSet.update({ where: { id: set.id }, data: { activeVersionId: baseId } });
  });

  const moved = await consolidateOtherVersions(set.id, baseId);

  console.log(`구두 옵션 V${base.versionNo} 갱신 — 1단계(${STAGE_NAME}) / ${styles.length}스타일`);
  console.log(`  ${styles.join(' · ')}`);
  if (moved.sessions > 0 || moved.versions > 0)
    console.log(`다른 버전 정리 — 세션 ${moved.sessions}건 이전, 버전 ${moved.versions}개 삭제`);
}

/**
 * 기준 버전 외의 버전에 붙은 세션을 기준 버전으로 옮기고 그 버전을 지운다.
 * 단계는 순번으로, 선택지는 코드로 짝지어 선택값을 그대로 살린다.
 * 짝이 없으면(예전 3단계 구성의 2·3단계 선택값) 그 선택값만 버린다.
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
    console.error('구두 스타일 옵션 시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
