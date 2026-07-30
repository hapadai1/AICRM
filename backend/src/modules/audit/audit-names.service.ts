import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 감사로그 스냅샷의 UUID를 사람이 아는 이름으로 보강한다.
 *
 * 기록 시점에 이름을 함께 남기는 것이 원칙이지만(서비스 계층의 before/after),
 * 그렇지 못한 예전 로그는 "버전 2 삭제"처럼 어느 대상인지 알 수 없는 줄로 남는다.
 * 대상 행이 지워졌어도 스냅샷에 부모 식별자(option_set_id 등)는 남아 있으므로,
 * 조회 시점에 그 이름을 붙여 준다. 저장된 로그는 그대로 두고 응답만 보강한다.
 */
@Injectable()
export class AuditNamesService {
  constructor(private readonly prisma: PrismaService) {}

  /** UUID 필드 → 함께 보여줄 이름 필드. 이름 필드가 이미 있으면 덮지 않는다. */
  private readonly sources = [
    {
      idKey: 'optionSetId',
      nameKey: 'optionSetName',
      load: (ids: string[]) =>
        this.prisma.optionSet
          .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
          .then((rows) => rows.map((r) => [r.id, r.name] as const)),
    },
    {
      idKey: 'customerId',
      nameKey: 'customerName',
      load: (ids: string[]) =>
        this.prisma.customer
          .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
          .then((rows) => rows.map((r) => [r.id, r.name] as const)),
    },
    {
      idKey: 'contractId',
      nameKey: 'contractNo',
      load: (ids: string[]) =>
        this.prisma.contract
          .findMany({ where: { id: { in: ids } }, select: { id: true, contractNo: true } })
          .then((rows) => rows.map((r) => [r.id, r.contractNo] as const)),
    },
    {
      idKey: 'rentalInventoryItemId',
      nameKey: 'managementCode',
      load: (ids: string[]) =>
        this.prisma.rentalInventoryItem
          .findMany({ where: { id: { in: ids } }, select: { id: true, managementCode: true } })
          .then((rows) => rows.map((r) => [r.id, r.managementCode] as const)),
    },
  ];

  /** 로그 목록의 before/after JSON에 이름 필드를 채워 돌려준다. 조회 실패는 무시한다(로그는 그대로 보여준다). */
  async attach<T extends { beforeJson: unknown; afterJson: unknown }>(rows: T[]): Promise<T[]> {
    const snapshots = rows.flatMap((row) =>
      [row.beforeJson, row.afterJson].filter(
        (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v),
      ),
    );
    if (snapshots.length === 0) return rows;

    await Promise.all(
      this.sources.map(async (source) => {
        const targets = snapshots.filter(
          (s) => typeof s[source.idKey] === 'string' && s[source.nameKey] === undefined,
        );
        const ids = Array.from(new Set(targets.map((s) => s[source.idKey] as string)));
        if (ids.length === 0) return;
        try {
          const names = new Map(await source.load(ids));
          for (const snapshot of targets) {
            const name = names.get(snapshot[source.idKey] as string);
            if (name) snapshot[source.nameKey] = name;
          }
        } catch {
          // 이름 보강은 부가 정보다 — 실패해도 감사로그 조회 자체는 막지 않는다.
        }
      }),
    );
    return rows;
  }
}
