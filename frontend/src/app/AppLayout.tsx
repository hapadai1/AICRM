import {
  CalendarOutlined,
  ColumnHeightOutlined,
  DashboardOutlined,
  FileTextOutlined,
  LockOutlined,
  LogoutOutlined,
  ScissorOutlined,
  SettingOutlined,
  SkinOutlined,
  SwapOutlined,
  TeamOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Layout, Menu, Space, Tag, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';

type MenuItem = NonNullable<MenuProps['items']>[number];
import { useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useHydrateCodeLabels } from '../api/code-labels';
import { usePageTitleStore } from '../shared/page-title-store';
import { ReauthModal } from '../shared/ReauthModal';
import { useAuthStore } from './auth-store';
import { useModeStore } from './mode-store';

const { Sider, Header, Content } = Layout;

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clear = useAuthStore((s) => s.clear);

  // 고객모드 상태(설계서 01). ADMIN이면 기존 전체 메뉴, CUSTOMER면 4메뉴만.
  const mode = useModeStore((s) => s.mode);
  const selectedCustomerId = useModeStore((s) => s.selectedCustomerId);
  const selectedCustomerName = useModeStore((s) => s.selectedCustomerName);
  const setMode = useModeStore((s) => s.setMode);
  const clearSelectedCustomer = useModeStore((s) => s.clearSelectedCustomer);
  const clearMode = useModeStore((s) => s.clear);
  const [reauthOpen, setReauthOpen] = useState(false);

  const {
    token: { colorBgContainer },
  } = theme.useToken();

  // 코드 상수 기준정보(품목·구성품·수선구분) 표시명을 받아 공유 맵에 반영한다.
  useHydrateCodeLabels();

  const permissions = user?.permissions ?? [];
  const canSeeAdmin =
    permissions.includes('USER_ADMIN') || permissions.includes('ADMIN_MASTER_EDIT');

  const cid = selectedCustomerId;
  // 고객모드 4메뉴(고객·계약관리·스타일컨설팅·채촌) — 선택 고객 1명 컨텍스트로만 이동.
  // 고객 미선택이면 '고객'(검색)만 활성, 나머지는 비활성(설계 §3.1).
  const customerMenuItems: MenuItem[] = [
    { key: cid ? `/c/${cid}` : '/c', icon: <TeamOutlined />, label: '고객' },
    {
      key: cid ? `/c/${cid}/contract` : 'c-contract',
      icon: <FileTextOutlined />,
      label: '계약 관리',
      disabled: !cid,
    },
    {
      key: cid ? `/c/${cid}/consulting` : 'c-consulting',
      icon: <SkinOutlined />,
      label: '스타일 컨설팅',
      disabled: !cid,
    },
    {
      key: cid ? `/c/${cid}/measurement` : 'c-measurement',
      icon: <ColumnHeightOutlined />,
      label: '채촌',
      disabled: !cid,
    },
  ];

  const adminMenuItems: MenuItem[] = [
    { key: '/', icon: <DashboardOutlined />, label: '대시보드' },
    { key: '/journeys', icon: <SwapOutlined />, label: '진행 현황' },
    { key: '/appointments', icon: <CalendarOutlined />, label: '예약' },
    { key: '/customers', icon: <TeamOutlined />, label: '고객' },
    { key: '/contracts', icon: <FileTextOutlined />, label: '계약 관리' },
    { key: '/options', icon: <SkinOutlined />, label: '스타일 컨설팅' },
    // 채촌은 스타일 컨설팅 다음 단계 — 업무 순서대로 바로 아래에 둔다.
    { key: '/measurements', icon: <ColumnHeightOutlined />, label: '채촌' },
    { key: '/production', icon: <ScissorOutlined />, label: '제작 관리' },
    { key: '/repairs', icon: <ToolOutlined />, label: '수선' },
    {
      // 렌탈 메뉴 개칭·순서(설계 S6 §4). path는 유지(딥링크 보존), 라벨·순서만 변경.
      key: 'g-rental',
      icon: <SwapOutlined />,
      label: '렌탈 관리',
      children: [
        { key: '/rentals/allocate', label: '렌탈 예약' },
        { key: '/rentals/handover', label: '출고·반납' },
        { key: '/rentals', label: '렌탈 재고' },
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
              { key: '/admin/notification-templates', label: '연락 문구' },
              { key: '/admin/users', label: '사용자·권한' },
              { key: '/admin/audit', label: '감사로그' },
            ],
          } as MenuItem,
        ]
      : []),
  ];

  const menuItems: MenuItem[] = mode === 'CUSTOMER' ? customerMenuItems : adminMenuItems;

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

  // 헤더 왼쪽에 표시할 현재 페이지(메뉴) 이름. 하위 메뉴는 그 자식 라벨을 쓰고,
  // 상위 그룹명(예: "렌탈 관리")은 경로 표시용으로 따로 담아 둔다.
  const titleByKey = new Map<string, string>();
  const groupByKey = new Map<string, string>();
  for (const item of menuItems) {
    const anyItem = item as { key?: unknown; label?: unknown; children?: { key?: unknown; label?: unknown }[] };
    if (anyItem.children) {
      for (const child of anyItem.children) {
        titleByKey.set(String(child.key ?? ''), String(child.label ?? ''));
        groupByKey.set(String(child.key ?? ''), String(anyItem.label ?? ''));
      }
    } else {
      titleByKey.set(String(anyItem.key ?? ''), String(anyItem.label ?? ''));
    }
  }
  const menuTitle = titleByKey.get(selectedKey) ?? '';
  const menuGroup = groupByKey.get(selectedKey);

  // 상세 화면은 같은 메뉴에 속해 헤더가 목록과 똑같이 보였다("고객" 목록인지 상세인지 구분 불가).
  // 상세 화면이 usePageTitle 로 제목을 지정하면 그 값이 메뉴명을 대신하고,
  // 메뉴명은 그 앞의 경로로 밀려나 지금 어느 메뉴 안인지도 함께 보인다.
  const overrideTitle = usePageTitleStore((s) => s.title);
  const overrideSubtitle = usePageTitleStore((s) => s.subtitle);
  const pageTitle = overrideTitle ?? menuTitle;
  const trail = [menuGroup, overrideTitle ? menuTitle : undefined].filter(Boolean) as string[];

  const handleLogout = async () => {
    try {
      await api.post('/auth/logout', { refreshToken });
    } catch {
      // 로그아웃 API 실패는 무시한다.
    }
    clear();
    clearMode(); // 로그아웃 시 고객모드·선택 고객도 초기화(설계 §7)
    navigate('/login', { replace: true });
  };

  // ADMIN → CUSTOMER: 비밀번호 없이 즉시 전환 후 고객 검색으로(설계 §3.1).
  const enterCustomerMode = () => {
    setMode('CUSTOMER');
    clearSelectedCustomer();
    navigate('/c');
  };

  // CUSTOMER → ADMIN: 재인증 모달 성공 시에만 전환(설계 §3.1·§6).
  const handleReauthSuccess = () => {
    setReauthOpen(false);
    clearMode();
    navigate('/', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth={64}>
        <div
          style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}
        >
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
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <Menu
              theme="dark"
              mode="inline"
              selectedKeys={[selectedKey]}
              items={menuItems}
              onClick={({ key }) => navigate(key)}
            />
          </div>
          {/* 좌측 최하단 [모드 전환] 버튼(설계 §3.1) */}
          <div style={{ padding: 12, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
            {mode === 'ADMIN' ? (
              <Button block icon={<SwapOutlined />} onClick={enterCustomerMode}>
                고객 모드로 전환
              </Button>
            ) : (
              <Button block icon={<LockOutlined />} onClick={() => setReauthOpen(true)}>
                관리자 모드로 복귀
              </Button>
            )}
          </div>
        </div>
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
          <Space align="center" size={8}>
            {trail.length > 0 && (
              <Typography.Text type="secondary">{trail.join(' › ')} ›</Typography.Text>
            )}
            <Typography.Title level={4} style={{ margin: 0 }}>
              {pageTitle}
            </Typography.Title>
            {overrideSubtitle && (
              <Typography.Text type="secondary">{overrideSubtitle}</Typography.Text>
            )}
            {mode === 'CUSTOMER' && (
              <Tag color="processing">
                고객 모드{selectedCustomerName ? ` · ${selectedCustomerName}` : ''}
              </Tag>
            )}
          </Space>
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
      <ReauthModal
        open={reauthOpen}
        onCancel={() => setReauthOpen(false)}
        onSuccess={handleReauthSuccess}
        onLocked={handleLogout}
      />
    </Layout>
  );
}
