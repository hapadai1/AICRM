/**
 * 계약 목록 — 계약 현황 조회 화면 (개편계획 06)
 * - 진입점은 고객과 기간: 통합검색(고객명·전화번호·계약번호) + 기간 기준·범위
 * - 필터는 URL 쿼리에 동기화한다(새로고침·뒤로가기·링크 공유 보존)
 */
import {
  FilterOutlined,
  LeftOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  DatePicker,
  Input,
  Radio,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CONTRACT_FILTER_STATUSES,
  fetchContractTypes,
  fetchContracts,
  type ContractListItem,
  type ContractSearchParams,
  type ContractStatus,
} from '../../api/contracts';
import { useModeStore } from '../../app/mode-store';
import { Can } from '../../shared/Can';
import { DataTable } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { LAYOUT } from '../../app/theme';
import { StatusBadge } from '../../shared/StatusBadge';
import { COL } from '../../shared/table-width';
import { CONTRACT_STATUS_META, formatKrw, metaOf } from './labels';

import { ItemCompositionCell } from './ItemCompositionCell';
import { fetchOptionProgress } from '../../api/options';
import { fetchRentalSelectionProgress } from '../../api/rentals';
import { fetchProductionItems, type ProductionItem } from '../../api/production';
import { groupByContract as groupStyleByContract } from '../options/OptionProgressListPage';
import {
  contractProductionStages,
  contractTrackProgress,
  type ContractProductionStages,
  type ContractTrackProgress,
} from '../production/production-stages';
import { TrackProgressBars } from '../production/TrackProgressBars';

const { RangePicker } = DatePicker;

/**
 * 셀렉트에서 "전체"를 고른 값. 기본값이 전체라 URL에는 남기지 않는다
 * — status 가 없는 것과 전체가 같은 뜻이다.
 */
const STATUS_ALL = 'ALL';

/**
 * 상태 셀렉트 항목 — 맨 앞이 전체, 나머지는 백엔드가 허용하는 상태만 사용한다
 * (CONTRACT_STATUSES 와 동일). 순서는 계약 흐름 순서다.
 */
const STATUS_OPTIONS = [
  { value: STATUS_ALL, label: '전체' },
  ...CONTRACT_FILTER_STATUSES.map((value) => ({
    value,
    label: metaOf(CONTRACT_STATUS_META, value).label,
  })),
];

/**
 * 정렬은 계약일 최신순으로 고정한다(관리자·고객모드 동일).
 * 표 헤더 정렬을 열어두면 antd 가 정렬 중인 열의 헤더·셀에 배경색을 입혀
 * 그 열만 다른 색으로 보이는데, 계약 목록에는 필드별 정렬 요구가 없다.
 */
const FIXED_SORT = 'contractedAt,desc';

/**
 * 기간 필터는 계약일 기준 하나로 고정한다 (현업 확정 2026-07-31).
 * 완료 예정일로 훑는 일은 제작·납기 화면에서 하지, 계약 조회에서 하지 않는다.
 */
const FIXED_DATE_FIELD = 'contractedAt' as const;

/** 기본 조회 기간: 최근 1개월 (현업 확정 2026-07-31) */
const defaultRange = (): [Dayjs, Dayjs] => [dayjs().subtract(1, 'month'), dayjs()];

/** URL 쿼리 ↔ 필터 상태 */
interface Filters {
  q: string;
  dateFrom?: string;
  dateTo?: string;
  status?: ContractStatus;
  contractTypeId?: string;
  page: number;
  size: number;
}

function readFilters(params: URLSearchParams): Filters {
  const [from, to] = defaultRange();
  const rawStatus = params.get('status');
  return {
    q: params.get('q') ?? '',
    dateFrom: params.get('dateFrom') ?? from.format('YYYY-MM-DD'),
    dateTo: params.get('dateTo') ?? to.format('YYYY-MM-DD'),
    // 기본은 전체 — 파라미터가 없거나 ALL이면 상태로 좁히지 않는다.
    status: rawStatus && rawStatus !== STATUS_ALL ? (rawStatus as ContractStatus) : undefined,
    contractTypeId: params.get('contractTypeId') ?? undefined,
    page: Number(params.get('page') ?? 1),
    size: Number(params.get('size') ?? 30),
  };
}

