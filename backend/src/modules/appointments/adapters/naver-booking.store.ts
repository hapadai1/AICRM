import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  mapNaverBizItems,
  mapNaverBookings,
  MapResult,
  NaverBizItemRaw,
  NaverBookingRaw,
} from './naver-booking.mapper';
import { NaverBizItem } from './naver-reservation.adapter';

/**
 * 네이버 수집본 파일 저장소.
 *
 * 스크래핑은 주기 수집·명시적 적재 때만 하고, 그 결과를 파일로 남겨 나머지(동기화 버튼·충돌 해소·점검)는
 * 이 파일을 쓴다. 원본(raw)과 파싱 결과(records)를 함께 저장하되, 읽을 때는 원본을 다시 파싱한다 —
 * 파싱 규칙을 고쳐도 네이버에 다시 접속하지 않고 저장본에 바로 반영되게 하기 위함이다.
 *
 * 파일: latest.json(최신본) + history/<시각>.json(최근 N개). 개인정보가 들어 있어 커밋 제외 폴더에 둔다.
 */
export interface StoredNaverFetch {
  /** 네이버에서 받아 온 시각 (ISO-8601) */
  fetchedAt: string;
  /** 조회한 한국 날짜 구간 (포함) */
  from: string;
  to: string;
  count: number;
  /** 저장 당시 파싱 결과 — 사람이 파일을 열어 볼 때 읽기 쉽게 둔다 */
  records: MapResult['records'];
  unmappedBizItems: string[];
  /** 매핑 규칙에 없던 네이버 상태 코드 (예약 대기로 넣었다) — 옛 저장본에는 없다 */
  unknownStatusCodes?: string[];
  skipped: MapResult['skipped'];
  /** 네이버 응답 원본 */
  raw: NaverBookingRaw[];
  /**
   * 예약 상품(메뉴) 마스터 원본 — 예약 0건 상품도 화면 선택지에 띄우기 위해 함께 저장한다.
   * 상품 응답을 못 잡은 수집에서는 직전 저장본의 값을 물려받는다 (선택지가 사라지지 않게).
   */
  bizItemsRaw?: NaverBizItemRaw[];
  /** 저장 당시 파싱 결과 — 사람이 파일을 열어 볼 때 읽기 쉽게 둔다 */
  bizItems?: NaverBizItem[];
}

export type LoadedNaverFetch = StoredNaverFetch & {
  parsed: MapResult;
  /** 원본을 다시 파싱한 상품 목록 (파싱 규칙을 고쳐도 재수집 없이 반영된다) */
  parsedBizItems: NaverBizItem[];
};

export class NaverBookingStore {
  constructor(
    private readonly dir: string,
    /** 보관할 과거 수집본 개수 — 하루 서너 번 수집 기준으로 열흘 남짓 */
    private readonly keepHistory = 30,
  ) {}

  private get latestPath(): string {
    return join(this.dir, 'latest.json');
  }

  async save(input: {
    fetchedAt: Date;
    from: string;
    to: string;
    raw: NaverBookingRaw[];
    bizItemsRaw?: NaverBizItemRaw[];
  }): Promise<StoredNaverFetch> {
    const parsed = mapNaverBookings(input.raw);
    // 이번 수집이 상품 응답을 놓쳤으면 직전 저장본의 상품 목록을 이어 쓴다
    const bizItemsRaw = input.bizItemsRaw?.length
      ? input.bizItemsRaw
      : (await this.latest())?.bizItemsRaw ?? [];
    const stored: StoredNaverFetch = {
      fetchedAt: input.fetchedAt.toISOString(),
      from: input.from,
      to: input.to,
      count: input.raw.length,
      records: parsed.records,
      unmappedBizItems: parsed.unmappedBizItems,
      unknownStatusCodes: parsed.unknownStatusCodes,
      skipped: parsed.skipped,
      raw: input.raw,
      bizItemsRaw,
      bizItems: mapNaverBizItems(bizItemsRaw),
    };
    const body = JSON.stringify(stored, null, 2);
    const historyDir = join(this.dir, 'history');
    await mkdir(historyDir, { recursive: true });

    const stamp = stored.fetchedAt.replace(/[:.]/g, '-').slice(0, 19);
    await writeFile(join(historyDir, `${stamp}.json`), body);
    // 읽는 쪽이 반쯤 쓰인 파일을 보지 않도록 임시 파일에 쓴 뒤 바꿔 끼운다
    const tmp = `${this.latestPath}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, this.latestPath);

    await this.pruneHistory(historyDir);
    return stored;
  }

  /** 최신 수집본. 없거나 깨졌으면 null. 원본을 다시 파싱해 parsed 로 붙인다. */
  async latest(): Promise<LoadedNaverFetch | null> {
    let text: string;
    try {
      text = await readFile(this.latestPath, 'utf8');
    } catch {
      return null;
    }
    try {
      const stored = JSON.parse(text) as StoredNaverFetch;
      if (!stored.fetchedAt || !Array.isArray(stored.raw)) return null;
      return {
        ...stored,
        parsed: mapNaverBookings(stored.raw),
        parsedBizItems: mapNaverBizItems(stored.bizItemsRaw ?? []),
      };
    } catch {
      return null;
    }
  }

  private async pruneHistory(historyDir: string): Promise<void> {
    const files = (await readdir(historyDir)).filter((f) => f.endsWith('.json')).sort();
    const excess = files.slice(0, Math.max(0, files.length - this.keepHistory));
    for (const f of excess) await rm(join(historyDir, f), { force: true });
  }
}
