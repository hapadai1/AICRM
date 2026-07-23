/**
 * 계약 목록 — 계약·수금 현황 조회 화면 (개편계획 06)
 * - 진입점은 고객과 기간: 기간 기준 선택 + 통합검색 + 고객 검색 팝업
 * - 컬럼에 실수납액·미수금·최근 결제일을 실어 상세로 들어가지 않아도 수금 상태가 보인다
 * - 필터는 URL 쿼리에 동기화한다(새로고침·뒤로가기·링크 공유 보존)
 */
import { CreditCardOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, UserOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Flex,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import type { SorterResult } from 'antd/es/table/interface';
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
import { Can } from '../../shared/Can';
import { CustomerPickerModal } from '../../shared/CustomerPickerModal';
import type { PickedCustomer } from '../../shared/CustomerPickerModal';
import { StatusBadge } from '../../shared/StatusBadge';
import { CONTRACT_STATUS_META, formatKrw, metaOf } from './labels';

const { RangePicker } = DatePicker;

/**
 * 필터 옵션은 백엔드가 허용하는 상태만 사용한다.
 * 라벨 맵 전체(COMPLETED 포함)를 옵션으로 쓰면 400을 받는다.
 */
const STATUS_OPTIONS = CONTRACT_FILTER_STATUSES.map((value) => ({
  value,
  label: metaOf(CONTRACT_STATUS_META, value).label,
}));

type DateField = NonNullable<ContractSearchParams['dateField']>;

const DATE_FIELD_OPTIONS: { value: DateField; label: string }[] = [
  { value: 'contractedAt', label: '계약일' },
  { value: 'paymentDate', label: '결제일' },
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
  unpaidOnly: boolean;
  customerId?: string;
  customerLabel?: string;
  sort: string;
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
    unpaidOnly: params.get('unpaidOnly') === 'true',
    customerId: params.get('customerId') ?? undefined,
    customerLabel: params.get('customerLabel') ?? undefined,
    sort: params.get('sort') ?? 'contractedAt,desc',
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
    ['unpaidOnly', filters.unpaidOnly ? 'true' : undefined],
    ['customerId', filters.customerId],
    ['customerLabel', filters.customerLabel],
    ['sort', filters.sort],
    ['page', filters.page > 1 ? filters.page : undefined],
    ['size', filters.size !== 30 ? filters.size : undefined],
  ];
  return Object.fromEntries(
    entries.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
  );
}

