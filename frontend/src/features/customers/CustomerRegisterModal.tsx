/**
 * 고객 등록 모달 (CUST-001)
 * - 1단계에서 전화번호로 기존 고객을 먼저 조회한다. 전화번호가 유니크 키이므로 판정이 확정적이다.
 * - 없으면 신규 등록, 있으면 기존 고객(대부분 예약으로 생긴 PROSPECT)을 이어받는다.
 *   사용자가 "신규 등록"과 "예약 고객 가져오기"를 미리 판단할 필요가 없다.
 */
import { ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Descriptions, Form, Input, Modal, Space, Typography } from 'antd';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  createCustomer,
  findCustomerByPhone,
  updateCustomer,
  type CustomerBase,
  type CustomerSaveBody,
} from '../../api/customers';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { CUSTOMER_STATUS_META } from './customer-constants';

const PHONE_PATTERN = /^[\d-]{9,13}$/;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 기존 고객을 이어받았을 때 상세로 이동시킨다 */
  onGoDetail: (customerId: string) => void;
}

type Step = 'phone' | 'form';

interface FormValues {
  name: string;
  email?: string;
  notes?: string;
}

export function CustomerRegisterModal({ open, onClose, onGoDetail }: Props) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string>();
  /** 조회된 기존 고객. null이면 신규 등록 모드 */
  const [found, setFound] = useState<CustomerBase | null>(null);

  const reset = () => {
    setStep('phone');
    setPhone('');
    setPhoneError(undefined);
    setFound(null);
    form.resetFields();
  };

  const close = () => {
    reset();
    onClose();
  };

  const lookupMutation = useMutation({
    mutationFn: (value: string) => findCustomerByPhone(value),
    onSuccess: (customer) => {
      setFound(customer);
      form.setFieldsValue({
        name: customer?.name ?? '',
        email: customer?.email ?? undefined,
        notes: customer?.notes ?? undefined,
      });
      setStep('form');
    },
    onError: (e) => {
      message.error(e instanceof ApiError ? e.message : '고객 조회에 실패했습니다.');
    },
  });

  const createMutation = useMutation({
    mutationFn: (body: CustomerSaveBody) => createCustomer(body),
    onSuccess: (created) => {
      message.success(`고객 "${created.name}"을(를) 등록했습니다.`);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      close();
    },
    onError: (e) => {
      message.error(e instanceof ApiError ? e.message : '고객 등록에 실패했습니다.');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: CustomerSaveBody }) => updateCustomer(id, body),
    onSuccess: (updated) => {
      message.success(`고객 "${updated.name}" 정보를 저장했습니다.`);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      close();
      onGoDetail(updated.id);
    },
    onError: (e) => {
      message.error(e instanceof ApiError ? e.message : '고객 정보 저장에 실패했습니다.');
    },
  });

  const runLookup = () => {
    const value = phone.trim();
    if (!PHONE_PATTERN.test(value)) {
      setPhoneError('숫자와 하이픈으로 9~13자리를 입력해 주세요.');
      return;
    }
    setPhoneError(undefined);
    lookupMutation.mutate(value);
  };

  const submit = () => {
    void form.validateFields().then((values) => {
      if (found) {
        updateMutation.mutate({
          id: found.id,
          body: { ...values, phone: found.phone, version: found.version },
        });
      } else {
        createMutation.mutate({ ...values, phone: phone.trim() });
      }
    });
  };

  const isInactive = found?.customerStatus === 'INACTIVE';
  const pending = createMutation.isPending || updateMutation.isPending;

  const footer = (() => {
    if (step === 'phone') {
      return [
        <Button key="cancel" onClick={close}>
          취소
        </Button>,
        <Button key="next" type="primary" loading={lookupMutation.isPending} onClick={runLookup}>
          다음
        </Button>,
      ];
    }
    const back = (
      <Button key="back" icon={<ArrowLeftOutlined />} onClick={() => setStep('phone')}>
        전화번호 다시 입력
      </Button>
    );
    if (isInactive) {
      return [
        back,
        <Button key="detail" type="primary" onClick={() => { const id = found.id; close(); onGoDetail(id); }}>
          고객 상세로 이동
        </Button>,
      ];
    }
    if (found) {
      return [
        back,
        <Button key="detail" onClick={() => { const id = found.id; close(); onGoDetail(id); }}>
          그대로 상세로 이동
        </Button>,
        <Button key="save" type="primary" loading={pending} onClick={submit}>
          정보 저장 후 이동
        </Button>,
      ];
    }
    return [
      back,
      <Button key="create" type="primary" loading={pending} onClick={submit}>
        등록
      </Button>,
    ];
  })();

  return (
    <Modal
      title="고객 등록"
      open={open}
      onCancel={close}
      footer={footer}
      destroyOnClose={false}
      maskClosable={false}
    >
      {step === 'phone' ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            전화번호로 먼저 조회합니다. 예약으로 이미 등록된 고객이면 이어서 진행합니다.
          </Typography.Text>
          <Form layout="vertical">
            <Form.Item
              label="전화번호"
              required
              validateStatus={phoneError ? 'error' : undefined}
              help={phoneError}
            >
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  placeholder="010-0000-0000"
                  maxLength={13}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onPressEnter={runLookup}
                  autoFocus
                />
                <Button
                  icon={<SearchOutlined />}
                  loading={lookupMutation.isPending}
                  onClick={runLookup}
                >
                  조회
                </Button>
              </Space.Compact>
            </Form.Item>
          </Form>
        </Space>
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {found ? (
            <>
              <Alert
                type={isInactive ? 'warning' : 'info'}
                showIcon
                message={
                  isInactive
                    ? '비활성 상태의 고객입니다.'
                    : '이미 등록된 고객입니다. 이어서 진행합니다.'
                }
                description={
                  isInactive
                    ? '재활성화는 고객 상세 화면에서 처리해 주세요.'
                    : undefined
                }
              />
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="고객명">{found.name}</Descriptions.Item>
                <Descriptions.Item label="전화번호">{found.phone}</Descriptions.Item>
                <Descriptions.Item label="상태">
                  <StatusBadge
                    label={metaOf(CUSTOMER_STATUS_META, found.customerStatus).label}
                    color={metaOf(CUSTOMER_STATUS_META, found.customerStatus).color}
                  />
                </Descriptions.Item>
                <Descriptions.Item label="최초 예약일">
                  {found.firstReservedAt?.slice(0, 10) ?? '-'}
                </Descriptions.Item>
              </Descriptions>
            </>
          ) : (
            <Alert
              type="success"
              showIcon
              message={`${phone.trim()} — 등록된 고객이 없습니다. 신규로 등록합니다.`}
            />
          )}

          {!isInactive && (
            <Form form={form} layout="vertical" requiredMark>
              <Form.Item label="이름" name="name" rules={[{ required: true, message: '이름을 입력해 주세요.' }]}>
                <Input maxLength={30} />
              </Form.Item>
              <Form.Item label="이메일" name="email" rules={[{ type: 'email', message: '이메일 형식이 아닙니다.' }]}>
                <Input maxLength={100} />
              </Form.Item>
              <Form.Item label="메모" name="notes">
                <Input.TextArea rows={3} maxLength={1000} />
              </Form.Item>
            </Form>
          )}
        </Space>
      )}
    </Modal>
  );
}
