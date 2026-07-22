/**
 * PAY-001 결제 관리
 * - 기본 화면은 결제 목록: 결제일 범위(기본 최근 1개월) + 고객/계약번호 검색
 * - 행 클릭 시 ?contractId= 로 계약 결제 상세(ContractPaymentPanel) 전환
 */
import { ReloadOutlined, SearchOutlined, UserOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, DatePicker, Input, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchMaster } from '../../api/admin';
import { PAYMENT_TYPE_LABEL, searchPayments } from '../../api/payments';
import type { PaymentListParams, PaymentListRow, PaymentType } from '../../api/payments';
import { CustomerPickerModal } from '../../shared/CustomerPickerModal';
import type { PickedCustomer } from '../../shared/CustomerPickerModal';
import { ContractPaymentPanel } from './ContractPaymentPanel';
import { krw } from './format';

const { RangePicker } = DatePicker;

/** 검색 폼 상태 (조회 버튼을 눌러야 filters에 반영된다) */
interface SearchForm {
  range: [Dayjs, Dayjs] | null;
  q: string;
  /** 고객 검색 팝업으로 특정한 고객 (선택 시 q보다 우선한다) */
  customer: PickedCustomer | null;
  paymentType?: PaymentType;
  status?: 'COMPLETED' | 'CANCELLED';
}

const DEFAULT_RANGE: [Dayjs, Dayjs] = [dayjs().subtract(1, 'month'), dayjs()];
const INITIAL_FORM: SearchForm = { range: DEFAULT_RANGE, q: '', customer: null };

function toParams(form: SearchForm, page: number, size: number): PaymentListParams {
  return {
    dateFrom: form.range?.[0]?.format('YYYY-MM-DD'),
    dateTo: form.range?.[1]?.format('YYYY-MM-DD'),
    // 고객을 특정했으면 customerId로 정확히 조회하고 키워드는 무시한다.
    customerId: form.customer?.id,
    q: form.customer ? undefined : form.q.trim() || undefined,
    paymentType: form.paymentType,
    status: form.status,
    page,
    size,
  };
}

