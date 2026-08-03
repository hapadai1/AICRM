/**
 * MEAS-001 채촌 대상 목록 (설계서 09 §4.1) — 계약 단위.
 * 기준은 채촌 기록이 아니라 스타일 컨설팅 대상(맞춤 계약 품목)이라, 아직 채촌하지 않은 계약도 모두 보인다.
 * 행을 고르면 중간 목록 없이 그 계약의 채촌 기록(신체 치수) 화면으로 바로 들어간다.
 */
import { LeftOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, DatePicker, Empty, Input, Segmented, Space, Tag, Typography } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchMeasurementTargets, type MeasurementTargetRow } from '../../api/measurements';
import { LAYOUT } from '../../app/theme';
import { Can } from '../../shared/Can';
import { DataTable } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { COL, wrapAt } from '../../shared/table-width';
import { CONTRACT_STATUS_META, PRODUCT_CATEGORY_LABEL } from '../contracts/labels';

/** 품목 구성 요약 — "정장 2 · 셔츠 1" */
function itemComposition(counts: MeasurementTargetRow['categoryCounts']): string {
  return (Object.keys(counts) as (keyof MeasurementTargetRow['categoryCounts'])[])
    .map((c) => `${PRODUCT_CATEGORY_LABEL[c] ?? c} ${counts[c]}`)
    .join(' · ');
}

/** 이 계약의 채촌 상태 — 고객의 과거 이력이 아니라 계약에 연결된 채촌만 본다. */
function measurementStateOf(row: MeasurementTargetRow): { label: string; color: string } {
  if (row.measurementCount === 0) return { label: '미채촌', color: 'red' };
  if (row.measurementCompletedCount > 0) return { label: '완료', color: 'green' };
  return { label: '작성중', color: 'gold' };
}

type StateFilter = 'ALL' | 'NONE' | 'DONE';

const { RangePicker } = DatePicker;

/** 기본 조회 기간: 계약일 기준 최근 1개월 (계약 목록과 동일 규칙) */
const defaultRange = (): [Dayjs, Dayjs] => [dayjs().subtract(1, 'month'), dayjs()];

/** URL 쿼리 ↔ 필터 상태 */
interface Filters {
  q: string;
  dateFrom: string;
  dateTo: string;
  state: StateFilter;
  customerId?: string;
  page: number;
  size: number;
}

function readFilters(params: URLSearchParams): Filters {
  const [from, to] = defaultRange();
  return {
    q: params.get('q') ?? '',
    dateFrom: params.get('dateFrom') ?? from.format('YYYY-MM-DD'),
    dateTo: params.get('dateTo') ?? to.format('YYYY-MM-DD'),
    // 목록은 아직 채촌하지 않은 계약을 먼저 보는 화면이라 미완료가 기본.
    state: (params.get('state') as StateFilter | null) ?? 'NONE',
    customerId: params.get('customerId') ?? undefined,
    page: Number(params.get('page') ?? 1),
    size: Number(params.get('size') ?? 30),
  };
}

function writeFilters(filters: Filters): Record<string, string> {
  const entries: [string, string | number | undefined][] = [
    ['q', filters.q || undefined],
    ['dateFrom', filters.dateFrom || undefined],
    ['dateTo', filters.dateTo || undefined],
    ['state', filters.state !== 'NONE' ? filters.state : undefined],
    ['customerId', filters.customerId],
    ['page', filters.page > 1 ? filters.page : undefined],
    ['size', filters.size !== 30 ? filters.size : undefined],
  ];
  return Object.fromEntries(
    entries.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
  );
}

interface MeasurementListProps {
  /** 지정 시 이 고객의 계약만 조회(고객모드 임베드용) */
  customerId?: string;
  /** 임베드 모드: 검색·필터 크롬 없이 표만 렌더, 고객 열 숨김 */
  embedded?: boolean;
}

