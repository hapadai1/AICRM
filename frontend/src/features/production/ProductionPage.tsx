/** PROD-001 계약별 제작 관리 목록 — 고객명·전화로 식별, 행 클릭 시 계약 제작 관리 화면으로 진입 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Progress, Segmented, Space, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchProductionItems, type ProductionItem } from '../../api/production';
import { LAYOUT } from '../../app/theme';
import { DataTable } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { COL } from '../../shared/table-width';
import { ItemCompositionCell } from '../contracts/ItemCompositionCell';
import { DdayTag, summarizeContract, type ContractSummary } from './production-summary';

/** 목록 한 행 = 계약 하나. 요약 계산은 상세 화면과 공유한다(production-summary). */
interface ContractRow extends ContractSummary {
  contractId: string;
  contractNo: string;
  /** 계약 구분 이름 — 계약 목록의 같은 열. 계약에 구분이 없으면 null */
  contractTypeName: string | null;
  customerName: string;
  customerPhone: string;
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
      contractTypeName: list[0].contractTypeName,
      customerName: list[0].customerName,
      customerPhone: list[0].customerPhone,
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
            {r.customerPhone || '-'}
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
      title: '건수',
      dataIndex: 'itemCount',
      key: 'itemCount',
      width: COL.count,
      align: 'center',
    },
    {
      title: '완성 예정일',
      dataIndex: 'dueDate',
      key: 'dueDate',
      width: COL.name,
      render: (v: string | null) => v ?? <Typography.Text type="secondary">미정</Typography.Text>,
    },
    {
      title: 'D-day',
      key: 'dday',
      width: COL.count,
      render: (_, r) => (r.dueDate ? <DdayTag due={r.dueDate} /> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '제작 진행률',
      key: 'progress',
      width: COL.wide,
      render: (_, r) => <Progress percent={r.progressPct} size="small" style={{ minWidth: 120 }} />,
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
