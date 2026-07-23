/**
 * 예약 고객 등록 모달 (CUST-001)
 * - 업무의 99%는 예약 후 상담한 고객이다. 예약을 검색해서 그 고객을 정식 등록한다.
 * - 예약 등록 시점에 고객 행(PROSPECT)은 이미 생성되어 있으므로(customers.service
 *   linkOrCreateProspectByPhone), 여기서는 이름·이메일·메모 등 빠진 정보를 채워 저장한다.
 *   PROSPECT → CONTRACTED 전환은 계약 확정이 담당하므로 여기서 다루지 않는다.
 */
import { ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Alert, Button, DatePicker, Descriptions, Form, Input, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useState } from 'react';
import { fetchAppointments, type Appointment } from '../../api/appointments';
import { ApiError } from '../../api/client';
import { findCustomerByPhone, updateCustomer, type CustomerBase } from '../../api/customers';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { APPT_STATUS_META, SOURCE_META } from '../appointments/appointment-constants';
import { CUSTOMER_STATUS_META } from './customer-constants';

interface Props {
  open: boolean;
  onClose: () => void;
  onGoDetail: (customerId: string) => void;
}

interface FormValues {
  name: string;
  email?: string;
  notes?: string;
}

/** 등록 대상 예약은 아직 계약이 없는 고객 것이다 */
const TARGET_STATUSES = ['RESERVED', 'CONFIRMED', 'VISITED'] as const;

