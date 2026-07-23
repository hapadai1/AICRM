/** PROD-001 계약별 제작 관리 목록 — 고객명·전화로 식별, 행 클릭 시 계약 제작 관리 화면으로 진입 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Input, Progress, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ProductCategory } from '../../api/contracts';
import { fetchProductionItems, type ProductionItem } from '../../api/production';
import { metaOf } from '../../shared/status-meta';
import { PRODUCT_CATEGORY_LABEL } from '../contracts/labels';
import { WORK_ORDER_STATUS_META } from '../workorders/wo-meta';

/** 품목 제작 흐름 순서 (백엔드 ITEM_STATUS_FLOW). 진행률 계산용. */
const ITEM_STATUS_ORDER = [
  'CREATED',
  'OPTION_PENDING',
  'MEASUREMENT_PENDING',
  'READY_TO_ORDER',
  'PRODUCTION_REQUESTED',
  'PRODUCTION_IN_PROGRESS',
  'BASTING_RECEIVED',
  'FITTING_COMPLETED',
  'PRODUCTION_COMPLETED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_RELEASED',
  'RELEASED',
];

function itemProgress(status: string): number {
  if (status === 'COMPLETED' || status === 'RELEASED') return 1;
  const i = ITEM_STATUS_ORDER.indexOf(status);
  return i < 0 ? 0 : i / (ITEM_STATUS_ORDER.length - 1);
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
  categoryCounts: Record<string, number>;
  receivedCount: number;
  releasedCount: number;
  /** 제작 진행률 평균 산출용 (취소 제외) */
  progressSum: number;
  progressCount: number;
  /** 작업지시서 미출력(옵션·채촌 준비됐으나 미출력) 건수 */
  woUnorderedCount: number;
  /** 작업지시서 재출력 필요 건수 */
  woReprintCount: number;
}

function groupByContract(items: ProductionItem[]): ContractRow[] {
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
      receivedCount: 0,
      releasedCount: 0,
      progressSum: 0,
      progressCount: 0,
      woUnorderedCount: 0,
      woReprintCount: 0,
    };
    row.itemCount += 1;
    row.categoryCounts[it.productCategory] = (row.categoryCounts[it.productCategory] ?? 0) + 1;
    if (it.itemStatus === 'RECEIVED' || it.itemStatus === 'RELEASED' || it.itemStatus === 'COMPLETED')
      row.receivedCount += 1;
    if (it.itemStatus === 'RELEASED' || it.itemStatus === 'COMPLETED') row.releasedCount += 1;
    if (it.itemStatus !== 'CANCELLED') {
      row.progressSum += itemProgress(it.itemStatus);
      row.progressCount += 1;
    }
    if (it.workOrder.status === 'UNORDERED') row.woUnorderedCount += 1;
    if (it.workOrder.status === 'REPRINT_NEEDED') row.woReprintCount += 1;
    const due = it.completionDueDate?.slice(0, 10) ?? null;
    if (due && (!row.dueDate || due < row.dueDate)) row.dueDate = due;
    map.set(it.contractId, row);
  }
  return [...map.values()].sort((a, b) => b.contractNo.localeCompare(a.contractNo));
}

/** 품목 구성 요약 — "정장 2 · 셔츠 1" */
function itemComposition(counts: Record<string, number>): string {
  return Object.keys(counts)
    .map((c) => `${PRODUCT_CATEGORY_LABEL[c as ProductCategory] ?? c} ${counts[c]}`)
    .join(' · ');
}

/** 납기 D-day 태그 */
function DdayTag({ due }: { due: string }) {
  const days = dayjs(due).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (days < 0) return <Tag color="red">D+{-days} 지남</Tag>;
  if (days === 0) return <Tag color="volcano">D-day</Tag>;
  if (days <= 3) return <Tag color="orange">D-{days}</Tag>;
  return <Tag color="default">D-{days}</Tag>;
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
      title: '고객명',
      key: 'customerName',
      width: 100,
      render: (_, r) => <Typography.Text strong>{r.customerName}</Typography.Text>,
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
      render: (_, r) => itemComposition(r.categoryCounts),
    },
    {
      title: '건수',
      dataIndex: 'itemCount',
      key: 'itemCount',
      width: 55,
      align: 'center',
    },
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
      render: (_, r) => (r.dueDate ? <DdayTag due={r.dueDate} /> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '제작 진행률',
      key: 'progress',
      render: (_, r) => {
        const pct = r.progressCount ? Math.round((r.progressSum / r.progressCount) * 100) : 0;
        return <Progress percent={pct} size="small" style={{ minWidth: 120 }} />;
      },
    },
    {
      title: '입고',
      key: 'received',
      width: 80,
      render: (_, r) =>
        r.releasedCount === r.itemCount ? (
          <Tag color="green">전체 출고</Tag>
        ) : r.receivedCount === r.itemCount ? (
          <Tag color="gold">전체 입고</Tag>
        ) : (
          <Typography.Text>
            {r.receivedCount}/{r.itemCount}
          </Typography.Text>
        ),
    },
    {
      title: '작업지시서',
      key: 'workOrder',
      width: 120,
      render: (_, r) =>
        r.woUnorderedCount === 0 && r.woReprintCount === 0 ? (
          <Tag color="green">전체 최신</Tag>
        ) : (
          <Space size={[6, 6]} wrap>
            {r.woUnorderedCount > 0 ? (
              <Tag color={metaOf(WORK_ORDER_STATUS_META, 'UNORDERED').color}>
                미출력 {r.woUnorderedCount}
              </Tag>
            ) : null}
            {r.woReprintCount > 0 ? (
              <Tag color={metaOf(WORK_ORDER_STATUS_META, 'REPRINT_NEEDED').color}>
                재출력 {r.woReprintCount}
              </Tag>
            ) : null}
          </Space>
        ),
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
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Input.Search
          allowClear
          style={{ maxWidth: 320 }}
          placeholder="고객명 · 전화번호 검색"
          defaultValue={keyword}
          onSearch={(v) => {
            const next = new URLSearchParams(searchParams);
            if (v.trim()) next.set('q', v.trim());
            else next.delete('q');
            setSearchParams(next, { replace: true });
          }}
        />
        <Table<ContractRow>
          rowKey="contractId"
          size="middle"
          loading={itemsQuery.isLoading}
          dataSource={rows}
          columns={columns}
          pagination={false}
          onRow={(r) => ({
            onClick: () => navigate(`/contracts/${r.contractId}/production`),
            style: { cursor: 'pointer' },
          })}
          locale={{ emptyText: '제작 대상 품목이 있는 계약이 없습니다.' }}
        />
      </Space>
    </Card>
  );
}
