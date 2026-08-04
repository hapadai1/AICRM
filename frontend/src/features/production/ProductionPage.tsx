/** PROD-001 계약별 제작 관리 목록 — 고객명·전화로 식별, 행 클릭 시 계약 제작 관리 화면으로 진입 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Progress, Space, Typography } from 'antd';
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

  const itemsQuery = useQuery({ queryKey: ['production', 'items'], queryFn: () => fetchProductionItems() });

  const rows = useMemo(() => {
    const grouped = groupByContract(itemsQuery.data ?? []);
    const q = keyword.trim().toLowerCase();
    if (!q) return grouped;
    return grouped.filter((r) =>
      [r.customerName, r.customerPhone, r.contractNo].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [itemsQuery.data, keyword]);

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
              <Input.Search
                allowClear
                style={{ width: LAYOUT.searchWidth }}
                placeholder="고객명 · 전화번호 검색"
                defaultValue={keyword}
                onSearch={(v) => {
                  const next = new URLSearchParams(searchParams);
                  if (v.trim()) next.set('q', v.trim());
                  else next.delete('q');
                  setSearchParams(next, { replace: true });
                }}
              />
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
