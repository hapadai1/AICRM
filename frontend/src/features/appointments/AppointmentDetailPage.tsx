import { ArrowLeftOutlined, EditOutlined, FileAddOutlined, LinkOutlined, UserOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  DatePicker,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  cancelAppointment,
  confirmAppointment,
  fetchAppointment,
  noShowAppointment,
  resolveAppointmentConflict,
  saveConsultation,
  updateAppointment,
  visitAppointment,
  USAGE_TYPES,
  USAGE_TYPE_LABELS,
  type Appointment,
  type UsageType,
} from '../../api/appointments';
import { ApiError } from '../../api/client';
import { findCustomerByPhone } from '../../api/customers';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { CUSTOMER_STATUS_META } from '../customers/customer-constants';
import { APPT_STATUS_META, CONSULTATION_INTERESTS, SOURCE_META, SYNC_STATUS_META } from './appointment-constants';
import { AppointmentFormModal } from './AppointmentFormModal';
import { metaOf } from '../../shared/status-meta';
import type { Dayjs } from 'dayjs';

/** 상담 기록 폼 값 — 설계 PDF 1페이지 "용도·예산·희망 스타일·납기" */
interface ConsultationFormValues {
  interests?: string[];
  content: string;
  usageType?: UsageType;
  budgetMin?: number;
  budgetMax?: number;
  preferredStyle?: string;
  desiredDueDate?: Dayjs;
}

/** 예산 범위 표기. 하한·상한이 같으면 한 값만 보여준다. */
function formatBudget(min: number, max?: number | null): string {
  const toManwon = (v: number) => `${Math.round(v / 10000).toLocaleString()}만원`;
  if (max == null || max === min) return toManwon(min);
  return `${toManwon(min)}~${toManwon(max)}`;
}

function formatDateTime(v?: string): string {
  return v ? dayjs(v).format('YYYY-MM-DD (dd) HH:mm') : '-';
}