export function AppointmentCustomerModal({ open, onClose, onGoDetail }: Props) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();

  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  /** 이미 계약 상태인 고객의 예약까지 보여줄지 */
  const [includeContracted, setIncludeContracted] = useState(false);
  const [picked, setPicked] = useState<{ appointment: Appointment; customer: CustomerBase } | null>(null);

  const reset = () => {
    setKeyword('');
    setQ('');
    setPage(1);
    setIncludeContracted(false);
    setPicked(null);
    form.resetFields();
  };

  const close = () => {
    reset();
    onClose();
  };

  const { data, isFetching } = useQuery({
    queryKey: ['appointments', 'customer-register', { q, page }],
    queryFn: () => fetchAppointments({ q, statuses: [...TARGET_STATUSES], page, size: 8 }),
    enabled: open,
  });

  /** 예약 행 선택 → 연결된 고객을 전화번호로 불러와 폼을 채운다 */
  const pickMutation = useMutation({
    mutationFn: async (appointment: Appointment) => {
      const customer = await findCustomerByPhone(appointment.phone);
      if (!customer) throw new ApiError('CUSTOMER_NOT_FOUND', '예약에 연결된 고객을 찾을 수 없습니다.');
      return { appointment, customer };
    },
    onSuccess: (result) => {
      setPicked(result);
      form.setFieldsValue({
        name: result.customer.name,
        email: result.customer.email ?? undefined,
        notes: result.customer.notes ?? undefined,
      });
    },
    onError: (e) => {
      message.error(e instanceof ApiError ? e.message : '고객 정보를 불러오지 못했습니다.');
    },
  });

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) =>
      updateCustomer(picked!.customer.id, {
        ...values,
        phone: picked!.customer.phone,
        version: picked!.customer.version,
      }),
    onSuccess: (saved) => {
      message.success(`고객 "${saved.name}"을(를) 등록했습니다.`);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      close();
      onGoDetail(saved.id);
    },
    onError: (e) => {
      message.error(e instanceof ApiError ? e.message : '고객 등록에 실패했습니다.');
    },
  });

  const runSearch = () => {
    setPage(1);
    setQ(keyword.trim());
  };

  const rows = (data?.data ?? []).filter(
    (a) => includeContracted || a.customerStatus !== 'CONTRACTED',
  );

  const columns: ColumnsType<Appointment> = [
    {
      title: '예약일시',
      dataIndex: 'startAt',
      width: 150,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    { title: '고객명', dataIndex: 'customerName', width: 100 },
    { title: '전화번호', dataIndex: 'phone', width: 130 },
    { title: '예약 목적', dataIndex: 'purposeName', width: 120 },
    {
      title: '예약 상태',
      dataIndex: 'status',
      width: 90,
      render: (v: Appointment['status']) => (
        <StatusBadge label={metaOf(APPT_STATUS_META, v).label} color={metaOf(APPT_STATUS_META, v).color} />
      ),
    },
    {
      title: '고객 상태',
      dataIndex: 'customerStatus',
      width: 90,
      render: (v: Appointment['customerStatus']) =>
        v ? <StatusBadge label={metaOf(CUSTOMER_STATUS_META, v).label} color={metaOf(CUSTOMER_STATUS_META, v).color} /> : '-',
    },
    {
      title: '경로',
      dataIndex: 'source',
      width: 80,
      render: (v: Appointment['source']) => (
        <Tag color={metaOf(SOURCE_META, v).color}>{metaOf(SOURCE_META, v).label}</Tag>
      ),
    },
  ];

  const footer = picked
    ? [
        <Button key="back" icon={<ArrowLeftOutlined />} onClick={() => setPicked(null)}>
          예약 다시 선택
        </Button>,
        <Button key="detail" onClick={() => { const id = picked.customer.id; close(); onGoDetail(id); }}>
          그대로 상세로 이동
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={saveMutation.isPending}
          onClick={() => void form.validateFields().then((values) => saveMutation.mutate(values))}
        >
          등록
        </Button>,
      ]
    : [
        <Button key="cancel" onClick={close}>
          닫기
        </Button>,
      ];

  return (
    <Modal
      title="예약 고객 등록"
      open={open}
      onCancel={close}
      footer={footer}
      width={picked ? 560 : 900}
      maskClosable={false}
      destroyOnClose
    >
      {picked ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions size="small" column={1} bordered title="선택한 예약">
            <Descriptions.Item label="예약일시">
              {dayjs(picked.appointment.startAt).format('YYYY-MM-DD HH:mm')}
            </Descriptions.Item>
            <Descriptions.Item label="예약 목적">{picked.appointment.purposeName}</Descriptions.Item>
            <Descriptions.Item label="전화번호">{picked.customer.phone}</Descriptions.Item>
            <Descriptions.Item label="고객 상태">
              <StatusBadge
                label={metaOf(CUSTOMER_STATUS_META, picked.customer.customerStatus).label}
                color={metaOf(CUSTOMER_STATUS_META, picked.customer.customerStatus).color}
              />
            </Descriptions.Item>
            <Descriptions.Item label="예약 메모">{picked.appointment.memo || '-'}</Descriptions.Item>
          </Descriptions>

          <Form form={form} layout="vertical" requiredMark>
            <Form.Item label="이름" name="name" rules={[{ required: true, message: '이름을 입력해 주세요.' }]}>
              <Input maxLength={30} />
            </Form.Item>
            <Form.Item label="이메일" name="email" rules={[{ type: 'email', message: '이메일 형식이 아닙니다.' }]}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item label="최초 예약일" tooltip="예약 등록 시 자동으로 기록됩니다.">
              <DatePicker
                style={{ width: '100%' }}
                disabled
                value={picked.customer.firstReservedAt ? dayjs(picked.customer.firstReservedAt) : null}
              />
            </Form.Item>
            <Form.Item label="메모" name="notes">
              <Input.TextArea rows={3} maxLength={1000} />
            </Form.Item>
          </Form>
        </Space>
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            예약을 검색해서 선택하면 해당 고객 정보를 채워 등록합니다.
          </Typography.Text>
          <Space wrap>
            <Input
              style={{ width: 280 }}
              placeholder="고객명 / 전화번호 검색"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onPressEnter={runSearch}
              allowClear
              autoFocus
            />
            <Button icon={<SearchOutlined />} onClick={runSearch}>
              검색
            </Button>
            <Space size={6}>
              <Switch checked={includeContracted} onChange={setIncludeContracted} />
              <Typography.Text>계약 고객 포함</Typography.Text>
            </Space>
          </Space>

          {pickMutation.isError && (
            <Alert type="error" showIcon message="예약에 연결된 고객을 불러오지 못했습니다." />
          )}

          <Table<Appointment>
            rowKey="id"
            size="small"
            scroll={{ x: 'max-content' }}
            loading={isFetching || pickMutation.isPending}
            columns={columns}
            dataSource={rows}
            pagination={{
              current: page,
              pageSize: 8,
              total: data?.page.totalElements ?? 0,
              showSizeChanger: false,
              onChange: setPage,
            }}
            onRow={(r) => ({
              onClick: () => pickMutation.mutate(r),
              style: { cursor: 'pointer' },
            })}
            locale={{ emptyText: '조건에 해당하는 예약이 없습니다.' }}
          />
        </Space>
      )}
    </Modal>
  );
}
