/** PROD-001 계약별 제작 관리 목록 — 고객명·전화로 식별, 행 클릭 시 계약 제작 관리 화면으로 진입 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Segmented, Space, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchProductionItems, type ProductionItem } from '../../api/production';
import { LAYOUT } from '../../app/theme';
import { DataTable } from '../../shared/DataTable';
import { formatPhone } from '../../shared/phone';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { COL } from '../../shared/table-width';
import { ItemCompositionCell } from '../contracts/ItemCompositionCell';
import { DdayTag, summarizeContract, type ContractSummary } from './production-summary';
import {
  contractProductionStages,
  contractTrackProgress,
  type ContractProductionStages,
  type ContractTrackProgress,
} from './production-stages';
import { StatusBadge } from '../../shared/StatusBadge';
import { TrackProgressBars } from './TrackProgressBars';

/** 목록 한 행 = 계약 하나. 요약 계산은 상세 화면과 공유한다(production-summary). */
interface ContractRow extends ContractSummary {
  contractId: string;
  contractNo: string;
  /** 계약일 (YYYY-MM-DD) — 계약 확정일, 없으면 생성일. 없으면 빈 문자열 */
  contractDate: string;
  /** 계약 구분 이름 — 계약 목록의 같은 열. 계약에 구분이 없으면 null */
  contractTypeName: string | null;
  customerName: string;
  customerPhone: string;
  /** 맞춤/렌탈 상태 — 상세 화면 흐름의 현재 단계(품목 상태에서 유도). 트랙별로 나눈다. */
  productionStages: ContractProductionStages;
  /** 맞춤/렌탈 진행률 — 상세 흐름 카드와 같은 단계 기반. 트랙별로 나눈다. */
  trackProgress: ContractTrackProgress;
}

type StateFilter = 'ALL' | 'ONGOING' | 'DONE';

/**
 * 계약 하나가 제작을 끝냈는가 — 취소분을 뺀 품목이 전부 출고까지 갔을 때만 완료다
 * (컨설팅·채촌 목록의 완료/미완료와 같은 규격, 현업 확정 2026-08-04).
 * 남은 품목이 없는(전부 취소된) 계약은 끝낸 것이 아니라 할 일이 없는 것이라 완료로 세지 않는다.
 */
function productionDone(r: ContractSummary): boolean {
  const active = r.itemCount - r.cancelledCount;
  return active > 0 && r.releasedCount === active;
}

function groupByContract(items: ProductionItem[]): ContractRow[] {
  const byContract = new Map<string, ProductionItem[]>();
  for (const it of items) {
    const list = byContract.get(it.contractId) ?? [];
    list.push(it);
    byContract.set(it.contractId, list);
  }
  return [...byContract.values()]
    .map((list) => ({
      contractId: list[0].contractId,
      contractNo: list[0].contractNo,
      contractDate: list[0].contractDate ?? '',
      contractTypeName: list[0].contractTypeName,
      customerName: list[0].customerName,
      customerPhone: list[0].customerPhone,
      productionStages: contractProductionStages(list),
      trackProgress: contractTrackProgress(list),
      ...summarizeContract(list),
    }))
    .sort((a, b) => b.contractNo.localeCompare(a.contractNo));
}

