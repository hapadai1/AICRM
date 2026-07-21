import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, request } from '../api/client';
import { type AuthUser, useAuthStore } from './auth-store';

interface LoginForm {
  loginId: string;
  password: string;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export function LoginPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: LoginForm) => {
    setLoading(true);
    try {
      const result = await request<LoginResponse>({
        method: 'POST',
        url: '/auth/login',
        data: { loginId: values.loginId, password: values.password },
      });
      setAuth(result);
      const redirect = searchParams.get('redirect');
      navigate(redirect && redirect.startsWith('/') ? redirect : '/', { replace: true });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '로그인에 실패했습니다.';
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            AICRM
          </Typography.Title>
          <Typography.Text type="secondary">맞춤 정장·렌탈 매장 CRM</Typography.Text>
          {/* 개발 편의: 시드 계정을 화면에 노출하고 폼에 기본 입력해 둔다. 운영 배포 전 제거할 것. */}
          <div style={{ marginTop: 12 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              개발용 계정 — 아이디 <Typography.Text code>admin</Typography.Text> / 비밀번호{' '}
              <Typography.Text code>admin1234!</Typography.Text>
            </Typography.Text>
          </div>
        </div>
        <Form<LoginForm>
          layout="vertical"
          onFinish={onFinish}
          requiredMark={false}
          initialValues={{ loginId: 'admin', password: 'admin1234!' }}
        >
          <Form.Item
            name="loginId"
            label="아이디"
            rules={[{ required: true, message: '아이디를 입력해 주세요.' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="아이디" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="비밀번호"
            rules={[{ required: true, message: '비밀번호를 입력해 주세요.' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="비밀번호" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={loading}>
              로그인
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
