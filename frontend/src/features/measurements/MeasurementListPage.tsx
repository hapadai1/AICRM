/**
 * MEAS-001 채촌 목록 — 고객·날짜로 검색하는 독립 화면 (설계서 09 §4.1).
 * 고객을 고르지 않아도 전체 채촌이 최신 채촌일 순으로 보인다.
 */
import { CopyOutlined, DeleteOutlined, DiffOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  MEASUREMENT_TYPE_LABELS,
  cloneMeasurement,
  deleteMeasurement,
  fetchMeasurementList,
  type MeasurementListParams,
  type MeasurementSessionStatus,
  type MeasurementSummary,
  type MeasurementType,
} from '../../api/measurements';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { labelOf, metaOf } from '../../shared/status-meta';
import { MEASUREMENT_STATUS_META, MEASUREMENT_TYPE_META } from './meas-meta';

const TYPE_OPTIONS = Object.entries(MEASUREMENT_TYPE_LABELS).map(([value, label]) => ({ value, label }));
const STATUS_OPTIONS = [
  { value: 'DRAFT', label: '작성중' },
  { value: 'COMPLETED', label: '완료' },
];

/** 검색 폼 입력값 (적용 전) */
interface FilterState {
  q: string;
  range: [Dayjs, Dayjs] | null;
  type?: MeasurementType;
  status?: MeasurementSessionStatus;
}

const EMPTY_FILTER: FilterState = { q: '', range: null, type: undefined, status: undefined };

