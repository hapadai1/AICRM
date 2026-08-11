/** OPT-001 스타일 컨설팅 목록 — 계약 단위로 묶어 고객명·전화로 식별, 행 클릭 시 계약 스타일 컨설팅 화면으로 진입 */
import { LeftOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, DatePicker, Input, Progress, Segmented, Space, Tag, Typography } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { OptionProgressItem, ProductCategory } from '../../api/options';
import { fetchOptionProgress } from '../../api/options';
import type { RentalProgressItem } from '../../api/rentals';
import { fetchRentalSelectionProgress } from '../../api/rentals';
import { DataTable, DEFAULT_PAGE_SIZE } from '../../shared/DataTable';
import { COL } from '../../shared/table-width';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { StatusBadge } from '../../shared/StatusBadge';
import { LAYOUT } from '../../app/theme';
import { ItemCompositionCell } from '../contracts/ItemCompositionCell';
import { CONTRACT_STATUS_META, metaOf } from '../contracts/labels';

/** 납기 D-day 태그 */
function DdayTag({ due }: { due: string }) {
  const days = dayjs(due).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (days < 0) return <Tag color="red">D+{-days} 지남</Tag>;
  if (days === 0) return <Tag color="volcano">D-day</Tag>;
  if (days <= 3) return <Tag color="orange">D-{days}</Tag>;
  return <Tag color="default">D-{days}</Tag>;
}

const { RangePicker } = DatePicker;

/** 기본 조회 기간: 최근 1개월 (계약 목록과 동일 — 현업 확정 2026-07-31) */
const defaultRange = (): [Dayjs, Dayjs] => [dayjs().subtract(1, 'month'), dayjs()];

interface ContractRow {
  contractId: string;
  contractNo: string;
  /**
   * 계약일(YYYY-MM-DD). 계약일은 계약완료 시점에 정해지므로 그 전에는 작성일을 쓴다
   * — 기간 필터 기준도 이 값이다 (계약 목록과 같은 규칙).
   */
  contractDate: string;
  /** 계약 상태(DRAFT·SIGNED·COMPLETED) — 서명완료 이후는 컨설팅이 보기 전용이다 */
  contractStatus: string;
  /** 계약 구분 이름 — 계약 목록의 같은 열. 계약에 구분이 없으면 null */
  contractTypeName: string | null;
  customerName: string;
  customerPhone: string;
  /** 완성 예정일(납기) — 계약 내 가장 이른 납기 (YYYY-MM-DD). 없으면 null */
  dueDate: string | null;
  /** 건수 = 이 계약의 전체 품목 수(맞춤 + 렌탈). 확정 분모도 이 값이다. */
  itemCount: number;
  /** 카테고리별 맞춤 품목 수 (품목 구성 요약) */
  customCounts: Partial<Record<ProductCategory, number>>;
  /** 카테고리별 렌탈 품목 수 — 옵션 선택은 아니지만 실물 선정을 해야 하므로 함께 센다 */
  rentalCounts: Partial<Record<ProductCategory, number>>;
  /** 확정 품목 수 — 맞춤은 옵션 확정, 렌탈은 실물 선정 확정 (현업 확정 2026-07-31) */
  confirmedCount: number;
  completedStages: number;
  totalStages: number;
}

/**
 * 렌탈 선택 완료 판정 — 확정(CONFIRMED)이거나, 취소(베스트 제외) 안 된 모든 부위에
 * 실물이 지정된 경우. 서버 consultingReadiness의 렌탈 판정과 같은 기준이다.
 * (실물을 고르려면 대여 기간이 있어야 하므로 여기서는 기간을 따로 검사하지 않는다.)
 */
function rentalSelectionDone(it: RentalProgressItem): boolean {
  if (it.status === 'CONFIRMED') return true;
  const active = it.components.filter((c) => !c.excluded);
  return active.length > 0 && active.every((c) => c.selectedInventoryItemId != null);
}