export function ContractListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);

  // 검색어는 입력 중 URL을 바꾸지 않도록 로컬 상태로 둔다.
  const [keyword, setKeyword] = useState(filters.q);
  const [pickerOpen, setPickerOpen] = useState(false);

  const update = (patch: Partial<Filters>) => {
    // 조건이 바뀌면 첫 페이지로 되돌린다(페이지 이동만 예외).
    const nextPage = patch.page ?? 1;
    setSearchParams(writeFilters({ ...filters, ...patch, page: nextPage }));
  };

  const params: ContractSearchParams = {
    q: filters.customerId ? undefined : filters.q || undefined,
    customerId: filters.customerId,
    dateField: filters.dateField,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    status: filters.status,
    contractTypeId: filters.contractTypeId,
    unpaidOnly: filters.unpaidOnly,
    sort: filters.sort,
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
        unpaidOnly: false,
        sort: 'contractedAt,desc',
        page: 1,
        size: 30,
      }),
    );
  };

  /** 표 헤더 정렬 → `필드,방향` 파라미터 */
  const handleTableChange = (
    pagination: TablePaginationConfig,
    _f: unknown,
    sorter: SorterResult<ContractListItem> | SorterResult<ContractListItem>[],
  ) => {
    const single = Array.isArray(sorter) ? sorter[0] : sorter;
    const field = single?.field as string | undefined;
    const sort = field && single?.order ? `${field},${single.order === 'ascend' ? 'asc' : 'desc'}` : filters.sort;
    update({
      sort,
      page: pagination.current ?? 1,
      size: pagination.pageSize ?? filters.size,
    });
  };

  const [sortField, sortDirection] = filters.sort.split(',');
  const orderOf = (field: string) =>
    sortField === field ? (sortDirection === 'asc' ? ('ascend' as const) : ('descend' as const)) : null;

  const columns: ColumnsType<ContractListItem> = [
    // 진입점은 사람이 아는 정보(고객·계약일). 계약번호는 참고용으로 맨 뒤에 둔다.
    {
      title: '고객',
      dataIndex: 'customerName',
      width: 150,
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
      width: 110,
      sorter: true,
      sortOrder: orderOf('contractedAt'),
      render: (v?: string) => v ?? '-',
    },
    { title: '계약 구분', dataIndex: 'contractTypeName', width: 150 },
    {
      title: '상태',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => {
        const meta = metaOf(CONTRACT_STATUS_META, v);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    {
      title: '계약금액',
      dataIndex: 'totalAmount',
      width: 130,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('totalAmount'),
      render: formatKrw,
    },
    {
      title: '수납액',
      dataIndex: 'paidAmount',
      width: 130,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('paidAmount'),
      render: (v: number) => <Typography.Text type="success">{formatKrw(v)}</Typography.Text>,
    },
    {
      title: '미수금',
      dataIndex: 'unpaidAmount',
      width: 140,
      align: 'right',
      sorter: true,
      sortOrder: orderOf('unpaidAmount'),
      // 색만으로 구분하지 않고 과납은 태그로 병기한다 (구현표준 §2)
      render: (v: number) =>
        v > 0 ? (
          <Typography.Text type="danger">{formatKrw(v)}</Typography.Text>
        ) : v < 0 ? (
          <Space size={4}>
            <Typography.Text>{formatKrw(-v)}</Typography.Text>
            <Tag color="orange">과납</Tag>
          </Space>
        ) : (
          <Typography.Text type="secondary">완납</Typography.Text>
        ),
    },
    {
      title: '최근 결제일',
      dataIndex: 'lastPaymentDate',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '완료 예정일',
      dataIndex: 'completionDueDate',
      width: 110,
      sorter: true,
      sortOrder: orderOf('completionDueDate'),
      render: (v?: string) => v ?? '-',
    },
    {
      title: '계약번호',
      dataIndex: 'contractNo',
      width: 165,
      render: (v: string, row) => (
        <Space size={4}>
          <Typography.Text type="secondary">{v}</Typography.Text>
          <Tooltip title="이 계약의 결제 관리로 이동">
            <Button
              size="small"
              type="text"
              icon={<CreditCardOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/payments?contractId=${row.id}`);
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  const totals = data?.totals;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 16 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            목록
          </Typography.Title>
          <Space wrap>
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
          </Space>
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
          <Col xs={12} md={4}>
            <Checkbox
              checked={filters.unpaidOnly}
              onChange={(e) => update({ unpaidOnly: e.target.checked })}
            >
              미수금만
            </Checkbox>
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
      </Card>

      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="계약 건수" value={totals?.count ?? 0} suffix="건" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="계약금액 합계" value={totals?.totalAmount ?? 0} suffix="원" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="수납액 합계"
              value={totals?.paidAmount ?? 0}
              suffix="원"
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="미수금 합계"
              value={totals?.unpaidAmount ?? 0}
              suffix="원"
              valueStyle={{ color: (totals?.unpaidAmount ?? 0) > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Table<ContractListItem>
          rowKey="id"
          size="small"
          loading={isFetching}
          columns={columns}
          dataSource={data?.data ?? []}
          scroll={{ x: 1400 }}
          onChange={handleTableChange}
          onRow={(record) => ({
            onClick: () => navigate(`/contracts/${record.id}`),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: filters.page,
            pageSize: filters.size,
            total: data?.page.totalElements ?? 0,
            showSizeChanger: true,
            pageSizeOptions: ['30', '50', '100'],
            showTotal: (total) => `총 ${total}건`,
          }}
          locale={{ emptyText: '조회 조건에 해당하는 계약이 없습니다.' }}
        />
      </Card>

      <CustomerPickerModal
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onSelect={handlePickCustomer}
        initialKeyword={keyword}
        title="고객 검색 — 계약 조회"
      />
    </Space>
  );
}
