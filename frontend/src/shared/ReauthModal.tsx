/**
 * 관리자 재인증 모달 (고객모드 → 관리자 복귀). 설계서 01 §6.2.
 * 비밀번호 1필드 → POST /auth/verify-password 성공 시 onSuccess.
 * 실패는 인라인 오류로 표시하고, 계정 잠금(AUTH_ACCOUNT_LOCKED) 시 로그아웃을 유도한다.
 */
import { LockOutlined } from '@ant-design/icons';
import { App, Alert, Form, Input, Modal } from 'antd';
import { useEffect, useState } from 'react';
import { verifyPassword } from '../api/auth';
import { ApiError } from '../api/client';

interface ReauthForm {
  password: string;
}

interface Props {
  open: boolean;
  onCancel: () => void;
  /** 재인증 성공 시 호출 (호출부에서 모드 전환·네비게이션 수행) */
  onSuccess: () => void;
  /** 계정 잠금 시 호출 (선택) — 로그아웃 유도 */
  onLocked?: () => void;
}

export function ReauthModal({ open, onCancel, onSuccess, onLocked }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ReauthForm>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      form.resetFields();
      setError(null);
    }
  }, [open, form]);

  const handleOk = async () => {
    let values: ReauthForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await verifyPassword(values.password);
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AUTH_ACCOUNT_LOCKED') {
        message.error(err.message);
        onLocked?.();
        onCancel();
        return;
      }
      setError(err instanceof ApiError ? err.message : '재인증에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="관리자 모드로 복귀"
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      okText="확인"
      cancelText="취소"
      confirmLoading={loading}
      destroyOnClose
      afterOpenChange={(o) => {
        if (o) form.getFieldInstance?.('password')?.focus?.();
      }}
    >
      <p style={{ marginTop: 0, color: 'rgba(0,0,0,0.45)' }}>
        관리자 화면으로 돌아가려면 현재 로그인 계정의 비밀번호를 입력하세요.
      </p>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Form<ReauthForm> form={form} layout="vertical" requiredMark={false} onFinish={handleOk}>
        <Form.Item
          name="password"
          label="비밀번호"
          rules={[{ required: true, message: '비밀번호를 입력해 주세요.' }]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="비밀번호" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
}