/**
 * 계약 단위로 묶는다. 행의 뼈대는 맞춤 품목이 만들고, 렌탈은 이미 만들어진 행에만 얹는다
 * — 맞춤이 없는(렌탈뿐인) 계약은 컨설팅할 것이 없으므로 목록에 올리지 않는다.
 */
function groupByContract(items: OptionProgressItem[], rentals: RentalProgressItem[]): ContractRow[] {
  const map = new Map<string, ContractRow>();
  for (const it of items) {
    const row = map.get(it.contractId) ?? {
      contractId: it.contractId,
      contractNo: it.contractNo,
      contractTypeName: it.contractTypeName,
      contractStatus: it.contractStatus,
      contractDate: (it.contractedAt ?? it.contractCreatedAt).slice(0, 10),
      customerName: it.customerName,
      customerPhone: it.customerPhone,
      dueDate: null,
      itemCount: 0,
      customCounts: {},
      rentalCounts: {},
      confirmedCount: 0,
      completedStages: 0,
      totalStages: 0,
    };
    row.itemCount += 1;
    row.customCounts[it.productCategory] = (row.customCounts[it.productCategory] ?? 0) + 1;
    if (it.status === 'CONFIRMED') row.confirmedCount += 1;
    row.completedStages += it.completedStages;
    row.totalStages += it.totalStages;
    const due = it.completionDueDate?.slice(0, 10) ?? null;
    if (due && (!row.dueDate || due < row.dueDate)) row.dueDate = due;
    map.set(it.contractId, row);
  }
  for (const it of rentals) {
    const row = map.get(it.contractId);
    if (!row) continue;
    const category = it.productCategory as ProductCategory;
    row.itemCount += 1;
    row.rentalCounts[category] = (row.rentalCounts[category] ?? 0) + 1;
    // 렌탈도 실물 선정을 확정해야 끝나므로 맞춤 확정과 같은 칸에 센다.
    // 진행률에서는 렌탈 한 품목을 1단계로 잡는다 — 맞춤처럼 옵션 단계가 나뉘지 않고
    // 부위를 다 고른 뒤 한 번에 확정하는 작업이라, 확정 전까지는 0/1이다 (현업 확정 2026-07-31).
    row.totalStages += 1;
    // 렌탈은 별도 확정 버튼이 없다 — 실물을 다 고르면(선택 완료) 완료로 센다. 서명 시점에
    // 서버가 자동 확정하므로, 이미 확정된 세션도 함께 완료로 인정한다 (현업 확정 2026-08-11).
    if (rentalSelectionDone(it)) {
      row.confirmedCount += 1;
      row.completedStages += 1;
    }
    const due = it.completionDueDate?.slice(0, 10) ?? null;
    if (due && (!row.dueDate || due < row.dueDate)) row.dueDate = due;
  }
  return [...map.values()].sort((a, b) => b.contractNo.localeCompare(a.contractNo));
}

interface OptionProgressListProps {
  /** 지정 시 이 계약들만 표시(고객모드 임베드용) */
  contractIds?: string[];
  /** 임베드 모드: 검색·필터 크롬 없이 표만 렌더, 고객명·전화 열 숨김 */
  embedded?: boolean;
}

