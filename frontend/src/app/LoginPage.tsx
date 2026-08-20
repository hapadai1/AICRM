import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { App, Button, Card, Form, Input, Typography, theme } from 'antd';
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
  const { token } = theme.useToken();
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
        background: token.colorBgLayout,
      }}
    >
      <Card style={{ width: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            AICRM
          </Typography.Title>
          <Typography.Text type="secondary">맞춤 정장·렌탈 매장 CRM</Typography.Text>
        </div>
        <Form<LoginForm>
          layout="vertical"
          onFinish={onFinish}
          requiredMark={false}
          /*
            고객 테스트 단계라 운영 빌드에서도 시드 계정을 채워 둔다 — 접속해서 [로그인]만
            누르면 되게 한다. 실사용 계정을 나눠 주기 전에 이 프리필을 걷어내야 한다.
          */
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
