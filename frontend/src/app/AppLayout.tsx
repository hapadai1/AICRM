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
import { useHydrateCodeLabels } from '../api/code-labels';
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

  // 코드 상수 기준정보(품목·구성품·수선구분) 표시명을 받아 공유 맵에 반영한다.
  useHydrateCodeLabels();

  const permissions = user?.permissions ?? [];
  const canSeeAdmin =
    permissions.includes('USER_ADMIN') || permissions.includes('ADMIN_MASTER_EDIT');

  const menuItems: MenuItem[] = [
    { key: '/', icon: <DashboardOutlined />, label: '대시보드' },
    { key: '/journeys', icon: <SwapOutlined />, label: '진행 현황' },
    { key: '/appointments', icon: <CalendarOutlined />, label: '예약' },
    { key: '/customers', icon: <TeamOutlined />, label: '고객' },
    { key: '/contracts', icon: <FileTextOutlined />, label: '계약 관리' },
    { key: '/options', icon: <SkinOutlined />, label: '스타일 컨설팅' },
    { key: '/production', icon: <ScissorOutlined />, label: '제작 관리' },
    { key: '/measurements', icon: <ColumnHeightOutlined />, label: '채촌' },
    { key: '/repairs', icon: <ToolOutlined />, label: '수선' },
    { key: '/payments', icon: <FileTextOutlined />, label: '결제' },
    {
      key: 'g-rental',
      icon: <SwapOutlined />,
      label: '렌탈 관리',
      children: [
        { key: '/rentals', label: '실물 재고' },
        { key: '/rentals/allocate', label: '가용 검색·배정' },
        { key: '/rentals/handover', label: '출고·반납' },
      ],
    },
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
  // 계약 하위 흐름 경로(자체 메뉴 없음)를 실제 소속 메뉴로 보정한다.
  // 예: /contracts/:id/options 는 계약 URL이지만 "스타일 컨설팅" 메뉴 흐름이다.
  const pathToMenu: { test: RegExp; key: string }[] = [
    { test: /^\/contracts\/[^/]+\/options/, key: '/options' },
    { test: /^\/contracts\/[^/]+\/production/, key: '/production' },
    { test: /^\/orders\//, key: '/contracts' },
  ];
  const overrideKey = pathToMenu.find((o) => o.test.test(location.pathname))?.key;
  const selectedKey =
    overrideKey ??
    leafKeys
      .filter((key) => key !== '/' && key !== '' && location.pathname.startsWith(key))
      .sort((a, b) => b.length - a.length)[0] ??
    '/';

  // 헤더 왼쪽에 표시할 현재 페이지(메뉴) 이름. 하위 메뉴는 그 자식 라벨을 쓴다.
  const titleByKey = new Map<string, string>();
  for (const item of menuItems) {
    const anyItem = item as { key?: unknown; label?: unknown; children?: { key?: unknown; label?: unknown }[] };
    if (anyItem.children) {
      for (const child of anyItem.children) titleByKey.set(String(child.key ?? ''), String(child.label ?? ''));
    } else {
      titleByKey.set(String(anyItem.key ?? ''), String(anyItem.label ?? ''));
    }
  }
  const pageTitle = titleByKey.get(selectedKey) ?? '';

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
            justifyContent: 'space-between',
            paddingInline: 24,
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            {pageTitle}
          </Typography.Title>
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
