/**
 * 고객 등록 모달 (CUST-001) — 예약 없이 방문한 고객을 직접 등록한다.
 * 예약으로 들어온 고객은 예약 등록 시점에 이미 고객으로 만들어진다(설계서 07 D2).
 * 두 경로가 같은 필드를 채우도록 '최초 예약일'도 여기서 입력할 수 있게 두었다.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, DatePicker, Form, Input, InputNumber, Modal } from 'antd';
import type { Dayjs } from 'dayjs';
import { ApiError } from '../../api/client';
import { createCustomer, type CustomerBase, type CustomerSaveBody } from '../../api/customers';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 전화번호 중복으로 막혔을 때 기존 고객 상세로 보낸다 */
  onGoDetail: (customerId: string) => void;
  /**
   * 등록 성공 알림 — 방금 만든 고객을 넘긴다.
   * 목록 조회 범위를 넓히거나(고객관리), 계약서에 바로 연결하는 데(계약 작성) 쓴다.
   */
  onRegistered?: (created: CustomerBase) => void;
}

interface FormValues {
  name: string;
  phone: string;
  heightCm?: number;
  weightKg?: number;
  age?: number;
  email?: string;
  notes?: string;
  firstReservedAt?: Dayjs;
}

export function CustomerRegisterModal({ open, onClose, onGoDetail, onRegistered }: Props) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();

  const close = () => {
    form.resetFields();
    onClose();
  };

  const createMutation = useMutation({
    mutationFn: (body: CustomerSaveBody) => createCustomer(body),
    onSuccess: (created) => {
      message.success(`고객 "${created.name}"을(를) 등록했습니다.`);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onRegistered?.(created);
      close();
    },
    onError: (e) => {
      // 동일 전화번호 활성 고객은 차단하고 기존 고객을 제시한다 (문서 03 §5.1)
      if (e instanceof ApiError && e.code === 'CUSTOMER_PHONE_DUPLICATE') {
        const existing = (e.details as { existingCustomer?: { id: string; name: string } } | undefined)
          ?.existingCustomer;
        if (existing) {
          modal.confirm({
            title: '이미 등록된 전화번호입니다.',
            content: `"${existing.name}" 고객이 같은 전화번호로 등록되어 있습니다. 해당 고객으로 이동할까요?`,
            okText: '고객 상세로 이동',
            cancelText: '닫기',
            onOk: () => {
              close();
              onGoDetail(existing.id);
            },
          });
          return;
        }
      }
      message.error(e instanceof ApiError ? e.message : '고객 등록에 실패했습니다.');
    },
  });

  return (
    <Modal
      title="고객 등록"
      open={open}
      okText="등록"
      cancelText="취소"
      confirmLoading={createMutation.isPending}
      onOk={() => {
        void form.validateFields().then(({ firstReservedAt, ...values }) =>
          createMutation.mutate({
            ...values,
            firstReservedAt: firstReservedAt?.toISOString(),
          }),
        );
      }}
      onCancel={close}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label="이름" name="name" rules={[{ required: true, message: '이름을 입력해 주세요.' }]}>
          <Input maxLength={30} />
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
        <Form.Item label="키 (cm)" name="heightCm">
          <InputNumber style={{ width: '100%' }} min={0} max={300} placeholder="예: 175" />
        </Form.Item>
        <Form.Item label="몸무게 (kg)" name="weightKg">
          <InputNumber style={{ width: '100%' }} min={0} max={500} step={0.1} placeholder="예: 68.5" />
        </Form.Item>
        <Form.Item label="나이" name="age">
          <InputNumber style={{ width: '100%' }} min={0} max={150} placeholder="예: 32" />
        </Form.Item>
        <Form.Item label="이메일" name="email" rules={[{ type: 'email', message: '이메일 형식이 아닙니다.' }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item label="최초 예약일" name="firstReservedAt" tooltip="예약으로 등록된 고객은 자동으로 기록됩니다.">
          <DatePicker style={{ width: '100%' }} placeholder="선택 안 함" />
        </Form.Item>
        <Form.Item label="메모" name="notes">
          <Input.TextArea rows={3} maxLength={1000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