export function ProductionPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = searchParams.get('q') ?? '';
  // 기본은 전체 — 상태로 가리지 않고 다 보여 준다. 전체는 URL에 남기지 않는다(없는 것과 같은 뜻).
  const state = (searchParams.get('state') as StateFilter | null) ?? 'ALL';

  const itemsQuery = useQuery({ queryKey: ['production', 'items'], queryFn: () => fetchProductionItems() });

  const rows = useMemo(() => {
    let grouped = groupByContract(itemsQuery.data ?? []);
    const q = keyword.trim().toLowerCase();
    if (q) {
      grouped = grouped.filter((r) =>
        [r.customerName, r.customerPhone, r.contractNo].some((v) => v?.toLowerCase().includes(q)),
      );
    }
    if (state === 'DONE') grouped = grouped.filter(productionDone);
    if (state === 'ONGOING') grouped = grouped.filter((r) => !productionDone(r));
    return grouped;
  }, [itemsQuery.data, keyword, state]);

  /** URL 쿼리 갱신 — 값이 비면 키를 지운다 */
  const setParams = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSearchParams(next, { replace: true });
  };

  const columns: ColumnsType<ContractRow> = [
    {
      // 고객명·전화번호를 한 칸에 겹쳐 쓴다 — 계약 목록·스타일 컨설팅 목록과 같은 규격.
      title: '고객',
      key: 'customer',
      width: COL.name,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong ellipsis>
            {r.customerName}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatPhone(r.customerPhone)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      // 계약번호는 참고용이라 자기 열을 주지 않고 계약 구분 아래에 붙인다(계약 목록과 동일).
      title: '계약 구분',
      key: 'contractType',
      width: COL.code,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text ellipsis>{r.contractTypeName ?? '-'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.contractNo}
          </Typography.Text>
        </Space>
      ),
    },
    {
      // 계약 목록·스타일 컨설팅 목록과 같은 규칙: 렌탈이 섞인 계약만 맞춤/렌탈 두 줄로 나눠 쓰고,
      // 맞춤뿐이면 태그 없이 한 줄로 둔다.
      title: '품목 구성',
      key: 'composition',
      width: COL.wide,
      ellipsis: true,
      render: (_, r) => (
        <ItemCompositionCell customCounts={r.customCounts} rentalCounts={r.rentalCounts} />
      ),
    },
    {
      title: '계약일',
      dataIndex: 'contractDate',
      key: 'contractDate',
      width: COL.name,
      // 기본 정렬: 계약일 최신순(최근 계약이 위). 헤더 클릭으로 오름/내림 전환한다.
      // contractDate는 'YYYY-MM-DD' 문자열이라 사전순 비교가 곧 날짜순이다. 없으면(빈 문자열) 뒤로.
      sorter: (a, b) => (a.contractDate || '0').localeCompare(b.contractDate || '0'),
      defaultSortOrder: 'descend',
      render: (v: string) => v || <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '완료 예정일',
      dataIndex: 'dueDate',
      key: 'dueDate',
      width: COL.name,
      // 완료 예정일로도 정렬 가능. 미정(null)은 정렬 방향과 무관하게 뒤로 가도록 먼 미래로 취급한다.
      sorter: (a, b) => (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99'),
      render: (v: string | null) => v ?? <Typography.Text type="secondary">미정</Typography.Text>,
    },
    {
      title: 'D-day',
      key: 'dday',
      width: COL.count,
      render: (_, r) => (r.dueDate ? <DdayTag due={r.dueDate} /> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      // 상세 화면 흐름의 현재 단계를 스타일 컨설팅과 같은 상태 배지로 보여 준다(진행률 앞).
      // 맞춤·렌탈이 함께 도는 계약은 트랙마다 나눠 두 줄로 적는다.
      title: '제작 관리 상태',
      key: 'productionStages',
      width: COL.status,
      render: (_, r) => {
        const { custom, rental } = r.productionStages;
        // 색은 원래 상태로 판정한다 — 트랙 접두사(맞춤·/렌탈·)가 붙어도 '완료'는 초록으로.
        const badge = (state: string, prefix?: string) => (
          <StatusBadge
            label={prefix ? `${prefix} · ${state}` : state}
            color={state === '완료' ? 'green' : 'blue'}
          />
        );
        if (custom && rental) {
          return (
            <Space direction="vertical" size={2}>
              {badge(custom, '맞춤')}
              {badge(rental, '렌탈')}
            </Space>
          );
        }
        const only = custom ?? rental;
        return only ? badge(only) : <Typography.Text type="secondary">-</Typography.Text>;
      },
    },
    {
      // 상세 흐름 카드와 같은 단계 기반 진행률 — 맞춤·렌탈이 함께 도는 계약은 트랙마다 나눠 적는다.
      title: '제작 진행률',
      key: 'progress',
      width: COL.wide,
      render: (_, r) => <TrackProgressBars progress={r.trackProgress} showLabels={false} />,
    },
  ];

  if (itemsQuery.error) {
    return (
      <Alert
        type="error"
        showIcon
        message="제작 관리 목록을 불러오지 못했습니다."
        description={(itemsQuery.error as Error).message}
      />
    );
  }

  return (
    <PageShell>
      <PageCard>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <ListToolbar
            filters={
              <>
                <Input.Search
                  allowClear
                  style={{ width: LAYOUT.searchWidth }}
                  placeholder="고객명 · 전화번호 검색"
                  defaultValue={keyword}
                  onSearch={(v) => setParams({ q: v.trim() || undefined })}
                />
                {/* 상태 — 컨설팅·채촌 목록과 같은 3칸 구성. 기본 전체. */}
                <Segmented
                  value={state}
                  onChange={(v) => setParams({ state: v === 'ALL' ? undefined : (v as string) })}
                  options={[
                    { label: '전체', value: 'ALL' },
                    { label: '진행중', value: 'ONGOING' },
                    { label: '완료', value: 'DONE' },
                  ]}
                />
              </>
            }
          />
          <DataTable<ContractRow>
            rowKey="contractId"
            loading={itemsQuery.isLoading}
            dataSource={rows}
            columns={columns}
            // 창이 넓으면 표가 오른쪽 끝까지 채우고 남는 폭을 열들이 비례 배분한다(계약 목록과 동일).
            // 열 폭 합을 직접 세어 넘겨, 열이 바뀌어도 기준이 따라온다.
            fillWidth={columns.reduce(
              (sum, c) => sum + (typeof c.width === 'number' ? c.width : 0),
              0,
            )}
            pagination={{}}
            onRow={(r) => ({
              onClick: () => navigate(`/contracts/${r.contractId}/production`),
              style: { cursor: 'pointer' },
            })}
            locale={{ emptyText: '제작 대상 품목이 있는 계약이 없습니다.' }}
          />
        </Space>
      </PageCard>
    </PageShell>
  );
}
