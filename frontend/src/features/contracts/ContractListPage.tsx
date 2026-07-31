/**
 * 계약 목록 — 계약 현황 조회 화면 (개편계획 06)
 * - 진입점은 고객과 기간: 기간 기준 선택 + 통합검색 + 고객 검색 팝업
 * - 필터는 URL 쿼리에 동기화한다(새로고침·뒤로가기·링크 공유 보존)
 */
import { FilterOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, UserOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Col,
  DatePicker,
  Flex,
  Input,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
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
import { DataTable, PAGE_SIZE_OPTIONS } from '../../shared/DataTable';
import { PageCard, PageShell } from '../../shared/PageShell';
import { CustomerPickerModal } from '../../shared/CustomerPickerModal';
import type { PickedCustomer } from '../../shared/CustomerPickerModal';
import { StatusBadge } from '../../shared/StatusBadge';
import { autoWidth } from '../../shared/table-width';
import { CONTRACT_STATUS_META, formatKrw, metaOf } from './labels';

const { RangePicker } = DatePicker;

/** 필터 옵션은 백엔드가 허용하는 상태만 사용한다(CONTRACT_STATUSES 와 동일). */
const STATUS_OPTIONS = CONTRACT_FILTER_STATUSES.map((value) => ({
  value,
  label: metaOf(CONTRACT_STATUS_META, value).label,
}));

type DateField = NonNullable<ContractSearchParams['dateField']>;

/**
 * 정렬은 계약일 최신순으로 고정한다(관리자·고객모드 동일).
 * 표 헤더 정렬을 열어두면 antd 가 정렬 중인 열의 헤더·셀에 배경색을 입혀
 * 그 열만 다른 색으로 보이는데, 계약 목록에는 필드별 정렬 요구가 없다.
 */
const FIXED_SORT = 'contractedAt,desc';

const DATE_FIELD_OPTIONS: { value: DateField; label: string }[] = [
  { value: 'contractedAt', label: '계약일' },
  { value: 'completionDueDate', label: '완료 예정일' },
];

/** 기본 조회 기간: 최근 3개월 */
const defaultRange = (): [Dayjs, Dayjs] => [dayjs().subtract(3, 'month'), dayjs()];

/** URL 쿼리 ↔ 필터 상태 */
interface Filters {
  q: string;
  dateField: DateField;
  dateFrom?: string;
  dateTo?: string;
  status?: ContractStatus;
  contractTypeId?: string;
  customerId?: string;
  customerLabel?: string;
  page: number;
  size: number;
}

function readFilters(params: URLSearchParams): Filters {
  const [from, to] = defaultRange();
  return {
    q: params.get('q') ?? '',
    dateField: (params.get('dateField') as DateField | null) ?? 'contractedAt',
    dateFrom: params.get('dateFrom') ?? from.format('YYYY-MM-DD'),
    dateTo: params.get('dateTo') ?? to.format('YYYY-MM-DD'),
    status: (params.get('status') as ContractStatus | null) ?? undefined,
    contractTypeId: params.get('contractTypeId') ?? undefined,
    customerId: params.get('customerId') ?? undefined,
    customerLabel: params.get('customerLabel') ?? undefined,
    page: Number(params.get('page') ?? 1),
    size: Number(params.get('size') ?? 30),
  };
}

function writeFilters(filters: Filters): Record<string, string> {
  const entries: [string, string | undefined | boolean | number][] = [
    ['q', filters.q || undefined],
    ['dateField', filters.dateField],
    ['dateFrom', filters.dateFrom],
    ['dateTo', filters.dateTo],
    ['status', filters.status],
    ['contractTypeId', filters.contractTypeId],
    ['customerId', filters.customerId],
    ['customerLabel', filters.customerLabel],
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
  const [pickerOpen, setPickerOpen] = useState(false);

  const update = (patch: Partial<Filters>) => {
    // 조건이 바뀌면 첫 페이지로 되돌린다(페이지 이동만 예외).
    const nextPage = patch.page ?? 1;
    setSearchParams(writeFilters({ ...filters, ...patch, page: nextPage }));
  };

  // 임베드(고객모드)에서는 기간·검색 필터 없이 해당 고객 전체 계약을 최신순으로.
  const params: ContractSearchParams = embedded
    ? { customerId: embeddedCustomerId, sort: FIXED_SORT, page: 1, size: 100 }
    : {
        q: filters.customerId ? undefined : filters.q || undefined,
        customerId: filters.customerId,
        dateField: filters.dateField,
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

  const handlePickCustomer = (customer: PickedCustomer) => {
    update({ customerId: customer.id, customerLabel: `${customer.name} (${customer.phone})`, q: '' });
    setKeyword('');
    setPickerOpen(false);
  };

  const resetFilters = () => {
    setKeyword('');
    const [from, to] = defaultRange();
    setSearchParams(
      writeFilters({
        q: '',
        dateField: 'contractedAt',
        dateFrom: from.format('YYYY-MM-DD'),
        dateTo: to.format('YYYY-MM-DD'),
        page: 1,
        size: 30,
      }),
    );
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
   * 폭은 고정하지 않는다 — autoWidth() 참고.
   */
  const columns: ColumnsType<ContractListItem> = [
    // 진입점은 사람이 아는 정보(고객·계약일). 계약번호는 참고용으로 맨 뒤에 둔다.
    {
      title: '고객',
      dataIndex: 'customerName',
      ...autoWidth(140),
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
      title: '계약일',
      dataIndex: 'contractedAt',
      ...autoWidth(),
      // 계약일은 계약완료 시점에 정해진다. 그 전에는 빈 칸 대신 작성일을 보여 준다(기간 필터 기준과 동일).
      render: (v: string | undefined, row) =>
        v ?? (row.createdAt ? <Typography.Text type="secondary">{row.createdAt} (작성)</Typography.Text> : '-'),
    },
    {
      title: '계약 구분',
      dataIndex: 'contractTypeName',
      ...autoWidth(110),
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
      title: '상태',
      dataIndex: 'status',
      ...autoWidth(),
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
      title: '계약금액',
      dataIndex: 'totalAmount',
      ...autoWidth(),
      align: 'right',
      render: formatKrw,
    },
    {
      title: '완료 예정일',
      dataIndex: 'completionDueDate',
      ...autoWidth(),
      render: (v?: string) => v ?? '-',
    },
    {
      title: '계약번호',
      dataIndex: 'contractNo',
      ...autoWidth(),
      render: (v: string) => <Typography.Text type="secondary">{v}</Typography.Text>,
    },
  ];

  const totals = data?.totals;

  /**
   * 작성중(DRAFT)은 아직 작성 중인 계약서다 — 상세 대신 수정(작성) 화면으로 바로 연다.
   * 확정된 계약만 상세로 간다. 고객모드는 예외(고객 화면에서 작성 폼을 열지 않는다).
   */
  const rowPath = (row: ContractListItem) =>
    row.status === 'DRAFT' && !customerMode
      ? `/contracts/new?contractId=${row.id}`
      : `/contracts/${row.id}`;

  // 임베드(고객모드): 크롬 없이 표만. 고객 열은 숨긴다(단일 고객 컨텍스트).
  if (embedded) {
    return (
      <Table<ContractListItem>
        rowKey="id"
        size="small"
        loading={isFetching}
        columns={columns.filter((c) => c.title !== '고객')}
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
        <Flex justify="flex-end" wrap gap={8} style={{ marginBottom: 16 }}>
          <Can permission="CONTRACT_TYPE_EDIT">
            <Button icon={<SettingOutlined />} onClick={() => navigate('/admin/contract-types')}>
              계약 구분 관리
            </Button>
          </Can>
          <Can permission="CONTRACT_CREATE">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/contracts/new')}>
              신규 계약
            </Button>
          </Can>
        </Flex>

        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} md={4}>
            <Select<DateField>
              style={{ width: '100%' }}
              value={filters.dateField}
              onChange={(v) => update({ dateField: v })}
              options={DATE_FIELD_OPTIONS}
            />
          </Col>
          <Col xs={24} md={8}>
            <RangePicker
              style={{ width: '100%' }}
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
          </Col>
          <Col xs={24} md={12}>
            {filters.customerId ? (
              <Space>
                <Tag
                  color="blue"
                  closable
                  onClose={() => update({ customerId: undefined, customerLabel: undefined })}
                  style={{ padding: '4px 8px', fontSize: 14 }}
                >
                  <UserOutlined /> {filters.customerLabel ?? '선택한 고객'}
                </Tag>
                <Button size="small" onClick={() => setPickerOpen(true)}>
                  변경
                </Button>
              </Space>
            ) : (
              <Space.Compact style={{ width: '100%' }}>
                <Input.Search
                  allowClear
                  placeholder="계약번호 · 고객명 · 전화번호 · 계약 구분"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onSearch={(value) => update({ q: value.trim() })}
                />
                <Button icon={<UserOutlined />} onClick={() => setPickerOpen(true)}>
                  고객 찾기
                </Button>
              </Space.Compact>
            )}
          </Col>
          <Col xs={12} md={5}>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder="계약 구분 전체"
              value={filters.contractTypeId}
              onChange={(v?: string) => update({ contractTypeId: v })}
              options={(typesQuery.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
            />
          </Col>
          <Col xs={12} md={4}>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder="상태 전체"
              options={STATUS_OPTIONS}
              value={filters.status}
              onChange={(v?: ContractStatus) => update({ status: v })}
            />
          </Col>
          <Col xs={12} md={11}>
            <Space>
              <Button icon={<ReloadOutlined />} onClick={resetFilters}>
                초기화
              </Button>
              <Typography.Text type="secondary">기본 조회 기간은 최근 3개월입니다.</Typography.Text>
            </Space>
          </Col>
        </Row>
      </PageCard>

      {/*
        건수·금액을 카드 두 장으로 나눠 두면 두 장이 왼쪽 절반에만 몰리고 오른쪽이 통째로 비었다.
        같은 조회 결과의 요약이므로 한 장 안에 나란히 둔다.
      */}
      <PageCard>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic title="계약 건수" value={totals?.count ?? 0} suffix="건" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="계약금액 합계" value={totals?.totalAmount ?? 0} suffix="원" />
          </Col>
        </Row>
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
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showTotal: (total) => `총 ${total}건`,
          }}
          locale={{ emptyText: '조회 조건에 해당하는 계약이 없습니다.' }}
        />
      </PageCard>

      <CustomerPickerModal
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onSelect={handlePickCustomer}
        initialKeyword={keyword}
        title="고객 검색 — 계약 조회"
      />
    </PageShell>
  );
}
