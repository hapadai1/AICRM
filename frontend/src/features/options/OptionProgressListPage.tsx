/** OPT-001 스타일 컨설팅 목록 — 계약 단위로 묶어 고객명·전화로 식별, 행 클릭 시 계약 스타일 컨설팅 화면으로 진입 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Input, Progress, Segmented, Space, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { OptionProgressItem, ProductCategory } from '../../api/options';
import { fetchOptionProgress } from '../../api/options';
import { PRODUCT_CATEGORY_LABEL } from '../contracts/labels';

/** 납기 D-day 태그 */
function DdayTag({ due }: { due: string }) {
  const days = dayjs(due).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (days < 0) return <Tag color="red">D+{-days} 지남</Tag>;
  if (days === 0) return <Tag color="volcano">D-day</Tag>;
  if (days <= 3) return <Tag color="orange">D-{days}</Tag>;
  return <Tag color="default">D-{days}</Tag>;
}

interface ContractRow {
  contractId: string;
  contractNo: string;
  customerName: string;
  customerPhone: string;
  /** 완성 예정일(납기) — 계약 내 가장 이른 납기 (YYYY-MM-DD). 없으면 null */
  dueDate: string | null;
  itemCount: number;
  /** 카테고리별 품목 수 (품목 구성 요약) */
  categoryCounts: Partial<Record<ProductCategory, number>>;
  confirmedCount: number;
  completedStages: number;
  totalStages: number;
}

function groupByContract(items: OptionProgressItem[]): ContractRow[] {
  const map = new Map<string, ContractRow>();
  for (const it of items) {
    const row = map.get(it.contractId) ?? {
      contractId: it.contractId,
      contractNo: it.contractNo,
      customerName: it.customerName,
      customerPhone: it.customerPhone,
      dueDate: null,
      itemCount: 0,
      categoryCounts: {},
      confirmedCount: 0,
      completedStages: 0,
      totalStages: 0,
    };
    row.itemCount += 1;
    row.categoryCounts[it.productCategory] = (row.categoryCounts[it.productCategory] ?? 0) + 1;
    if (it.status === 'CONFIRMED') row.confirmedCount += 1;
    row.completedStages += it.completedStages;
    row.totalStages += it.totalStages;
    const due = it.completionDueDate?.slice(0, 10) ?? null;
    if (due && (!row.dueDate || due < row.dueDate)) row.dueDate = due;
    map.set(it.contractId, row);
  }
  return [...map.values()].sort((a, b) => b.contractNo.localeCompare(a.contractNo));
}

/** 품목 구성 요약 — "정장 2 · 셔츠 1" */
function itemComposition(counts: Partial<Record<ProductCategory, number>>): string {
  return (Object.keys(counts) as ProductCategory[])
    .map((c) => `${PRODUCT_CATEGORY_LABEL[c]} ${counts[c]}`)
    .join(' · ');
}

export function OptionProgressListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = searchParams.get('q') ?? '';
  const [status, setStatus] = useState<'ALL' | 'INCOMPLETE' | 'COMPLETE'>('ALL');

  const { data, isLoading, error } = useQuery({
    queryKey: ['options', 'progress'],
    queryFn: () => fetchOptionProgress(),
  });

  const rows = useMemo(() => {
    let grouped = groupByContract(data ?? []);
    const q = keyword.trim().toLowerCase();
    if (q) {
      grouped = grouped.filter((r) =>
        [r.customerName, r.customerPhone, r.contractNo].some((v) => v?.toLowerCase().includes(q)),
      );
    }
    // 완료 = 전체 품목 확정, 미완료 = 그 외
    if (status === 'COMPLETE') grouped = grouped.filter((r) => r.confirmedCount === r.itemCount);
    if (status === 'INCOMPLETE') grouped = grouped.filter((r) => r.confirmedCount < r.itemCount);
    return grouped;
  }, [data, keyword, status]);

  const columns: ColumnsType<ContractRow> = [
    {
      title: '고객명',
      key: 'customerName',
      width: 100,
      render: (_, row) => <Typography.Text strong>{row.customerName}</Typography.Text>,
    },
    {
      title: '전화번호',
      dataIndex: 'customerPhone',
      key: 'customerPhone',
      width: 130,
      render: (v: string) => v || <Typography.Text type="secondary">-</Typography.Text>,
    },
    { title: '계약번호', dataIndex: 'contractNo', key: 'contractNo', width: 120 },
    {
      title: '품목 구성',
      key: 'composition',
      width: 140,
      render: (_, row) => itemComposition(row.categoryCounts),
    },
    { title: '건수', dataIndex: 'itemCount', key: 'itemCount', width: 55, align: 'center' },
    {
      title: '완성 예정일',
      dataIndex: 'dueDate',
      key: 'dueDate',
      width: 110,
      render: (v: string | null) => v ?? <Typography.Text type="secondary">미정</Typography.Text>,
    },
    {
      title: 'D-day',
      key: 'dday',
      width: 80,
      render: (_, row) =>
        row.dueDate ? <DdayTag due={row.dueDate} /> : <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '확정',
      key: 'confirmed',
      width: 80,
      render: (_, row) =>
        row.confirmedCount === row.itemCount ? (
          <Tag color="green">전체 확정</Tag>
        ) : (
          <Typography.Text>
            {row.confirmedCount}/{row.itemCount}
          </Typography.Text>
        ),
    },
    {
      title: '진행률',
      key: 'progress',
      render: (_, row) => (
        <Progress
          percent={row.totalStages ? Math.round((row.completedStages / row.totalStages) * 100) : 0}
          size="small"
          style={{ minWidth: 120 }}
        />
      ),
    },
    {
      title: '단계',
      key: 'stages',
      width: 65,
      align: 'center',
      render: (_, row) => (
        <Typography.Text type="secondary">
          {row.completedStages}/{row.totalStages}
        </Typography.Text>
      ),
    },
  ];

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="스타일 컨설팅 목록을 불러오지 못했습니다."
        description={(error as Error).message}
      />
    );
  }

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          <Input.Search
            allowClear
            style={{ width: 320 }}
            placeholder="고객명 · 전화번호 검색"
            defaultValue={keyword}
            onSearch={(v) => {
              const next = new URLSearchParams(searchParams);
              if (v.trim()) next.set('q', v.trim());
              else next.delete('q');
              setSearchParams(next, { replace: true });
            }}
          />
          <Segmented
            value={status}
            onChange={(v) => setStatus(v as 'ALL' | 'INCOMPLETE' | 'COMPLETE')}
            options={[
              { label: '전체', value: 'ALL' },
              { label: '미완료', value: 'INCOMPLETE' },
              { label: '완료', value: 'COMPLETE' },
            ]}
          />
        </Space>
        {isLoading ? (
          <Spin style={{ display: 'block', margin: '48px auto' }} />
        ) : (
          <Table<ContractRow>
            rowKey="contractId"
            dataSource={rows}
            columns={columns}
            pagination={false}
            size="middle"
            onRow={(row) => ({
              onClick: () => navigate(`/contracts/${row.contractId}/options`),
              style: { cursor: 'pointer' },
            })}
            locale={{ emptyText: '스타일 컨설팅 대상 맞춤 품목이 있는 계약이 없습니다.' }}
          />
        )}
      </Space>
    </Card>
  );
}
