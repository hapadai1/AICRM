import {
  CalendarOutlined,
  ColumnHeightOutlined,
  DashboardOutlined,
  FileTextOutlined,
  LogoutOutlined,
  ScissorOutlined,
  SettingOutlined,
  SkinOutlined,
  SwapOutlined,
  TeamOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Layout, Menu, Space, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';

type MenuItem = NonNullable<MenuProps['items']>[number];
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuthStore } from './auth-store';

const { Sider, Header, Content } = Layout;

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clear = useAuthStore((s) => s.clear);
  const {
    token: { colorBgContainer },
  } = theme.useToken();

  const permissions = user?.permissions ?? [];
  const canSeeAdmin =
    permissions.includes('USER_ADMIN') || permissions.includes('ADMIN_MASTER_EDIT');

  const menuItems: MenuItem[] = [
    { key: '/', icon: <DashboardOutlined />, label: '대시보드' },
    { key: '/appointments', icon: <CalendarOutlined />, label: '예약' },
    { key: '/customers', icon: <TeamOutlined />, label: '고객' },
    { key: '/measurements', icon: <ColumnHeightOutlined />, label: '채촌' },
    { key: '/journeys', icon: <SwapOutlined />, label: '진행 현황' },
    { key: '/contracts', icon: <FileTextOutlined />, label: '계약·주문' },
    {
      key: 'g-custom',
      icon: <ScissorOutlined />,
      label: '맞춤 제작',
      children: [
        { key: '/options', label: '옵션 선택' },
        { key: '/work-orders', label: '작업지시서' },
        { key: '/production', label: '제작·입출고' },
      ],
    },
    {
      key: 'g-rental',
      icon: <SwapOutlined />,
      label: '렌탈',
      children: [
        { key: '/rentals', label: '실물 재고' },
        { key: '/rentals/allocate', label: '가용 검색·배정' },
        { key: '/rentals/handover', label: '출고·반납' },
      ],
    },
    { key: '/repairs', icon: <ToolOutlined />, label: '수선' },
    { key: '/payments', icon: <FileTextOutlined />, label: '결제' },
    { key: '/notifications', icon: <CalendarOutlined />, label: '고객 연락' },
    ...(canSeeAdmin
      ? [
          {
            key: 'g-admin',
            icon: <SettingOutlined />,
            label: '관리자',
            children: [
              { key: '/admin/master', label: '기준정보' },
              { key: '/admin/contract-types', label: '계약 구분' },
              { key: '/admin/options', label: '옵션 세트' },
              { key: '/admin/users', label: '사용자·권한' },
              { key: '/admin/audit', label: '감사로그' },
            ],
          } as MenuItem,
        ]
      : []),
  ];

  const leafKeys = menuItems.flatMap((item) => {
    const anyItem = item as { key?: unknown; children?: { key?: unknown }[] };
    return anyItem.children ? anyItem.children.map((c) => String(c.key ?? '')) : [String(anyItem.key ?? '')];
  });
  const selectedKey =
    leafKeys
      .filter((key) => key !== '/' && key !== '' && location.pathname.startsWith(key))
      .sort((a, b) => b.length - a.length)[0] ?? '/';

  const handleLogout = async () => {
    try {
      await api.post('/auth/logout', { refreshToken });
    } catch {
      // 로그아웃 API 실패는 무시한다.
    }
    clear();
    navigate('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth={64}>
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: 1,
          }}
        >
          <SkinOutlined style={{ marginRight: 8 }} />
          AICRM
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            paddingInline: 24,
          }}
        >
          <Space size="middle">
            <Space size="small">
              <Avatar size="small" icon={<UserOutlined />} />
              <Typography.Text strong>{user?.displayName ?? '사용자'}</Typography.Text>
            </Space>
            <Button icon={<LogoutOutlined />} onClick={handleLogout}>
              로그아웃
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
