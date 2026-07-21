/**
 * ADMIN-003 사용자·기능 권한
 * - 사용자 목록(상태)·추가·비활성
 * - 역할 목록 + 역할별 권한 체크표(도메인 × 조회/수정/확정/출력 그룹)
 */
import { PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import {
  createUser,
  deactivateUser,
  fetchPermissions,
  fetchRoles,
  fetchUsers,
  saveRolePermissions,
} from '../../api/admin';
import type { AdminUser, PermissionDef } from '../../api/admin';
import { ApiError } from '../../api/client';

const PERMISSION_GROUPS = ['조회', '수정', '확정', '출력'] as const;

interface CreateUserValues {
  loginId: string;
  name: string;
  roleId: string;
}

export function AdminUsersPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [checkedPermissions, setCheckedPermissions] = useState<Set<string>>(new Set());
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const [createForm] = Form.useForm<CreateUserValues>();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const usersQuery = useQuery({ queryKey: ['users'], queryFn: fetchUsers });
  const rolesQuery = useQuery({ queryKey: ['roles'], queryFn: fetchRoles });
  const permissionsQuery = useQuery({ queryKey: ['permissions'], queryFn: fetchPermissions });

  const roles = rolesQuery.data ?? [];
  const selectedRole = roles.find((r) => r.id === selectedRoleId);

  // 역할 목록 로드 시 첫 역할 선택
  useEffect(() => {
    if (!selectedRoleId && roles.length > 0) setSelectedRoleId(roles[0].id);
  }, [roles, selectedRoleId]);

  // 역할 변경 시 체크 상태 초기화
  useEffect(() => {
    if (selectedRole) {
      setCheckedPermissions(new Set(selectedRole.permissions));
      setPermissionsDirty(false);
    }
  }, [selectedRole]);

  const onApiError = (e: unknown) =>
    message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');

  const createMutation = useMutation({
    mutationFn: (values: CreateUserValues) => createUser(values),
    onSuccess: () => {
      setCreateOpen(false);
      createForm.resetFields();
      message.success('사용자가 추가되었습니다.');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: onApiError,
  });

  const deactivateMutation = useMutation({
    mutationFn: deactivateUser,
    onSuccess: () => {
      message.success('계정이 비활성화되었습니다.');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: onApiError,
  });

  const savePermissionsMutation = useMutation({
    mutationFn: () => saveRolePermissions(selectedRoleId!, Array.from(checkedPermissions)),
    onSuccess: () => {
      message.success('권한이 저장되었습니다.');
      setPermissionsDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: onApiError,
  });

  const userColumns: ColumnsType<AdminUser> = [
    { title: '아이디', dataIndex: 'loginId', width: 120 },
    { title: '이름', dataIndex: 'name', width: 100 },
    { title: '역할', dataIndex: 'roleName', width: 110 },
    { title: '등록일', dataIndex: 'createdAt', width: 110 },
    {
      title: '상태',
      dataIndex: 'status',
      width: 90,
      render: (s: AdminUser['status']) =>
        s === 'ACTIVE' ? <Tag color="green">활성</Tag> : <Tag color="red">비활성</Tag>,
    },
    {
      title: '작업',
      key: 'action',
      width: 100,
      render: (_, user) =>
        user.status === 'ACTIVE' ? (
          <Popconfirm
            title={`${user.name} 계정을 비활성화할까요?`}
            description="비활성 계정은 로그인할 수 없지만 과거 작성 이력은 유지됩니다."
            okText="비활성화"
            cancelText="취소"
            onConfirm={() => deactivateMutation.mutate(user.id)}
          >
            <Button size="small" danger>
              비활성
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  /** 도메인별 권한을 그룹 열로 배치한 체크표 데이터 */
  const permissionRows = useMemo(() => {
    const defs = permissionsQuery.data ?? [];
    const domains = Array.from(new Set(defs.map((d) => d.domain)));
    return domains.map((domain) => ({
      domain,
      byGroup: PERMISSION_GROUPS.reduce<Record<string, PermissionDef[]>>((acc, group) => {
        acc[group] = defs.filter((d) => d.domain === domain && d.group === group);
        return acc;
      }, {}),
    }));
  }, [permissionsQuery.data]);

  const togglePermission = (code: string, checked: boolean) => {
    setCheckedPermissions((prev) => {
      const next = new Set(prev);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
    setPermissionsDirty(true);
  };

  type PermissionRow = (typeof permissionRows)[number];
  const permissionColumns: ColumnsType<PermissionRow> = [
    { title: '업무 영역', dataIndex: 'domain', width: 110, fixed: 'left' },
    ...PERMISSION_GROUPS.map(
      (group) =>
        ({
          title: group,
          key: group,
          render: (_, row: PermissionRow) => (
            <Space direction="vertical" size={2}>
              {row.byGroup[group].map((def) => (
                <Checkbox
                  key={def.code}
                  checked={checkedPermissions.has(def.code)}
                  onChange={(e) => togglePermission(def.code, e.target.checked)}
                >
                  {def.label}
                </Checkbox>
              ))}
              {row.byGroup[group].length === 0 && (
                <Typography.Text type="secondary">-</Typography.Text>
              )}
            </Space>
          ),
        }) as ColumnsType<PermissionRow>[number],
    ),
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="사용자 목록"
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            사용자 추가
          </Button>
        }
      >
        <Table<AdminUser>
          rowKey="id"
          size="small"
          loading={usersQuery.isLoading}
          dataSource={usersQuery.data ?? []}
          columns={userColumns}
          pagination={false}
        />
      </Card>

      <Card
        size="small"
        title="역할별 기능 권한"
        extra={
          <Button
            type="primary"
            size="small"
            icon={<SaveOutlined />}
            disabled={!permissionsDirty}
            loading={savePermissionsMutation.isPending}
            onClick={() => savePermissionsMutation.mutate()}
          >
            권한 저장
          </Button>
        }
      >
        <Row gutter={[16, 16]}>
          <Col span={24}>
            <Space wrap>
              <Typography.Text>역할</Typography.Text>
              <Radio.Group
                value={selectedRoleId ?? undefined}
                onChange={(e) => setSelectedRoleId(e.target.value as string)}
                optionType="button"
                buttonStyle="solid"
                options={roles.map((r) => ({ value: r.id, label: r.name }))}
              />
              {selectedRole?.description && (
                <Typography.Text type="secondary">{selectedRole.description}</Typography.Text>
              )}
            </Space>
          </Col>
          <Col span={24}>
            {permissionsDirty && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="저장되지 않은 권한 변경이 있습니다."
              />
            )}
            <Table<PermissionRow>
              rowKey="domain"
              size="small"
              loading={permissionsQuery.isLoading || rolesQuery.isLoading}
              dataSource={permissionRows}
              columns={permissionColumns}
              pagination={false}
              scroll={{ x: 900 }}
            />
          </Col>
        </Row>
      </Card>

      <Modal
        title="사용자 추가"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="추가"
        cancelText="취소"
        confirmLoading={createMutation.isPending}
        onOk={() => void createForm.validateFields().then((values) => createMutation.mutate(values))}
        destroyOnClose
      >
        <Form<CreateUserValues> form={createForm} layout="vertical">
          <Form.Item
            label="아이디"
            name="loginId"
            rules={[{ required: true, message: '아이디를 입력해 주세요.' }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="이름"
            name="name"
            rules={[{ required: true, message: '이름을 입력해 주세요.' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            label="역할"
            name="roleId"
            rules={[{ required: true, message: '역할을 선택해 주세요.' }]}
          >
            <Select options={roles.map((r) => ({ value: r.id, label: r.name }))} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
