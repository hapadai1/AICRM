/**
 * 계약서 작성 전 고객 정보 보완 모달 (설계서 07 §4.3)
 *
 * 신규 계약은 [고객 검색 → 정보 보완 → 계약서] 순서로 진행한다.
 * 이름·전화는 예약이든 수기 등록이든 항상 채워져 있으므로 게이트가 되지 못한다.
 * 실제로 비어 있는 채 계약까지 흘러가는 값은 엑셀 작업지시서에 쓰이는 신체 정보다.
 *
 * 게이트는 프런트에만 둔다 — 계약 확정 API에 넣으면 이미 저장된 계약이 소급 실패하고,
 * 신체 정보는 채촌 단계에서 정정될 수 있다.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Form, InputNumber, Modal, Space, Typography } from 'antd';
import { useEffect } from 'react';
import { ApiError } from '../../api/client';
import type { CustomerSummary } from '../../api/contracts';
import { updateCustomer } from '../../api/customers';

/** 계약서로 넘어가기 전 채워져 있어야 하는 고객 필드 (설계서 07 D7) */
const REQUIRED_BODY_FIELDS = ['heightCm', 'weightKg', 'age'] as const;

/** 하나라도 비어 있으면 보완 대상이다. 0은 유효값이 아니므로 null/undefined만 결손으로 본다. */
export function isCustomerInfoIncomplete(customer?: CustomerSummary | null): boolean {
  if (!customer) return false;
  return REQUIRED_BODY_FIELDS.some((field) => customer[field] == null);
}

interface FormValues {
  heightCm: number;
  weightKg: number;
  age: number;
}

interface Props {
  open: boolean;
  customer: CustomerSummary;
  /** 보완 저장 완료 — 호출부는 계약서 작성을 이어간다 */
  onDone: () => void;
  /** 고객을 다시 고르겠다는 뜻. 호출부가 검색 팝업을 다시 연다 */
  onPickAgain: () => void;
}

export function CustomerInfoGateModal({ open, customer, onDone, onPickAgain }: Props) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();

  // 이미 채워진 값은 그대로 보여준다 — 일부만 비어 있는 경우가 더 흔하다.
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      heightCm: customer.heightCm ?? undefined,
      weightKg: customer.weightKg == null ? undefined : Number(customer.weightKg),
      age: customer.age ?? undefined,
    });
  }, [open, customer, form]);

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => updateCustomer(customer.id, { ...values, version: customer.version }),
    onSuccess: () => {
      // 계약서 화면이 읽는 전용 캐시 키. 무효화해야 보완한 값이 곧바로 반영된다.
      void queryClient.invalidateQueries({ queryKey: ['customer-summary', customer.id] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onDone();
    },
    onError: (e) => {
      message.error(e instanceof ApiError ? e.message : '고객 정보 저장에 실패했습니다.');
    },
  });

  return (
    <Modal
      title="고객 정보 확인"
      open={open}
      onCancel={onPickAgain}
      okText="저장하고 계약서 작성"
      cancelText="고객 다시 선택"
      confirmLoading={saveMutation.isPending}
      onOk={() => void form.validateFields().then((values) => saveMutation.mutate(values))}
      maskClosable={false}
      destroyOnClose
      width={480}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert type="info" message={`${customer.name} · ${customer.phone}`} />
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="키 (cm)" name="heightCm" rules={[{ required: true, message: '키를 입력해 주세요.' }]}>
            <InputNumber style={{ width: '100%' }} min={0} max={300} precision={0} autoFocus />
          </Form.Item>
          <Form.Item label="체중 (kg)" name="weightKg" rules={[{ required: true, message: '체중을 입력해 주세요.' }]}>
            <InputNumber style={{ width: '100%' }} min={0} max={500} precision={1} />
          </Form.Item>
          <Form.Item label="나이" name="age" rules={[{ required: true, message: '나이를 입력해 주세요.' }]}>
            <InputNumber style={{ width: '100%' }} min={0} max={150} precision={0} />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary">
          고객 상세에서도 언제든 수정할 수 있습니다.
        </Typography.Text>
      </Space>
    </Modal>
  );
}