export function MeasurementListPage({
  customerId: customerIdProp,
  embedded = false,
}: MeasurementListProps = {}) {
  const navigate = useNavigate();
  // 고객 상세·주문 화면에서 ?customerId= 로 넘어오면 그 고객의 계약만 추린다.
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const customerId = customerIdProp ?? filters.customerId ?? null;

  // 검색어는 입력 중 URL을 바꾸지 않도록 로컬 상태로 둔다.
  const [keyword, setKeyword] = useState(filters.q);

  const update = (patch: Partial<Filters>) => {
    // 조건이 바뀌면 첫 페이지로 되돌린다(페이지 이동만 예외).
    const nextPage = patch.page ?? 1;
    setSearchParams(writeFilters({ ...filters, ...patch, page: nextPage }));
  };

  /**
   * 조회 기간을 통째로 앞뒤 한 달씩 옮긴다.
   *
   * 시작일만 월 단위로 옮기고 종료일은 **폭(일수)을 더해** 다시 만든다.
   * 양끝을 각각 add(month) 하면 말일이 그 달 길이에 맞춰 깎여서
   * (7/31 −1달 = 6/30, 다시 +1달 = 7/30) 이전→다음 왕복에 하루씩 사라진다.
   */
  const shiftRange = (months: number) => {
    const [defFrom, defTo] = defaultRange();
    const from = filters.dateFrom ? dayjs(filters.dateFrom) : defFrom;
    const to = filters.dateTo ? dayjs(filters.dateTo) : defTo;
    const spanDays = to.diff(from, 'day');
    const nextFrom = from.add(months, 'month');
    update({
      dateFrom: nextFrom.format('YYYY-MM-DD'),
      dateTo: nextFrom.add(spanDays, 'day').format('YYYY-MM-DD'),
    });
  };

  const resetFilters = () => {
    setKeyword('');
    const [from, to] = defaultRange();
    setSearchParams(
      writeFilters({
        q: '',
        dateFrom: from.format('YYYY-MM-DD'),
        dateTo: to.format('YYYY-MM-DD'),
        state: 'NONE',
        customerId: filters.customerId,
        page: 1,
        size: 30,
      }),
    );
  };

  const query = useQuery({
    queryKey: ['measurements', 'targets'],
    queryFn: fetchMeasurementTargets,
  });

  const rows = useMemo(() => {
    let list = query.data ?? [];
    if (customerId) list = list.filter((r) => r.customerId === customerId);
    // 임베드(고객모드)는 필터 크롬이 없어 조작할 수 없다 — 그 고객의 계약 전체를 그대로 보여 준다.
    if (embedded) return list;
    if (filters.dateFrom) list = list.filter((r) => r.contractDate >= filters.dateFrom);
    if (filters.dateTo) list = list.filter((r) => r.contractDate <= filters.dateTo);
    const q = filters.q.trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        [r.customerName, r.customerPhone, r.contractNo].some((v) => v?.toLowerCase().includes(q)),
      );
    }
    // 완료 = 완료 처리된 채촌이 하나라도 있는 계약, 미완료 = 그 외(미채촌·작성중)
    if (filters.state === 'NONE') list = list.filter((r) => r.measurementCompletedCount === 0);
    if (filters.state === 'DONE') list = list.filter((r) => r.measurementCompletedCount > 0);
    return list;
  }, [query.data, customerId, embedded, filters]);

  /** 표 변경은 페이지 이동만 반영한다(정렬은 서버 규칙 고정 — 미채촌 우선). */
  const handleTableChange = (pagination: TablePaginationConfig) => {
    update({ page: pagination.current ?? 1, size: pagination.pageSize ?? filters.size });
  };

  // 앞 다섯 열(고객·계약 구분·계약일·완료 예정일·상태)은 계약 목록과 같은 규격·같은 값이다.
  const columns: ColumnsType<MeasurementTargetRow> = [
    {
      title: '고객',
      key: 'customer',
      width: COL.name,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.customerName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.customerPhone || '-'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      // 계약번호는 참고용이라 자기 열 없이 계약 구분 아래에 붙인다(계약 목록과 같은 방식).
      title: '계약 구분',
      dataIndex: 'contractTypeName',
      width: COL.code,
      render: (name: string | null, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{name ?? '-'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.contractNo}
          </Typography.Text>
        </Space>
      ),
    },
    // 기간 필터의 기준값이라 표에도 둔다 — 왜 이 건이 걸렸는지 열에서 바로 확인되어야 한다.
    // 계약일 전(작성중)은 작성일이 대신 들어온다 — 그 구분은 상태 열이 한다.
    { title: '계약일', dataIndex: 'contractDate', width: COL.name },
    {
      title: '완료 예정일',
      dataIndex: 'dueDate',
      width: COL.name,
      render: (v: string | null) => v ?? <Typography.Text type="secondary">미정</Typography.Text>,
    },
    {
      /*
       * 계약 상태 — 이 목록은 계약 상태로 거르지 않고 "맞춤 주문이 생긴 계약"을 모두 보여 준다.
       * 주문은 계약완료에서만 생기므로 대부분 계약완료지만, 수정하기로 되돌아간 계약은
       * 주문을 그대로 둔 채 작성중·서명완료로 돌아온다. 채촌하러 들어가기 전에 그 사실이 보여야 한다.
       * 취소 계약은 주문이 있으면 취소 자체가 막혀 여기 나타나지 않는다.
       */
      title: '상태',
      dataIndex: 'contractStatus',
      width: COL.status,
      render: (v: string) => {
        const meta = metaOf(CONTRACT_STATUS_META, v);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    {
      /*
       * 품목이 늘면 "정장 2 · 셔츠 1 · 구두 1"처럼 길어지는 유일한 열이다.
       * 열 폭은 COL.wide 로 고정되므로, 값이 그보다 길면 셀 안에서 줄을 바꾼다.
       * 채촌 대상은 맞춤 품목뿐이라 렌탈 줄은 없다.
       */
      title: '품목 구성',
      key: 'composition',
      width: COL.wide,
      render: (_, row) => (
        <Typography.Text style={wrapAt(200)}>{itemComposition(row.categoryCounts) || '-'}</Typography.Text>
      ),
    },
    {
      title: '스타일 컨설팅',
      key: 'consulting',
      width: COL.wide,
      render: (_, row) =>
        row.consultingComplete ? (
          <Tag color="green">전체 완료</Tag>
        ) : (
          <Space size={4}>
            <Tag color="orange">미완료</Tag>
            <Typography.Text type="secondary">
              {row.consultingConfirmedCount}/{row.itemCount}
            </Typography.Text>
          </Space>
        ),
    },
    {
      title: '채촌 상태',
      key: 'measurement',
      width: COL.status,
      render: (_, row) => {
        const state = measurementStateOf(row);
        return <StatusBadge label={state.label} color={state.color} />;
      },
    },
    {
      title: '액션',
      key: 'actions',
      width: COL.action2,
      render: (_, row) => (
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          <Button
            size="small"
            disabled={!row.lastSessionId}
            onClick={() => navigate(`/measurements/${row.lastSessionId}`)}
          >
            기록 보기
          </Button>
          <Can permission="MEASUREMENT_EDIT">
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() =>
                navigate(`/measurements/new?customerId=${row.customerId}&orderId=${row.orderId}`)
              }
            >
              채촌
            </Button>
          </Can>
        </Space>
      ),
    },
  ];

  const tableEl = (
    <DataTable<MeasurementTargetRow>
      rowKey="contractId"
      loading={query.isLoading}
      dataSource={rows}
      columns={embedded ? columns.filter((c) => c.key !== 'customer') : columns}
      onChange={handleTableChange}
      pagination={
        embedded
          ? false
          : { current: filters.page, pageSize: filters.size, total: rows.length }
      }
      onRow={(row) => ({
        onClick: () => {
          if (row.lastSessionId) navigate(`/measurements/${row.lastSessionId}`);
        },
        style: { cursor: row.lastSessionId ? 'pointer' : 'default' },
      })}
      locale={{
        emptyText: <Empty description="스타일 컨설팅 대상 맞춤 품목이 있는 계약이 없습니다." />,
      }}
    />
  );

  // 임베드(고객모드): 크롬 없이 표만. 고객 열은 숨긴다.
  if (embedded) return tableEl;

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
              placeholder="고객명 · 전화번호 · 계약번호"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onSearch={(v) => update({ q: v.trim() })}
            />
            {/* 기간 앞뒤 이동은 달력을 열지 않고 지난달·다음달을 훑는 조작이라 기간 입력에 붙여 둔다. */}
            <Space.Compact>
              <Button
                icon={<LeftOutlined />}
                onClick={() => shiftRange(-1)}
                title="이전 1개월"
                aria-label="이전 1개월"
              />
              <RangePicker
                allowEmpty={[true, true]}
                value={[
                  filters.dateFrom ? dayjs(filters.dateFrom) : null,
                  filters.dateTo ? dayjs(filters.dateTo) : null,
                ]}
                onChange={(range) =>
                  update({
                    dateFrom: range?.[0]?.format('YYYY-MM-DD') ?? '',
                    dateTo: range?.[1]?.format('YYYY-MM-DD') ?? '',
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
              value={filters.state}
              onChange={(v) => update({ state: v as StateFilter })}
              options={[
                { label: '전체', value: 'ALL' },
                { label: '미완료', value: 'NONE' },
                { label: '완료', value: 'DONE' },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={resetFilters}>
              초기화
            </Button>
            {customerId && (
              <Tag closable color="blue" onClose={() => update({ customerId: undefined })}>
                고객 지정 조회 중{rows[0]?.customerName ? `: ${rows[0].customerName}` : ''}
              </Tag>
            )}
            </>
          }
          actions={
            <Can permission="MEASUREMENT_EDIT">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/measurements/new')}>
                신규 채촌
              </Button>
            </Can>
          }
        />

        {tableEl}
      </Space>
      </PageCard>
    </PageShell>
  );
}