/** APPT-002 예약 상세·상담 */
export function AppointmentDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [consultForm] = Form.useForm<ConsultationFormValues>();

  const { data: appointment, isLoading, isError, error } = useQuery({
    queryKey: ['appointments', id],
    queryFn: () => fetchAppointment(id),
    enabled: !!id,
  });

  const phoneDigits = (appointment?.phone ?? '').replace(/\D/g, '');
  // 미연결 예약: 동일 전화번호 기존 고객 후보 조회 (문서 03 §4.4)
  const { data: phoneMatch } = useQuery({
    queryKey: ['customers', 'by-phone', phoneDigits],
    queryFn: () => findCustomerByPhone(phoneDigits),
    enabled: !!appointment && !appointment.customerId && phoneDigits.length >= 10,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['appointments'] });
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
  };

  const onApiError = (e: unknown, fallback: string) => {
    message.error(e instanceof ApiError ? e.message : fallback);
  };

  const statusMutation = useMutation({
    mutationFn: ({ action }: { action: 'confirm' | 'visit' | 'noShow' }) => {
      if (action === 'confirm') return confirmAppointment(id);
      if (action === 'visit') return visitAppointment(id);
      return noShowAppointment(id);
    },
    onSuccess: (_res, { action }) => {
      message.success(
        action === 'confirm' ? '예약을 확정했습니다.' : action === 'visit' ? '방문 완료 처리했습니다.' : '노쇼 처리했습니다.',
      );
      invalidate();
    },
    onError: (e) => onApiError(e, '상태 변경에 실패했습니다.'),
  });

  const cancelMutation = useMutation({
    mutationFn: (reason: string) => cancelAppointment(id, reason),
    onSuccess: () => {
      message.success('예약을 취소했습니다.');
      setCancelOpen(false);
      setCancelReason('');
      invalidate();
    },
    onError: (e) => onApiError(e, '예약 취소에 실패했습니다.'),
  });

  const linkMutation = useMutation({
    mutationFn: (customerId: string) => updateAppointment(id, { customerId }),
    onSuccess: () => {
      message.success('기존 고객과 연결했습니다.');
      invalidate();
    },
    onError: (e) => onApiError(e, '고객 연결에 실패했습니다.'),
  });

  const resolveMutation = useMutation({
    mutationFn: (choice: 'NAVER' | 'CRM') => resolveAppointmentConflict(id, choice),
    onSuccess: () => {
      message.success('충돌을 해소했습니다.');
      invalidate();
    },
    onError: (e) => onApiError(e, '충돌 해소에 실패했습니다.'),
  });

  const consultMutation = useMutation({
    mutationFn: (values: ConsultationFormValues) =>
      saveConsultation(id, {
        interests: values.interests ?? [],
        content: values.content,
        usageType: values.usageType,
        budgetMin: values.budgetMin,
        budgetMax: values.budgetMax,
        preferredStyle: values.preferredStyle,
        desiredDueDate: values.desiredDueDate?.format('YYYY-MM-DD'),
      }),
    onSuccess: () => {
      message.success('상담 기록을 저장했습니다.');
      consultForm.resetFields();
      invalidate();
    },
    onError: (e) => onApiError(e, '상담 저장에 실패했습니다.'),
  });

  if (isLoading) {
    return (
      <Card style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </Card>
    );
  }
  if (isError || !appointment) {
    return (
      <Card>
        <Result
          status="warning"
          title="예약을 찾을 수 없습니다"
          subTitle={error instanceof ApiError ? error.message : undefined}
          extra={<Button onClick={() => navigate('/appointments')}>예약 목록으로</Button>}
        />
      </Card>
    );
  }

  const statusMeta = metaOf(APPT_STATUS_META, appointment.status);
  const syncMeta = metaOf(SYNC_STATUS_META, appointment.syncStatus);
  const sourceMeta = metaOf(SOURCE_META, appointment.source);
  const actionable = appointment.status === 'RESERVED' || appointment.status === 'CONFIRMED';

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/appointments')}>
              목록
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              예약 상세
            </Typography.Title>
            <Tag color={sourceMeta.color}>{sourceMeta.label}</Tag>
            <StatusBadge label={statusMeta.label} color={statusMeta.color} />
            <StatusBadge label={`동기화: ${syncMeta.label}`} color={syncMeta.color} />
          </Space>
          <Space wrap>
            <Can permission="APPOINTMENT_EDIT">
              <Button
                disabled={appointment.status !== 'RESERVED'}
                loading={statusMutation.isPending}
                onClick={() => statusMutation.mutate({ action: 'confirm' })}
              >
                확정
              </Button>
              <Button
                type="primary"
                disabled={!actionable}
                loading={statusMutation.isPending}
                onClick={() => statusMutation.mutate({ action: 'visit' })}
              >
                방문 완료
              </Button>
              <Button disabled={!actionable} onClick={() => setCancelOpen(true)}>
                취소
              </Button>
              <Button
                danger
                disabled={!actionable}
                loading={statusMutation.isPending}
                onClick={() => statusMutation.mutate({ action: 'noShow' })}
              >
                노쇼
              </Button>
            </Can>
            <Can permission="CONTRACT_CREATE">
              <Button
                type="primary"
                ghost
                icon={<FileAddOutlined />}
                disabled={!appointment.customerId}
                title={appointment.customerId ? undefined : '고객 연결 후 계약서를 생성할 수 있습니다.'}
                onClick={() =>
                  navigate(`/contracts/new?customerId=${appointment.customerId}&appointmentId=${appointment.id}`)
                }
              >
                계약서 생성
              </Button>
            </Can>
          </Space>
        </Space>

        {appointment.syncStatus === 'CONFLICT' && (
          <Alert
            style={{ marginTop: 16 }}
            type="error"
            showIcon
            message="네이버 원본과 CRM 수정값이 충돌했습니다"
            description={
              <Space direction="vertical" size={4}>
                <span>네이버 원본 일시: {formatDateTime(appointment.conflictNaverStartAt)}</span>
                <span>CRM 수정 일시: {formatDateTime(appointment.startAt)}</span>
                <Space>
                  <Button size="small" loading={resolveMutation.isPending} onClick={() => resolveMutation.mutate('NAVER')}>
                    네이버 값 적용
                  </Button>
                  <Button size="small" loading={resolveMutation.isPending} onClick={() => resolveMutation.mutate('CRM')}>
                    CRM 값 유지
                  </Button>
                </Space>
              </Space>
            }
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space>
                <UserOutlined />
                고객 정보
              </Space>
            }
            extra={
              appointment.customerId ? (
                <Button type="link" onClick={() => navigate(`/customers/${appointment.customerId}`)}>
                  고객 상세 보기
                </Button>
              ) : undefined
            }
          >
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="이름">{appointment.customerName}</Descriptions.Item>
              <Descriptions.Item label="전화번호">{appointment.phone}</Descriptions.Item>
              <Descriptions.Item label="고객 상태">
                {appointment.customerStatus ? (
                  <StatusBadge
                    label={metaOf(CUSTOMER_STATUS_META, appointment.customerStatus).label}
                    color={metaOf(CUSTOMER_STATUS_META, appointment.customerStatus).color}
                  />
                ) : (
                  <Typography.Text type="secondary">미연결 (신규 예약 고객)</Typography.Text>
                )}
              </Descriptions.Item>
            </Descriptions>
            {!appointment.customerId && phoneMatch && (
              <Alert
                style={{ marginTop: 12 }}
                type="info"
                showIcon
                message={
                  <Space wrap>
                    <span>
                      동일 전화번호의 기존 고객이 있습니다: <b>{phoneMatch.name}</b>
                    </span>
                    <Tag color={metaOf(CUSTOMER_STATUS_META, phoneMatch.customerStatus).color}>
                      {metaOf(CUSTOMER_STATUS_META, phoneMatch.customerStatus).label}
                    </Tag>
                    <Can permission="APPOINTMENT_EDIT">
                      <Button
                        size="small"
                        icon={<LinkOutlined />}
                        loading={linkMutation.isPending}
                        onClick={() => linkMutation.mutate(phoneMatch.id)}
                      >
                        기존 고객 연결
                      </Button>
                    </Can>
                  </Space>
                }
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            title="예약 정보"
            extra={
              <Can permission="APPOINTMENT_EDIT">
                <Button type="link" icon={<EditOutlined />} onClick={() => setEditOpen(true)}>
                  예약 수정
                </Button>
              </Can>
            }
          >
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="예약 목적">{appointment.purposeName}</Descriptions.Item>
              <Descriptions.Item label="예약 일시">
                {formatDateTime(appointment.startAt)} ~ {dayjs(appointment.endAt).format('HH:mm')}
              </Descriptions.Item>
              {appointment.naverReservationId && (
                <Descriptions.Item label="네이버 예약 ID">{appointment.naverReservationId}</Descriptions.Item>
              )}
              {appointment.visitedAt && (
                <Descriptions.Item label="실제 방문시각">{formatDateTime(appointment.visitedAt)}</Descriptions.Item>
              )}
              {appointment.cancelReason && (
                <Descriptions.Item label="취소 사유">{appointment.cancelReason}</Descriptions.Item>
              )}
              <Descriptions.Item label="메모">{appointment.memo || '-'}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Card title="상담 기록">
        <Can permission="CONSULTATION_EDIT">
          <Form
            form={consultForm}
            layout="vertical"
            onFinish={(values) => consultMutation.mutate(values)}
            style={{ marginBottom: 16 }}
          >
            <Form.Item label="거래 관심" name="interests">
              <Select
                mode="multiple"
                allowClear
                placeholder="비즈니스 맞춤, 웨딩 렌탈 등 (참고 정보)"
                options={CONSULTATION_INTERESTS.map((v) => ({ value: v, label: v }))}
              />
            </Form.Item>
            {/* 설계 PDF 1페이지 "방문 목적 파악 (용도, 예산, 희망 스타일, 납기 확인)" */}
            <Row gutter={12}>
              <Col xs={24} md={8}>
                <Form.Item label="용도" name="usageType">
                  <Select
                    allowClear
                    placeholder="선택"
                    options={USAGE_TYPES.map((v) => ({ value: v, label: USAGE_TYPE_LABELS[v] }))}
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={5}>
                <Form.Item label="예산 (하한)" name="budgetMin">
                  <InputNumber
                    style={{ width: '100%' }}
                    min={0}
                    step={100000}
                    formatter={(v) => (v ? `${Number(v).toLocaleString()}` : '')}
                    parser={(v) => Number((v ?? '').replace(/[^0-9]/g, '')) as 0}
                    placeholder="원"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={5}>
                <Form.Item label="예산 (상한)" name="budgetMax">
                  <InputNumber
                    style={{ width: '100%' }}
                    min={0}
                    step={100000}
                    formatter={(v) => (v ? `${Number(v).toLocaleString()}` : '')}
                    parser={(v) => Number((v ?? '').replace(/[^0-9]/g, '')) as 0}
                    placeholder="원"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={6}>
                <Form.Item label="희망 납기" name="desiredDueDate">
                  <DatePicker style={{ width: '100%' }} placeholder="납기일" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="희망 스타일" name="preferredStyle">
              <Input placeholder="예: 네이비 쓰리피스, 피크 라펠" maxLength={200} />
            </Form.Item>
            <Form.Item
              label="상담 내용"
              name="content"
              rules={[{ required: true, message: '상담 내용을 입력해 주세요.' }]}
            >
              <Input.TextArea rows={4} placeholder="용도·예산·일정·스타일 등 상담 내용" maxLength={2000} showCount />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={consultMutation.isPending}>
              상담 저장
            </Button>
          </Form>
        </Can>
        <List
          dataSource={appointment.consultations}
          locale={{ emptyText: <Empty description="작성된 상담 기록이 없습니다." /> }}
          renderItem={(c) => (
            <List.Item key={c.id}>
              <List.Item.Meta
                title={
                  <Space wrap>
                    <span>{formatDateTime(c.createdAt)}</span>
                    <Typography.Text type="secondary">{c.createdBy}</Typography.Text>
                    {c.interests.map((i) => (
                      <Tag key={i}>{i}</Tag>
                    ))}
                    {c.usageTypeName && <Tag color="blue">{c.usageTypeName}</Tag>}
                    {c.budgetMin != null && (
                      <Tag color="gold">{formatBudget(c.budgetMin, c.budgetMax)}</Tag>
                    )}
                    {c.desiredDueDate && (
                      <Tag color="purple">납기 {c.desiredDueDate.slice(0, 10)}</Tag>
                    )}
                  </Space>
                }
                description={
                  <>
                    {c.preferredStyle && (
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
                        희망 스타일: {c.preferredStyle}
                      </Typography.Paragraph>
                    )}
                    <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                      {c.content}
                    </Typography.Paragraph>
                  </>
                }
              />
            </List.Item>
          )}
        />
      </Card>

      <AppointmentFormModal open={editOpen} appointment={appointment as Appointment} onClose={() => setEditOpen(false)} />

      <Modal
        title="예약 취소"
        open={cancelOpen}
        okText="취소 처리"
        okButtonProps={{ danger: true }}
        cancelText="닫기"
        confirmLoading={cancelMutation.isPending}
        onOk={() => {
          if (!cancelReason.trim()) {
            message.warning('취소 사유를 입력해 주세요.');
            return;
          }
          cancelMutation.mutate(cancelReason.trim());
        }}
        onCancel={() => setCancelOpen(false)}
      >
        <Typography.Paragraph>취소 사유를 입력해 주세요. (필수)</Typography.Paragraph>
        <Input.TextArea
          rows={3}
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder="예: 고객 요청으로 일정 취소"
          maxLength={500}
        />
      </Modal>
    </Space>
  );
}
