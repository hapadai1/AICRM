/**
 * PAY-001 계약 결제 상세 패널
 * - 목록(PaymentsPage)에서 계약을 선택하면 열린다
 * - 요약(계약금액/수금/잔금) + 결제 목록 + 등록/취소/잔금 예정일 수정
 */
import { ArrowLeftOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { fetchMaster } from '../../api/admin';
import { ApiError } from '../../api/client';
import {
  PAYMENT_TYPE_LABEL,
  cancelPayment,
  createPayment,
  fetchContractPayments,
  updatePaymentSchedule,
} from '../../api/payments';
import type { Payment, PaymentType } from '../../api/payments';
import { Can } from '../../shared/Can';
import { krw } from './format';

interface PaymentFormValues {
  paymentType: PaymentType;
  amount: number;
  paymentDate: Dayjs;
  paymentMethod?: string;
  payerName?: string;
  memo?: string;
}

/** 기준정보 API(결제수단) 미지원 환경 대비 기본 선택지 */
const FALLBACK_PAYMENT_METHODS = ['카드', '계좌이체', '현금'];

interface Props {
  contractId: string;
  /** 목록으로 돌아가기 */
  onBack: () => void;
}

export function ContractPaymentPanel({ contractId, onBack }: Props) {
  const [registerOpen, setRegisterOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Payment | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState<Dayjs | null>(null);
  const [form] = Form.useForm<PaymentFormValues>();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();

  const summaryQuery = useQuery({
    queryKey: ['contracts', contractId, 'payments'],
    queryFn: () => fetchContractPayments(contractId),
  });
  // 응답 구조 { payments, summary, warning } (계약 문서 04 §4)
  const summary = summaryQuery.data?.summary;
  const payments = summaryQuery.data?.payments;
  const overCollected = summaryQuery.data?.warning?.code === 'OVER_COLLECTION';

  // 결제수단 기준정보는 백엔드 연동 예정 — 실패해도 화면이 깨지지 않게 기본 목록으로 대체한다.
  const methodsQuery = useQuery({
    queryKey: ['admin', 'master', 'payment-method'],
    queryFn: () => fetchMaster('payment-method'),
    retry: false,
  });
  const methodOptions = methodsQuery.isError
    ? FALLBACK_PAYMENT_METHODS.map((name) => ({ value: name, label: name }))
    : (methodsQuery.data ?? [])
        .filter((m) => m.active)
        .map((m) => ({ value: m.name, label: m.name }));

  /** 상세 요약과 목록·대시보드를 함께 갱신한다 */
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['contracts', contractId, 'payments'] });
    void queryClient.invalidateQueries({ queryKey: ['payments'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const onApiError = (e: unknown) =>
    message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');

  const createMutation = useMutation({
    mutationFn: (values: PaymentFormValues) =>
      createPayment(contractId, {
        paymentType: values.paymentType,
        amount: values.amount,
        paymentDate: values.paymentDate.format('YYYY-MM-DD'),
        paymentMethod: values.paymentMethod,
        payerName: values.payerName,
        memo: values.memo,
      }),
    onSuccess: (result) => {
      setRegisterOpen(false);
      form.resetFields();
      if (result.warning?.code === 'OVER_COLLECTION') {
        message.warning('결제가 등록되었습니다. 수금액이 계약 금액을 초과한 상태입니다.');
      } else {
        message.success('결제가 등록되었습니다.');
      }
      invalidateAll();
    },
    onError: onApiError,
  });

  const cancelMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => cancelPayment(id, reason),
    onSuccess: () => {
      setCancelTarget(null);
      setCancelReason('');
      message.success('결제가 취소되었습니다.');
      invalidateAll();
    },
    onError: onApiError,
  });

  const scheduleMutation = useMutation({
    mutationFn: (balanceDueDate: string | null) => updatePaymentSchedule(contractId, balanceDueDate),
    onSuccess: () => {
      setScheduleOpen(false);
      message.success('결제 예정일이 변경되었습니다.');
      invalidateAll();
    },
    onError: onApiError,
  });

  const handleRegisterSubmit = async () => {
    const values = await form.validateFields();
    const willExceed =
      summary !== undefined &&
      values.paymentType !== 'REFUND' &&
      summary.paidAmount + values.amount > summary.contractAmount;
    if (willExceed) {
      // 초과 수금 경고: 차단하지 않고 관리자 확인 후 진행 (03문서 §10.2)
      modal.confirm({
        title: '계약 금액 초과 수금',
        content: `이 결제를 등록하면 수금액(${krw(
          (summary?.paidAmount ?? 0) + values.amount,
        )})이 계약 금액(${krw(summary?.contractAmount ?? 0)})을 초과합니다. 환불·추가 품목 상황을 확인한 뒤 계속하시겠습니까?`,
        okText: '초과 등록',
        cancelText: '취소',
        onOk: () => createMutation.mutate(values),
      });
    } else {
      createMutation.mutate(values);
    }
  };

  const columns: ColumnsType<Payment> = [
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
      render: (v: number, p) => (
        <Typography.Text delete={p.status === 'CANCELLED'}>
          {p.paymentType === 'REFUND' ? `-${krw(v)}` : krw(v)}
        </Typography.Text>
      ),
    },
    { title: '결제일', dataIndex: 'paymentDate', width: 110 },
    { title: '결제수단', dataIndex: 'paymentMethod', width: 100, render: (v?: string) => v ?? '-' },
    // 입금자는 백엔드에서 memo에 "입금자: {이름}" 형태로 병합된다 (계약 문서 04 §4)
    { title: '메모', dataIndex: 'memo', render: (v?: string) => v ?? '-' },
    {
      title: '상태',
      dataIndex: 'status',
      width: 110,
      render: (s: Payment['status'], p) =>
        s === 'CANCELLED' ? (
          <Tooltip title={p.cancelReason ? `취소 사유: ${p.cancelReason}` : undefined}>
            <Tag color="red">취소</Tag>
          </Tooltip>
        ) : (
          <Tag color="green">완료</Tag>
        ),
    },
    {
      title: '작업',
      key: 'action',
      width: 90,
      render: (_, p) =>
        p.status === 'CANCELLED' ? null : (
          <Can permission="PAYMENT_EDIT">
            <Button size="small" danger onClick={() => setCancelTarget(p)}>
              취소
            </Button>
          </Can>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" loading={summaryQuery.isLoading}>
        <Button type="link" icon={<ArrowLeftOutlined />} style={{ paddingLeft: 0 }} onClick={onBack}>
          결제 목록으로
        </Button>
        {summary && (
          <>
            {overCollected && (
              <Alert
                type="warning"
                showIcon
                style={{ margin: '12px 0' }}
                message="수금액이 계약 금액을 초과했습니다."
                description="환불 또는 추가 품목(변경 계약) 여부를 확인해 주세요."
              />
            )}
            <Descriptions
              size="small"
              column={{ xs: 1, md: 2 }}
              style={{ marginTop: 12 }}
              items={[
                { key: 'no', label: '계약번호', children: summary.contractNo },
                { key: 'cust', label: '고객명', children: summary.customerName },
                { key: 'type', label: '계약 구분', children: summary.contractTypeName ?? '-' },
                {
                  key: 'due',
                  label: '잔금 결제 예정일',
                  children: (
                    <Space size="small">
                      {summary.balanceDueDate ?? '-'}
                      {summary.balanceDueDate &&
                        summary.balanceDueDate < dayjs().format('YYYY-MM-DD') &&
                        summary.balanceAmount > 0 && <Tag color="red">결제 지연</Tag>}
                      <Can permission="PAYMENT_EDIT">
                        <Button
                          size="small"
                          type="link"
                          icon={<EditOutlined />}
                          onClick={() => {
                            setScheduleDate(
                              summary.balanceDueDate ? dayjs(summary.balanceDueDate) : null,
                            );
                            setScheduleOpen(true);
                          }}
                        >
                          수정
                        </Button>
                      </Can>
                    </Space>
                  ),
                },
              ]}
            />
            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col xs={24} md={8}>
                <Card size="small">
                  <Statistic title="계약 금액" value={summary.contractAmount} suffix="원" />
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card size="small">
                  <Statistic
                    title="수금액"
                    value={summary.paidAmount}
                    suffix="원"
                    valueStyle={{ color: overCollected ? '#d46b08' : '#3f8600' }}
                  />
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card size="small">
                  <Statistic
                    title="잔금"
                    value={summary.balanceAmount}
                    suffix="원"
                    valueStyle={{ color: summary.balanceAmount > 0 ? '#cf1322' : undefined }}
                  />
                </Card>
              </Col>
            </Row>
          </>
        )}
      </Card>

      <Card
        size="small"
        title="결제 목록"
        extra={
          <Can permission="PAYMENT_EDIT">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setRegisterOpen(true)}>
              결제 등록
            </Button>
          </Can>
        }
      >
        <Table<Payment>
          rowKey="id"
          size="small"
          loading={summaryQuery.isLoading}
          dataSource={payments ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: '등록된 결제가 없습니다.' }}
        />
      </Card>

      {/* 결제 등록 모달 */}
      <Modal
        title="결제 등록"
        open={registerOpen}
        onCancel={() => setRegisterOpen(false)}
        onOk={() => void handleRegisterSubmit()}
        okText="등록"
        cancelText="취소"
        confirmLoading={createMutation.isPending}
        destroyOnClose
      >
        <Form<PaymentFormValues>
          form={form}
          layout="vertical"
          initialValues={{ paymentType: 'DEPOSIT', paymentDate: dayjs() }}
        >
          <Form.Item
            label="결제 유형"
            name="paymentType"
            rules={[{ required: true, message: '결제 유형을 선택해 주세요.' }]}
          >
            <Select
              options={Object.entries(PAYMENT_TYPE_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </Form.Item>
          <Form.Item
            label="금액(원)"
            name="amount"
            rules={[
              { required: true, message: '금액을 입력해 주세요.' },
              { type: 'number', min: 1, message: '1원 이상 입력해 주세요.' },
            ]}
          >
            <InputNumber
              style={{ width: '100%' }}
              step={10000}
              formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              parser={(v) => Number((v ?? '').replace(/,/g, '')) as unknown as number}
            />
          </Form.Item>
          <Form.Item
            label="결제일"
            name="paymentDate"
            rules={[{ required: true, message: '결제일을 선택해 주세요.' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="결제수단" name="paymentMethod">
            <Select allowClear placeholder="선택" options={methodOptions} />
          </Form.Item>
          <Form.Item label="입금자" name="payerName">
            <Input placeholder="입금자명" />
          </Form.Item>
          <Form.Item label="메모" name="memo">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 결제 취소 모달 (사유 필수) */}
      <Modal
        title="결제 취소"
        open={!!cancelTarget}
        onCancel={() => {
          setCancelTarget(null);
          setCancelReason('');
        }}
        onOk={() => {
          if (!cancelTarget) return;
          cancelMutation.mutate({ id: cancelTarget.id, reason: cancelReason });
        }}
        okText="결제 취소"
        okButtonProps={{ danger: true, disabled: !cancelReason.trim() }}
        cancelText="닫기"
        confirmLoading={cancelMutation.isPending}
      >
        {cancelTarget && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>
              {PAYMENT_TYPE_LABEL[cancelTarget.paymentType]} {krw(cancelTarget.amount)} (
              {cancelTarget.paymentDate}) 결제를 취소합니다. 결제 이력은 삭제되지 않고 취소 상태로
              보존됩니다.
            </Typography.Text>
            <Input.TextArea
              placeholder="취소 사유 (필수)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Space>
        )}
      </Modal>

      {/* 잔금 결제 예정일 수정 모달 */}
      <Modal
        title="잔금 결제 예정일 수정"
        open={scheduleOpen}
        onCancel={() => setScheduleOpen(false)}
        onOk={() => scheduleMutation.mutate(scheduleDate ? scheduleDate.format('YYYY-MM-DD') : null)}
        okText="저장"
        cancelText="취소"
        confirmLoading={scheduleMutation.isPending}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            결제 예정일이 경과하고 잔금이 남아 있으면 대시보드에 결제 지연으로 표시됩니다. 비워두면
            지연 판정에서 제외됩니다.
          </Typography.Text>
          <DatePicker
            style={{ width: '100%' }}
            value={scheduleDate}
            onChange={setScheduleDate}
            allowClear
          />
        </Space>
      </Modal>
    </Space>
  );
}