export function PaymentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const contractId = searchParams.get('contractId');

  const [form, setForm] = useState<SearchForm>(INITIAL_FORM);
  // 조회 버튼(또는 Enter)으로 확정된 검색 조건
  const [filters, setFilters] = useState<SearchForm>(INITIAL_FORM);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [pickerOpen, setPickerOpen] = useState(false);

  const params = toParams(filters, page, size);
  const listQuery = useQuery({
    queryKey: ['payments', 'list', params],
    queryFn: () => searchPayments(params),
    enabled: !contractId,
  });

  // 결제수단 코드 → 표시명 (기준정보). 저장은 코드, 표시는 표시명.
  const methodsQuery = useQuery({
    queryKey: ['admin', 'master', 'payment-method'],
    queryFn: () => fetchMaster('payment-method'),
    retry: false,
  });
  const methodLabel = (code?: string) =>
    !code ? '-' : ((methodsQuery.data ?? []).find((m) => m.code === code)?.name ?? code);

  const runSearch = () => {
    setPage(1);
    setFilters(form);
  };

  const resetSearch = () => {
    setForm(INITIAL_FORM);
    setFilters(INITIAL_FORM);
    setPage(1);
  };

  /** 팝업에서 고객을 고르면 즉시 조회한다 (한 번의 클릭으로 결과까지) */
  const handlePickCustomer = (customer: PickedCustomer) => {
    const next: SearchForm = { ...form, customer, q: '' };
    setForm(next);
    setFilters(next);
    setPage(1);
    setPickerOpen(false);
  };

  const clearCustomer = () => {
    const next: SearchForm = { ...form, customer: null };
    setForm(next);
    setFilters(next);
    setPage(1);
  };

  const columns: ColumnsType<PaymentListRow> = [
    { title: '결제일', dataIndex: 'paymentDate', width: 110 },
    {
      title: '고객',
      dataIndex: 'customerName',
      width: 180,
      render: (name: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.customerPhone}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '계약번호', dataIndex: 'contractNo', width: 150 },
    {
      title: '계약 구분',
      dataIndex: 'contractTypeName',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '결제 유형',
      dataIndex: 'paymentType',
      width: 100,
      render: (t: PaymentType) => (
        <Tag color={t === 'REFUND' ? 'red' : 'blue'}>{PAYMENT_TYPE_LABEL[t]}</Tag>
      ),
    },
    {
      title: '금액',
      dataIndex: 'amount',
      align: 'right',
      width: 130,
      render: (v: number, row) => (
        <Typography.Text delete={row.status === 'CANCELLED'}>
          {row.paymentType === 'REFUND' ? `-${krw(v)}` : krw(v)}
        </Typography.Text>
      ),
    },
    { title: '수단', dataIndex: 'paymentMethod', width: 90, render: (v?: string) => methodLabel(v) },
    {
      title: '상태',
      dataIndex: 'status',
      width: 80,
      render: (s: PaymentListRow['status']) =>
        s === 'CANCELLED' ? <Tag color="red">취소</Tag> : <Tag color="green">완료</Tag>,
    },
    { title: '메모', dataIndex: 'memo', ellipsis: true, render: (v?: string) => v ?? '-' },
  ];

  if (contractId) {
    return (
      <ContractPaymentPanel contractId={contractId} onBack={() => setSearchParams({})} />
    );
  }

  const totals = listQuery.data?.totals;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="결제 검색">
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} md={10}>
            <RangePicker
              style={{ width: '100%' }}
              value={form.range}
              onChange={(v) => setForm({ ...form, range: v as [Dayjs, Dayjs] | null })}
              allowEmpty={[true, true]}
              placeholder={['결제일 시작', '결제일 종료']}
            />
          </Col>
          <Col xs={24} md={8}>
            {form.customer ? (
              // 고객을 특정한 상태 — 키워드 검색 대신 고객 단건 조회
              <Space>
                <Tag
                  color="blue"
                  closable
                  onClose={clearCustomer}
                  style={{ padding: '4px 8px', fontSize: 14 }}
                >
                  <UserOutlined /> {form.customer.name} ({form.customer.phone})
                </Tag>
                <Button size="small" onClick={() => setPickerOpen(true)}>
                  변경
                </Button>
              </Space>
            ) : (
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  allowClear
                  placeholder="고객명 · 전화번호 · 계약번호"
                  prefix={<SearchOutlined />}
                  value={form.q}
                  onChange={(e) => setForm({ ...form, q: e.target.value })}
                  onPressEnter={runSearch}
                />
                <Button icon={<UserOutlined />} onClick={() => setPickerOpen(true)}>
                  고객 찾기
                </Button>
              </Space.Compact>
            )}
          </Col>
          <Col xs={12} md={3}>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder="결제 유형"
              value={form.paymentType}
              onChange={(v?: PaymentType) => setForm({ ...form, paymentType: v })}
              options={Object.entries(PAYMENT_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
            />
          </Col>
          <Col xs={12} md={3}>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder="상태"
              value={form.status}
              onChange={(v?: 'COMPLETED' | 'CANCELLED') => setForm({ ...form, status: v })}
              options={[
                { value: 'COMPLETED', label: '완료' },
                { value: 'CANCELLED', label: '취소' },
              ]}
            />
          </Col>
          <Col span={24}>
            <Space>
              <Button type="primary" icon={<SearchOutlined />} onClick={runSearch}>
                조회
              </Button>
              <Button icon={<ReloadOutlined />} onClick={resetSearch}>
                초기화
              </Button>
              <Typography.Text type="secondary">
                기본 조회 기간은 최근 1개월입니다. 기간을 비우면 전체 기간을 조회합니다. 고객을 정확히
                고르려면 &quot;고객 찾기&quot;를 사용하세요.
              </Typography.Text>
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="건수" value={totals?.count ?? 0} suffix="건" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="수금 합계"
              value={totals?.paidAmount ?? 0}
              suffix="원"
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="환불 합계"
              value={totals?.refundAmount ?? 0}
              suffix="원"
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="순수금" value={totals?.netAmount ?? 0} suffix="원" />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="결제 내역">
        <Table<PaymentListRow>
          rowKey="id"
          size="small"
          loading={listQuery.isFetching}
          dataSource={listQuery.data?.data ?? []}
          columns={columns}
          scroll={{ x: 1100 }}
          onRow={(row) => ({
            style: { cursor: 'pointer' },
            onClick: () => setSearchParams({ contractId: row.contractId }),
          })}
          pagination={{
            current: page,
            pageSize: size,
            total: listQuery.data?.page.totalElements ?? 0,
            showSizeChanger: true,
            showTotal: (total) => `총 ${total}건`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setSize(nextSize);
            },
          }}
          locale={{ emptyText: '조회 조건에 해당하는 결제가 없습니다.' }}
        />
      </Card>

      <CustomerPickerModal
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onSelect={handlePickCustomer}
        initialKeyword={form.q}
        title="고객 검색 — 결제 조회"
      />
    </Space>
  );
}