function writeFilters(filters: Filters): Record<string, string> {
  const entries: [string, string | undefined | boolean | number][] = [
    ['q', filters.q || undefined],
    ['dateFrom', filters.dateFrom],
    ['dateTo', filters.dateTo],
    // 전체(undefined)는 URL에서 뺀다 — 기본값이 전체라 없는 것과 같은 뜻이다.
    ['status', filters.status],
    ['contractTypeId', filters.contractTypeId],
    ['page', filters.page > 1 ? filters.page : undefined],
    ['size', filters.size !== 30 ? filters.size : undefined],
  ];
  return Object.fromEntries(
    entries.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
  );
}

interface ContractListProps {
  /** 지정 시 이 고객의 계약만 조회(고객모드 임베드용) */
  customerId?: string;
  /** 임베드 모드: 필터·통계·검색 크롬 없이 표만 렌더, 고객 열 숨김 */
  embedded?: boolean;
}

export function ContractListPage({
  customerId: embeddedCustomerId,
  embedded = false,
}: ContractListProps = {}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const customerMode = useModeStore((s) => s.mode) === 'CUSTOMER';

  // 검색어는 입력 중 URL을 바꾸지 않도록 로컬 상태로 둔다.
  const [keyword, setKeyword] = useState(filters.q);

  const update = (patch: Partial<Filters>) => {
    // 조건이 바뀌면 첫 페이지로 되돌린다(페이지 이동만 예외).
    const nextPage = patch.page ?? 1;
    setSearchParams(writeFilters({ ...filters, ...patch, page: nextPage }));
  };

  // 임베드(고객모드)에서는 기간·검색 필터 없이 해당 고객 전체 계약을 최신순으로.
  const params: ContractSearchParams = embedded
    ? { customerId: embeddedCustomerId, sort: FIXED_SORT, page: 1, size: 100 }
    : {
        q: filters.q || undefined,
        dateField: FIXED_DATE_FIELD,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        status: filters.status,
        contractTypeId: filters.contractTypeId,
        sort: FIXED_SORT,
        page: filters.page,
        size: filters.size,
      };

  const { data, isFetching } = useQuery({
    queryKey: ['contracts', 'list', params],
    queryFn: () => fetchContracts(params),
  });

  const typesQuery = useQuery({
    queryKey: ['contract-types', { includeInactive: false }],
    queryFn: () => fetchContractTypes(false),
  });

  /*
   * 스타일 확정·맞춤/렌탈 상태·진행률은 계약 목록 API에 없는 값이라, 컨설팅·제작 화면과
   * 같은 소스를 전체 조회해 contractId로 맞춰 붙인다(다른 목록들도 전부 전체 조회 후
   * 클라이언트에서 묶는다). 임베드(고객모드)에는 붙이지 않으므로 그때는 조회도 건너뛴다.
   */
  const derivedEnabled = !embedded;
  const optionsQuery = useQuery({
    queryKey: ['options', 'progress', 'all'],
    queryFn: () => fetchOptionProgress(),
    enabled: derivedEnabled,
  });
  const rentalsQuery = useQuery({
    queryKey: ['rental-selections', 'progress', 'all'],
    queryFn: () => fetchRentalSelectionProgress(),
    enabled: derivedEnabled,
  });
  const productionQuery = useQuery({
    queryKey: ['production', 'items', 'all'],
    queryFn: () => fetchProductionItems(),
    enabled: derivedEnabled,
  });

  // 계약별 스타일 확정 집계(확정 수/분모) — 스타일 컨설팅 목록과 같은 groupByContract를 그대로
  // 재사용해 두 화면의 "스타일 확정"이 항상 일치하게 한다.
  const styleConfirmMap = useMemo(() => {
    const map = new Map<string, { confirmed: number; total: number }>();
    for (const r of groupStyleByContract(optionsQuery.data ?? [], rentalsQuery.data ?? [])) {
      map.set(r.contractId, { confirmed: r.confirmedCount, total: r.itemCount });
    }
    return map;
  }, [optionsQuery.data, rentalsQuery.data]);

  // 계약별 맞춤/렌탈 상태와 진행률 — 제작 목록·상세와 같은 계산(production-*)을 그대로 쓴다.
  const productionMap = useMemo(() => {
    const byContract = new Map<string, ProductionItem[]>();
    for (const it of productionQuery.data ?? []) {
      const list = byContract.get(it.contractId) ?? [];
      list.push(it);
      byContract.set(it.contractId, list);
    }
    const out = new Map<string, { stages: ContractProductionStages; progress: ContractTrackProgress }>();
    for (const [contractId, list] of byContract) {
      out.set(contractId, {
        stages: contractProductionStages(list),
        progress: contractTrackProgress(list),
      });
    }
    return out;
  }, [productionQuery.data]);

  const resetFilters = () => {
    setKeyword('');
    const [from, to] = defaultRange();
    setSearchParams(
      writeFilters({
        q: '',
        dateFrom: from.format('YYYY-MM-DD'),
        dateTo: to.format('YYYY-MM-DD'),
        status: undefined,
        page: 1,
        size: 30,
      }),
    );
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

  /** 표 변경은 페이지 이동만 반영한다(정렬 고정 — FIXED_SORT). */
  const handleTableChange = (pagination: TablePaginationConfig) => {
    update({
      page: pagination.current ?? 1,
      size: pagination.pageSize ?? filters.size,
    });
  };

  /**
   * 정렬 기준(스타일 컨설팅·채촌 목록과 동일):
   * - 왼쪽이 기본. 금액만 오른쪽. 가운데는 폭이 좁게 고정된 숫자 열에만 쓴다
   *   (넓은 열을 가운데 두면 값이 빈 칸 한가운데 떠서 시작 기준선이 어긋난다).
   *
   * 폭은 뜻이 같은 열끼리 같게 고정한다 — COL 참고.
   */
  const columns: ColumnsType<ContractListItem> = [
    // 열 순서는 현업이 읽는 순서다:
    // 누구의(고객) 무슨(계약 구분) 무엇을(품목 구성) 언제(계약일) 시작해 언제(완료 예정일)
    // 끝나고 얼마(계약금액)이며 지금 어디까지 왔나 — 계약 상태·스타일 확정·맞춤/렌탈 상태·진행률.
    // 계약번호는 참고용이라 자기 열 없이 계약 구분 아래에 붙인다.
    {
      title: '고객',
      dataIndex: 'customerName',
      width: COL.name,
      render: (name: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.customerPhone || '-'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '계약 구분',
      dataIndex: 'contractTypeName',
      width: COL.code,
      // 계약번호는 참고용이라 자기 열을 주지 않고 계약 구분 아래에 붙인다(고객 열의 전화번호와 같은 방식).
      render: (name: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.contractNo}
          </Typography.Text>
        </Space>
      ),
      // 필터 버튼을 제목 글자 바로 옆에 배치 (index.css의 tx-type-filter-col) — 서버(contractTypeId)로 필터링
      className: 'tx-type-filter-col',
      filteredValue: filters.contractTypeId ? [filters.contractTypeId] : null,
      filterIcon: (filtered) => <FilterOutlined style={{ color: filtered ? '#1677ff' : undefined }} />,
      filterDropdown: ({ confirm }) => (
        <div style={{ padding: 8, maxHeight: 320, overflowY: 'auto' }}>
          <Radio.Group
            value={filters.contractTypeId ?? 'ALL'}
            onChange={(e) => {
              const v = e.target.value as string;
              update({ contractTypeId: v === 'ALL' ? undefined : v });
              confirm({ closeDropdown: true });
            }}
          >
            <Space direction="vertical">
              <Radio value="ALL">전체</Radio>
              {(typesQuery.data ?? []).map((t) => (
                <Radio key={t.id} value={t.id}>
                  {t.name}
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </div>
      ),
    },
    {
      // 스타일 컨설팅 목록의 "품목 구성" 열과 같은 규칙:
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
    {
      title: '계약일',
      dataIndex: 'contractedAt',
      width: COL.name,
      // 계약일은 계약완료 시점에 정해진다. 그 전에는 빈 칸 대신 작성일을 보여 준다(기간 필터 기준과 동일).
      // 작성일임을 "(작성)"으로 덧붙이거나 흐리게 쓰지 않는다 — 작성중인지는 상태 열이 이미 말한다.
      render: (v: string | undefined, row) => v ?? row.createdAt ?? '-',
    },
    {
      title: '완료 예정일',
      dataIndex: 'completionDueDate',
      width: COL.name,
      render: (v?: string) => v ?? '-',
    },
    {
      title: '계약금액',
      dataIndex: 'totalAmount',
      width: COL.name,
      align: 'right',
      // 우측 정렬한 금액이 바로 옆 계약 상태 배지에 붙어 보여, 셀·헤더 오른쪽에 여백을 더해 띄운다.
      onCell: () => ({ style: { paddingRight: 32 } }),
      onHeaderCell: () => ({ style: { paddingRight: 32 } }),
      render: formatKrw,
    },
    {
      title: '계약 상태',
      dataIndex: 'status',
      width: COL.status,
      // 수정하기(버전업)를 거친 계약은 상태만 보면 신규 작성건과 구분되지 않는다 → 버전을 함께 보여준다.
      render: (v: string, row) => {
        const meta = metaOf(CONTRACT_STATUS_META, v);
        return (
          <Space size={4}>
            <StatusBadge label={meta.label} color={meta.color} />
            {(row.currentVersionNo ?? 1) > 1 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                v{row.currentVersionNo}
              </Typography.Text>
            )}
          </Space>
        );
      },
    },
    {
      // 스타일 컨설팅 목록의 "스타일 확정" 열과 100% 같은 값 — 그 목록의 판정을 그대로 옮긴다:
      // 확정 수가 분모(전체 품목)와 같으면 확정 완료, 아니면 진행중(2단계).
      // 컨설팅 목록은 맞춤 옵션이 있는 계약만 세우므로, 맵에 없는 계약(렌탈전용·품목미등록)은 대기다.
      title: '스타일 확정',
      key: 'styleConfirm',
      width: COL.status,
      render: (_, row) => {
        const c = styleConfirmMap.get(row.id);
        if (!c) return <StatusBadge label="대기" color="default" />;
        return c.confirmed === c.total ? (
          <StatusBadge label="확정 완료" color="green" />
        ) : (
          <StatusBadge label="진행중" color="gold" />
        );
      },
    },
    {
      // 제작 관리 목록의 "맞춤/렌탈 상태" 열과 같은 값 — 트랙별 현재 단계(품목 상태에서 유도).
      // 아직 제작(주문)이 없는 계약은 미시작으로 둔다.
      title: '맞춤/렌탈 상태',
      key: 'productionStages',
      width: COL.status,
      render: (_, row) => {
        const p = productionMap.get(row.id);
        const badge = (state: string, prefix?: string) => (
          <StatusBadge
            label={prefix ? `${prefix} · ${state}` : state}
            color={state === '완료' ? 'green' : 'blue'}
          />
        );
        if (!p) return <StatusBadge label="미시작" color="default" />;
        const { custom, rental } = p.stages;
        if (custom && rental) {
          return (
            <Space direction="vertical" size={2}>
              {badge(custom, '맞춤')}
              {badge(rental, '렌탈')}
            </Space>
          );
        }
        const only = custom ?? rental;
        return only ? badge(only) : <StatusBadge label="미시작" color="default" />;
      },
    },
    {
      // 제작 관리 목록·상세·흐름 카드와 같은 단계 기반 진행률(준비 제외, 트랙별).
      title: '진행률',
      key: 'progress',
      width: COL.wide,
      render: (_, row) => {
        const p = productionMap.get(row.id);
        if (!p) return <Typography.Text type="secondary">미시작</Typography.Text>;
        return <TrackProgressBars progress={p.progress} />;
      },
    },
  ];

  /**
   * 작성중(DRAFT)은 아직 작성 중인 계약서다 — 상세 대신 수정(작성) 화면으로 바로 연다.
   * 확정된 계약만 상세로 간다. 고객모드는 예외(고객 화면에서 작성 폼을 열지 않는다).
   */
  const rowPath = (row: ContractListItem) =>
    row.status === 'DRAFT' && !customerMode
      ? `/contracts/new?contractId=${row.id}`
      : `/contracts/${row.id}`;

  // 임베드(고객모드): 크롬 없이 표만. 고객 열은 숨기고(단일 고객 컨텍스트),
  // 컨설팅·제작에서 끌어오는 파생 열(스타일 확정·맞춤/렌탈 상태·진행률)도 붙이지 않는다.
  const embeddedHiddenKeys = new Set(['styleConfirm', 'productionStages', 'progress']);
  if (embedded) {
    return (
      <Table<ContractListItem>
        rowKey="id"
        size="small"
        loading={isFetching}
        columns={columns.filter(
          (c) => c.title !== '고객' && !(c.key != null && embeddedHiddenKeys.has(String(c.key))),
        )}
        dataSource={data?.data ?? []}
        scroll={{ x: 'max-content' }}
        onRow={(record) => ({
          onClick: () => navigate(rowPath(record)),
          style: { cursor: 'pointer' },
        })}
        pagination={false}
        locale={{ emptyText: '계약이 없습니다.' }}
      />
    );
  }

  return (
    <PageShell>
      <PageCard>
        {/*
          필터는 공용 ListToolbar 규격을 따른다 — 라벨 없이 placeholder로 뜻을 전하고,
          폭은 12칸 그리드가 아니라 내용에 맞춰 고정한 뒤 좁아지면 자연 줄바꿈시킨다.
          순서는 현업이 찾는 순서다: 고객 → 기간 → 계약 구분 → 상태 → 초기화 (현업 확정 2026-07-31).
        */}
        <ListToolbar
          filters={
            <>
              {/*
                고객 선택은 이 입력 하나로 끝낸다 — 고객명·전화번호가 키워드 검색에 걸리므로
                따로 고객 찾기 팝업을 띄울 이유가 없다 (현업 확정 2026-07-31).
              */}
              <Input.Search
                allowClear
                style={{ width: LAYOUT.searchWidth }}
                placeholder="고객명 · 전화번호 · 계약번호"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onSearch={(value) => update({ q: value.trim() })}
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
              <Select
                allowClear
                style={{ width: LAYOUT.filterWidth }}
                placeholder="계약 구분 전체"
                value={filters.contractTypeId}
                onChange={(v?: string) => update({ contractTypeId: v })}
                options={(typesQuery.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
              />
              {/*
                상태는 셀렉트 한 칸으로 고른다 — 검색 조건 줄을 계약 구분과 같은
                모양으로 맞춘다 (현업 확정 2026-07-31). 기본값은 전체이고,
                allowClear 대신 "전체" 항목을 둔다(지우기와 전체가 같은 뜻이라 항목이 낫다).
              */}
              <Select
                style={{ width: LAYOUT.filterWidth }}
                value={filters.status ?? STATUS_ALL}
                onChange={(v: string) =>
                  update({ status: v === STATUS_ALL ? undefined : (v as ContractStatus) })
                }
                options={STATUS_OPTIONS}
              />
              <Button icon={<ReloadOutlined />} onClick={resetFilters}>
                초기화
              </Button>
            </>
          }
          actions={
            <Can permission="CONTRACT_CREATE">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/contracts/new')}>
                신규 계약
              </Button>
            </Can>
          }
        />
      </PageCard>

      <PageCard>
        <DataTable<ContractListItem>
          rowKey="id"
          loading={isFetching}
          columns={columns}
          dataSource={data?.data ?? []}
          onChange={handleTableChange}
          onRow={(record) => ({
            onClick: () => navigate(rowPath(record)),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: filters.page,
            pageSize: filters.size,
            total: data?.page.totalElements ?? 0,
          }}
          locale={{ emptyText: '조회 조건에 해당하는 계약이 없습니다.' }}
        />
      </PageCard>
    </PageShell>
  );
}
