import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, DatePicker, Form, Input, Modal, Select, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect } from 'react';
import {
  createAppointment,
  fetchAppointmentPurposes,
  updateAppointment,
  type Appointment,
} from '../../api/appointments';
import { ApiError } from '../../api/client';
import { findCustomerByPhone } from '../../api/customers';
import { CUSTOMER_STATUS_META } from '../customers/customer-constants';

interface FormValues {
  customerName: string;
  phone: string;
  purposeCode: string;
  startAt: Dayjs;
  durationMinutes: number;
  memo?: string;
}

interface AppointmentFormModalProps {
  open: boolean;
  /** 있으면 수정 모드, 없으면 신규 CRM 예약 */
  appointment?: Appointment;
  /** 신규 작성 시 기본 예약일 */
  defaultDate?: Dayjs;
  onClose: () => void;
}

/** APPT-001 예약 추가 / APPT-002 예약 수정 공용 모달 */
export function AppointmentFormModal({ open, appointment, defaultDate, onClose }: AppointmentFormModalProps) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const isEdit = !!appointment;

  const { data: purposes } = useQuery({
    queryKey: ['appointment-purposes'],
    queryFn: fetchAppointmentPurposes,
    staleTime: 5 * 60_000,
  });

  const phoneValue = Form.useWatch('phone', form);
  const phoneDigits = (phoneValue ?? '').replace(/\D/g, '');
  // 전화번호 입력 시 기존 고객 자동 후보 (문서 03 §4.4)
  const { data: matchedCustomer } = useQuery({
    queryKey: ['customers', 'by-phone', phoneDigits],
    queryFn: () => findCustomerByPhone(phoneDigits),
    enabled: open && phoneDigits.length >= 10,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!open) return;
    if (appointment) {
      form.setFieldsValue({
        customerName: appointment.customerName,
        phone: appointment.phone,
        purposeCode: appointment.purposeCode,
        startAt: dayjs(appointment.startAt),
        durationMinutes: Math.max(
          30,
          dayjs(appointment.endAt).diff(dayjs(appointment.startAt), 'minute'),
        ),
        memo: appointment.memo,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        startAt: (defaultDate ?? dayjs()).hour(11).minute(0),
        durationMinutes: 60,
      });
    }
  }, [open, appointment, defaultDate, form]);

  const saveMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      // 요청은 scheduledStart/scheduledEnd/notes (계약 문서 04 §1) — 응답 뷰 필드(startAt/endAt/memo)와 다르다.
      const body = {
        customerName: values.customerName.trim(),
        phone: values.phone.trim(),
        purposeCode: values.purposeCode,
        scheduledStart: values.startAt.second(0).format('YYYY-MM-DDTHH:mm:ssZ'),
        scheduledEnd: values.startAt.add(values.durationMinutes, 'minute').second(0).format('YYYY-MM-DDTHH:mm:ssZ'),
        notes: values.memo,
      };
      if (isEdit && appointment) {
        // 수정 시 고객명·전화는 예약이 아니라 고객 소관이라 보내지 않는다(백엔드 미지원).
        const { customerName: _n, phone: _p, ...editable } = body;
        return updateAppointment(appointment.id, { ...editable, version: appointment.version });
      }
      return createAppointment(body);
    },
    onSuccess: () => {
      message.success(isEdit ? '예약을 수정했습니다.' : '예약을 등록했습니다.');
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    },
    onError: (e) => {
      message.error(e instanceof ApiError ? e.message : '저장에 실패했습니다.');
    },
  });

  const statusMeta = matchedCustomer ? CUSTOMER_STATUS_META[matchedCustomer.customerStatus] : undefined;

  return (
    <Modal
      title={isEdit ? '예약 수정' : '예약 추가'}
      open={open}
      onCancel={onClose}
      okText="저장"
      cancelText="취소"
      confirmLoading={saveMutation.isPending}
      onOk={() => {
        void form.validateFields().then((values) => saveMutation.mutate(values));
      }}
      destroyOnClose
    >
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item
          label="고객 이름"
          name="customerName"
          rules={[{ required: true, message: '고객 이름을 입력해 주세요.' }]}
        >
          <Input placeholder="예: 김민준" maxLength={30} />
        </Form.Item>
        <Form.Item
          label="전화번호"
          name="phone"
          rules={[
            { required: true, message: '전화번호를 입력해 주세요.' },
            { pattern: /^[\d-]{9,13}$/, message: '숫자와 하이픈만 입력해 주세요.' },
          ]}
        >
          <Input placeholder="010-0000-0000" maxLength={13} />
        </Form.Item>
        {matchedCustomer && matchedCustomer.id !== appointment?.customerId && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={
              <span>
                동일 전화번호의 기존 고객이 있습니다: <b>{matchedCustomer.name}</b>{' '}
                {statusMeta && <Tag color={statusMeta.color}>{statusMeta.label}</Tag>}
                — 저장 시 이 고객으로 연결됩니다.
              </span>
            }
          />
        )}
        <Form.Item
          label="예약 목적"
          name="purposeCode"
          rules={[{ required: true, message: '예약 목적을 선택해 주세요.' }]}
        >
          <Select
            placeholder="목적 선택"
            options={(purposes ?? []).map((p) => ({ value: p.code, label: p.name }))}
          />
        </Form.Item>
        <Form.Item
          label="예약 일시"
          name="startAt"
          rules={[{ required: true, message: '예약 일시를 선택해 주세요.' }]}
        >
          <DatePicker
            showTime={{ format: 'HH:mm', minuteStep: 30 }}
            format="YYYY-MM-DD HH:mm"
            style={{ width: '100%' }}
          />
        </Form.Item>
        <Form.Item
          label="소요 시간"
          name="durationMinutes"
          rules={[{ required: true, message: '소요 시간을 선택해 주세요.' }]}
        >
          <Select
            options={[
              { value: 30, label: '30분' },
              { value: 60, label: '1시간' },
              { value: 90, label: '1시간 30분' },
              { value: 120, label: '2시간' },
            ]}
          />
        </Form.Item>
        <Form.Item label="메모" name="memo">
          <Input.TextArea rows={3} placeholder="예약 관련 메모" maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