export function OptionProgressListPage({
  contractIds,
  embedded = false,
}: OptionProgressListProps = {}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = searchParams.get('q') ?? '';
  // 기간(계약일 기준)은 URL에 실어 새로고침·뒤로가기·링크 공유에 보존한다. 계약 목록과 동일.
  const [defFrom, defTo] = defaultRange();
  const dateFrom = searchParams.get('dateFrom') ?? defFrom.format('YYYY-MM-DD');
  const dateTo = searchParams.get('dateTo') ?? defTo.format('YYYY-MM-DD');
  // 기본은 전체 — 조회 기간 안의 계약을 상태로 가리지 않고 다 보여 준다(현업 확정 2026-08-04).
  const [status, setStatus] = useState<'ALL' | 'INCOMPLETE' | 'COMPLETE'>('ALL');
  const size = Number(searchParams.get('size') ?? DEFAULT_PAGE_SIZE);
  // 검색어는 입력 중 URL을 바꾸지 않도록 로컬 상태로 둔다(계약 목록과 동일).
  const [keywordInput, setKeywordInput] = useState(keyword);

  const { data, isLoading, error } = useQuery({
    queryKey: ['options', 'progress'],
    queryFn: () => fetchOptionProgress(),
  });
  // 렌탈 품목은 옵션 선택 대상이 아니라 이 API에 없다 — 품목 구성·건수에 함께 세려고 따로 받는다.
  const rentalQuery = useQuery({
    queryKey: ['rental-selection', 'progress'],
    queryFn: () => fetchRentalSelectionProgress(),
  });

  const rows = useMemo(() => {
    let grouped = groupByContract(data ?? [], rentalQuery.data ?? []);
    // 고객모드: 이 고객의 계약들로만 좁힌다(OptionProgressItem에 customerId가 없어 계약ID로 필터).
    if (contractIds) {
      const allow = new Set(contractIds);
      grouped = grouped.filter((r) => allow.has(r.contractId));
    }
    const q = keyword.trim().toLowerCase();
    if (q) {
      grouped = grouped.filter((r) =>
        [r.customerName, r.customerPhone, r.contractNo].some((v) => v?.toLowerCase().includes(q)),
      );
    }
    // 계약일 기준 기간(양끝 포함). 임베드(고객모드)는 기간 없이 이 고객 계약을 다 보여준다.
    if (!embedded) {
      if (dateFrom) grouped = grouped.filter((r) => r.contractDate >= dateFrom);
      if (dateTo) grouped = grouped.filter((r) => r.contractDate <= dateTo);
    }
    // 완료 = 맞춤·렌탈 전 품목 확정, 미완료 = 그 외
    if (status === 'COMPLETE') grouped = grouped.filter((r) => r.confirmedCount === r.itemCount);
    if (status === 'INCOMPLETE') grouped = grouped.filter((r) => r.confirmedCount < r.itemCount);
    return grouped;
  }, [data, rentalQuery.data, keyword, status, contractIds, embedded, dateFrom, dateTo]);

  // 조건이 바뀌면 결과가 줄어 지금 페이지가 비어 버릴 수 있다 → 첫 페이지로 되돌린다.
  // (페이지 이동 자체는 setParams에 page를 실어 예외로 둔다.)
  /** URL 쿼리 갱신 — 값이 비면 키를 지운다 */
  const setParams = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries({ page: undefined, ...patch })) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSearchParams(next, { replace: true });
  };

  /** 검색 조건을 기본값(최근 1개월·전체)으로 되돌린다 */
  const resetFilters = () => {
    setKeywordInput('');
    setStatus('ALL');
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  // 페이지는 목록 길이 안으로 가둔다 — 조건이 바뀐 뒤 남은 페이지 번호로 빈 표가 뜨지 않게.
  const lastPage = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(1, Number(searchParams.get('page') ?? 1)), lastPage);

  /**
   * 조회 기간을 통째로 앞뒤 한 달씩 옮긴다 (계약 목록 shiftRange와 동일 규칙).
   * 시작일만 월 단위로 옮기고 종료일은 폭(일수)을 더해 다시 만든다 — 양끝을 각각
   * add(month) 하면 말일이 달 길이에 맞춰 깎여 왕복에 하루씩 사라진다.
   */
  const shiftRange = (months: number) => {
    const from = dayjs(dateFrom);
    const spanDays = dayjs(dateTo).diff(from, 'day');
    const nextFrom = from.add(months, 'month');
    setParams({
      dateFrom: nextFrom.format('YYYY-MM-DD'),
      dateTo: nextFrom.add(spanDays, 'day').format('YYYY-MM-DD'),
    });
  };

  const columns: ColumnsType<ContractRow> = [
    {
      // 고객명·전화번호를 한 칸에 겹쳐 쓴다 — 채촌 목록·계약 목록과 같은 규격.
      title: '고객',
      key: 'customer',
      width: COL.name,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong ellipsis>
            {row.customerName}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.customerPhone || '-'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      // 계약 목록과 같은 규격 — 계약번호는 자기 열을 주지 않고 계약 구분 아래에 붙인다
      // (고객 열의 전화번호와 같은 방식).
      title: '계약 구분',
      key: 'contractType',
      width: COL.code,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text ellipsis>{row.contractTypeName ?? '-'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.contractNo}
          </Typography.Text>
        </Space>
      ),
    },
    {
      // 품목이 늘면 "정장 2 · 셔츠 1 · 조끼 1"처럼 길어지는 유일한 열이라 잘라 둔다.
      // 렌탈이 섞인 계약만 맞춤/렌탈 두 줄로 나눠 쓴다(거래구분 색은 계약 상세 품목표와 동일).
      // 대부분의 계약은 맞춤뿐이라, 그때는 태그 없이 한 줄로 둬 목록이 시끄러워지지 않게 한다.
      title: '품목 구성',
      key: 'composition',
      width: COL.wide,
      ellipsis: true,
      render: (_, row) => (
        <ItemCompositionCell customCounts={row.customCounts} rentalCounts={row.rentalCounts} />
      ),
    },
    // 계약의 전체 품목 수(맞춤+렌탈). 확정 열의 분모(맞춤만)와 다를 수 있다.
    { title: '건수', dataIndex: 'itemCount', key: 'itemCount', width: COL.count, align: 'center' },
    {
      // 기간 검색 기준이 계약일이라 값이 보여야 한다. 계약일 전(작성중)은 작성일을 대신 쓴다.
      // 그 구분은 계약 상태 열이 대신한다 — 계약일이 생기는 상태는 계약완료뿐이라,
      // 배지가 계약완료가 아니면 이 값은 작성일이다. 그래서 (작성) 표기를 따로 두지 않는다.
      title: '계약일',
      dataIndex: 'contractDate',
      key: 'contractDate',
      width: COL.name,
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
      render: (_, row) =>
        row.dueDate ? <DdayTag due={row.dueDate} /> : <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      // 서명완료·계약완료 계약은 컨설팅이 보기 전용이라, 들어가기 전에 여기서 알아야 한다.
      title: '계약 상태',
      dataIndex: 'contractStatus',
      key: 'contractStatus',
      width: COL.status,
      render: (v: string) => {
        const meta = metaOf(CONTRACT_STATUS_META, v);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    {
      // 분모는 건수와 같은 전체 품목 수 — 맞춤은 옵션 확정, 렌탈은 실물 선정 확정을 센다.
      title: '스타일 확정',
      key: 'confirmed',
      width: COL.status,
      render: (_, row) =>
        row.confirmedCount === row.itemCount ? (
          <StatusBadge label="확정 완료" color="green" />
        ) : (
          <StatusBadge label="진행중" color="gold" />
        ),
    },
    {
      // 막대 오른쪽 숫자를 퍼센트 대신 단계수(3/8)로 바꿔, 따로 있던 '단계' 열을 흡수했다.
      title: '진행률',
      key: 'progress',
      width: COL.wide,
      render: (_, row) => (
        <Progress
          percent={row.totalStages ? Math.round((row.completedStages / row.totalStages) * 100) : 0}
          size="small"
          format={() => `${row.completedStages}/${row.totalStages}`}
        />
      ),
    },
  ];

  // 렌탈 조회가 깨지면 품목 구성·건수가 조용히 틀리게 나오므로 함께 오류로 알린다.
  const loadError = error ?? rentalQuery.error;
  if (loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message="스타일 컨설팅 목록을 불러오지 못했습니다."
        description={(loadError as Error).message}
      />
    );
  }

  // 임베드(고객모드)는 이미 고객이 정해진 화면이라 고객 열을 뺀다.
  const shownColumns = embedded ? columns.filter((c) => c.key !== 'customer') : columns;
  // 폭을 다 고정했으니 표 폭도 합으로 확정한다 — 'max-content'로 두면 다시 데이터가 폭을 정한다.

  const tableEl = (
    <DataTable<ContractRow>
      rowKey="contractId"
      loading={isLoading || rentalQuery.isLoading}
      dataSource={rows}
      columns={shownColumns}
      // 임베드(고객모드)는 한 고객의 계약 몇 건뿐이라 페이징 없이 다 보여준다.
      pagination={
        embedded
          ? false
          : { current: page, pageSize: size, total: rows.length }
      }
      onChange={(pagination: TablePaginationConfig) =>
        setParams({
          page: (pagination.current ?? 1) > 1 ? String(pagination.current) : undefined,
          size:
            pagination.pageSize && pagination.pageSize !== DEFAULT_PAGE_SIZE
              ? String(pagination.pageSize)
              : undefined,
        })
      }
      onRow={(row) => ({
        onClick: () => navigate(`/contracts/${row.contractId}/options`),
        style: { cursor: 'pointer' },
      })}
      locale={{ emptyText: '스타일 컨설팅 대상 맞춤 품목이 있는 계약이 없습니다.' }}
    />
  );

  // 임베드(고객모드): 크롬 없이 표만. 고객명·전화 열은 숨긴다.
  if (embedded) return tableEl;

  // 검색 조건 카드 + 표 카드로 나눈다 — 계약 목록과 같은 구성.
  return (
    <PageShell>
      <PageCard>
        <ListToolbar
          filters={
            <>
              {/* 고객 선택은 이 입력 하나로 끝낸다(고객명·전화번호·계약번호가 다 걸린다). */}
              <Input.Search
                allowClear
                style={{ width: LAYOUT.searchWidth }}
                placeholder="고객명 · 전화번호 · 계약번호"
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                onSearch={(v) => setParams({ q: v.trim() || undefined })}
              />
              {/* 기간(계약일 기준) — 앞뒤 1개월 이동은 달력을 열지 않고 지난달을 훑는 조작이라 붙여 둔다. */}
              <Space.Compact>
                <Button
                  icon={<LeftOutlined />}
                  onClick={() => shiftRange(-1)}
                  title="이전 1개월"
                  aria-label="이전 1개월"
                />
                <RangePicker
                  allowEmpty={[true, true]}
                  value={[dateFrom ? dayjs(dateFrom) : null, dateTo ? dayjs(dateTo) : null]}
                  onChange={(range) =>
                    setParams({
                      dateFrom: range?.[0]?.format('YYYY-MM-DD'),
                      dateTo: range?.[1]?.format('YYYY-MM-DD'),
                    })
                  }
                />
                <Button
                  icon={<RightOutlined />}
                  onClick={() => shiftRange(1)}
                  title="다음 1개월"
                  aria-label="다음 1개월"
                />
              </Space.Compact>
              <Segmented
                value={status}
                onChange={(v) => {
                  setStatus(v as 'ALL' | 'INCOMPLETE' | 'COMPLETE');
                  setParams({}); // 조건이 바뀌었으니 첫 페이지로
                }}
                options={[
                  { label: '전체', value: 'ALL' },
                  { label: '미완료', value: 'INCOMPLETE' },
                  { label: '완료', value: 'COMPLETE' },
                ]}
              />
              <Button icon={<ReloadOutlined />} onClick={resetFilters}>
                초기화
              </Button>
            </>
          }
        />
      </PageCard>

      <PageCard>{tableEl}</PageCard>
    </PageShell>
  );
}