export function MeasurementListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const customerId = searchParams.get('customerId') ?? undefined;

  const [form, setForm] = useState<FilterState>(EMPTY_FILTER);
  const [applied, setApplied] = useState<FilterState>(EMPTY_FILTER);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const params: MeasurementListParams = {
    q: applied.q || undefined,
    customerId,
    dateFrom: applied.range?.[0]?.format('YYYY-MM-DD'),
    dateTo: applied.range?.[1]?.format('YYYY-MM-DD'),
    type: applied.type,
    status: applied.status,
    page,
    size,
  };

  const listQuery = useQuery({
    queryKey: ['measurements', 'list', params],
    queryFn: () => fetchMeasurementList(params),
  });

  const rows = listQuery.data?.items ?? [];
  const selectedRows = rows.filter((r) => selectedIds.includes(r.id));
  // 비교는 같은 고객의 두 기록만 (설계서 09 §4.1)
  const sameCustomer =
    selectedRows.length === 2 && selectedRows[0]!.customerId === selectedRows[1]!.customerId;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['measurements'] });

  const cloneMutation = useMutation({
    mutationFn: (id: string) => cloneMeasurement(id),
    onSuccess: (created) => {
      message.success(`V${created.versionNo}로 복사했습니다. 값을 수정한 뒤 완료해 주세요.`);
      void invalidate();
      navigate(`/measurements/${created.id}`);
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '복사에 실패했습니다.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMeasurement(id),
    onSuccess: () => {
      message.success('채촌 기록을 삭제했습니다.');
      setSelectedIds([]);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '삭제에 실패했습니다.'),
  });

  const confirmDelete = (row: MeasurementSummary) => {
    modal.confirm({
      title: '이 채촌 기록을 삭제할까요?',
      okText: '삭제',
      okButtonProps: { danger: true },
      cancelText: '취소',
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>
            {row.customerName} · {row.measurementDate} · V{row.versionNo} (
            {labelOf(MEASUREMENT_TYPE_LABELS, row.measurementType)})
          </Typography.Text>
          {row.linkedOrderItems.length > 0 && (
            <Typography.Text type="warning">
              사용 중인 품목 {row.linkedOrderItems.map((i) => i.displayName).join(', ')} 의 연결이 함께
              해제됩니다.
            </Typography.Text>
          )}
          <Typography.Text type="secondary">삭제한 기록은 복구할 수 없습니다.</Typography.Text>
        </Space>
      ),
      onOk: () => deleteMutation.mutateAsync(row.id),
    });
  };

  const handleSearch = () => {
    setApplied(form);
    setPage(1);
    setSelectedIds([]);
  };

  const handleReset = () => {
    setForm(EMPTY_FILTER);
    setApplied(EMPTY_FILTER);
    setPage(1);
    setSelectedIds([]);
    setSearchParams({});
  };

  const handleCompare = () => {
    if (!sameCustomer) return;
    const [a, b] = [...selectedRows].sort(
      (x, y) => x.measurementDate.localeCompare(y.measurementDate) || x.versionNo - y.versionNo,
    );
    navigate(`/measurements/compare?left=${a!.id}&right=${b!.id}`);
  };

  const columns: ColumnsType<MeasurementSummary> = [
    {
      title: '고객',
      key: 'customer',
      width: 180,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.customerName || '-'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.customerPhone}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '채촌일',
      dataIndex: 'measurementDate',
      width: 120,
      render: (v: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{v}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            V{row.versionNo}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '구분',
      dataIndex: 'measurementType',
      width: 100,
      render: (v: string) => {
        const meta = metaOf(MEASUREMENT_TYPE_META, v);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: 100,
      render: (v: string, row) => {
        const meta = metaOf(MEASUREMENT_STATUS_META, v);
        return (
          <Space size={4}>
            <StatusBadge label={meta.label} color={meta.color} />
            {row.locked && (
              <Tooltip title="작업지시서 출력에 사용되어 수정·삭제할 수 없습니다.">
                <Tag color="gold">잠금</Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    { title: '담당자', dataIndex: 'staffName', width: 110 },
    { title: '항목 수', dataIndex: 'valueCount', width: 80, align: 'right' },
    {
      title: '사용 품목',
      key: 'linked',
      render: (_, row) =>
        row.linkedOrderItems.length ? (
          <Space wrap size={4}>
            {row.linkedOrderItems.map((it) => (
              <Tag key={it.id}>{it.displayName}</Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: '액션',
      key: 'actions',
      width: 210,
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => navigate(`/measurements/${row.id}`)}>
            {row.locked ? '보기' : '수정'}
          </Button>
          <Can permission="MEASUREMENT_EDIT">
            <Button
              size="small"
              icon={<CopyOutlined />}
              loading={cloneMutation.isPending && cloneMutation.variables === row.id}
              onClick={() => cloneMutation.mutate(row.id)}
            >
              복사
            </Button>
          </Can>
          <Can permission="MEASUREMENT_EDIT">
            <Tooltip title={row.locked ? '작업지시서 출력에 사용된 채촌은 삭제할 수 없습니다.' : ''}>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={row.locked}
                onClick={() => confirmDelete(row)}
              />
            </Tooltip>
          </Can>
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Can permission="MEASUREMENT_EDIT">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/measurements/new')}>
              신규 채촌
            </Button>
          </Can>
        </Space>

        {customerId && (
          <Space>
            <Tag closable color="blue" onClose={() => setSearchParams({})}>
              고객 지정 조회 중{rows[0]?.customerName ? `: ${rows[0].customerName}` : ''}
            </Tag>
          </Space>
        )}

        <Space wrap>
          <Input.Search
            allowClear
            style={{ width: 260 }}
            placeholder="고객명 또는 전화번호"
            value={form.q}
            onChange={(e) => setForm((f) => ({ ...f, q: e.target.value }))}
            onSearch={handleSearch}
          />
          <DatePicker.RangePicker
            value={form.range}
            placeholder={['채촌일 시작', '종료']}
            onChange={(v) => setForm((f) => ({ ...f, range: (v as [Dayjs, Dayjs] | null) ?? null }))}
          />
          <Select
            allowClear
            style={{ width: 130 }}
            placeholder="구분"
            value={form.type}
            options={TYPE_OPTIONS}
            onChange={(v) => setForm((f) => ({ ...f, type: v as MeasurementType | undefined }))}
          />
          <Select
            allowClear
            style={{ width: 130 }}
            placeholder="상태"
            value={form.status}
            options={STATUS_OPTIONS}
            onChange={(v) => setForm((f) => ({ ...f, status: v as MeasurementSessionStatus | undefined }))}
          />
          <Button type="primary" onClick={handleSearch}>
            검색
          </Button>
          <Button onClick={handleReset}>초기화</Button>
        </Space>

        <Space wrap>
          <Tooltip
            title={
              selectedIds.length !== 2
                ? '비교할 기록 2건을 선택해 주세요.'
                : !sameCustomer
                  ? '같은 고객의 기록만 비교할 수 있습니다.'
                  : ''
            }
          >
            <Button icon={<DiffOutlined />} disabled={!sameCustomer} onClick={handleCompare}>
              선택한 기록 비교 ({selectedIds.length}/2)
            </Button>
          </Tooltip>
          {listQuery.data && (
            <Typography.Text type="secondary">총 {listQuery.data.total}건</Typography.Text>
          )}
        </Space>

        <Table<MeasurementSummary>
          rowKey="id"
          size="small"
          loading={listQuery.isLoading}
          dataSource={rows}
          columns={columns}
          scroll={{ x: 1100 }}
          locale={{
            emptyText: <Empty description="조건에 맞는 채촌 기록이 없습니다." />,
          }}
          rowSelection={{
            type: 'checkbox',
            selectedRowKeys: selectedIds,
            onChange: (keys) => {
              const next = keys.map(String);
              // 비교는 2건까지만 유지한다 (가장 최근 선택 2건)
              setSelectedIds(next.length > 2 ? next.slice(next.length - 2) : next);
            },
          }}
          pagination={{
            current: listQuery.data?.page ?? page,
            pageSize: size,
            total: listQuery.data?.total ?? 0,
            showSizeChanger: true,
            onChange: (p, s) => {
              setPage(p);
              setSize(s);
            },
          }}
        />
      </Space>
    </Card>
  );
}
