/**
 * ADMIN-001 기준정보 관리
 * - 탭: 예약 목적 / 품목·구성품 / 결제수단 / 수선 구분
 * - 표시명·정렬·사용여부 편집, 시스템 코드는 삭제(사용 중지) 불가 표시
 */
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { createMaster, fetchMaster, updateMaster } from '../../api/admin';
import type { MasterItem, MasterType } from '../../api/admin';
import { ApiError } from '../../api/client';

interface EditFormValues {
  name: string;
  sortOrder: number;
}

interface CreateFormValues {
  code: string;
  name: string;
  sortOrder?: number;
}

/** 단일 기준정보 타입의 표 + 추가/수정/사용여부 토글 */
function MasterTable({ type, title }: { type: MasterType; title: string }) {
  const backendPending = type !== 'appointment-purposes';
  const [editTarget, setEditTarget] = useState<MasterItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editForm] = Form.useForm<EditFormValues>();
  const [createForm] = Form.useForm<CreateFormValues>();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  // 백엔드 미지원 타입은 실서버에서 404가 날 수 있으므로 재시도 없이 조회하고, 실패해도 화면이 깨지지 않게 한다.
  const listQuery = useQuery({
    queryKey: ['admin', 'master', type],
    queryFn: () => fetchMaster(type),
    retry: backendPending ? false : undefined,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['admin', 'master', type] });
  const onApiError = (e: unknown) =>
    message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');

  const createMutation = useMutation({
    mutationFn: (values: CreateFormValues) => createMaster(type, values),
    onSuccess: () => {
      setCreateOpen(false);
      createForm.resetFields();
      message.success('기준정보가 추가되었습니다.');
      invalidate();
    },
    onError: onApiError,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { name?: string; sortOrder?: number; active?: boolean } }) =>
      updateMaster(type, id, payload),
    onSuccess: () => {
      setEditTarget(null);
      message.success('저장되었습니다.');
      invalidate();
    },
    onError: onApiError,
  });

  const columns: ColumnsType<MasterItem> = [
    { title: '코드', dataIndex: 'code', width: 200 },
    { title: '표시명', dataIndex: 'name' },
    { title: '정렬', dataIndex: 'sortOrder', width: 70, align: 'center' },
    {
      title: '사용여부',
      dataIndex: 'active',
      width: 110,
      render: (active: boolean, row) => (
        <Tooltip title={row.system && active ? '시스템 코드는 사용 중지할 수 없습니다.' : undefined}>
          <Switch
            size="small"
            checked={active}
            disabled={row.system && active}
            checkedChildren="사용"
            unCheckedChildren="중지"
            loading={updateMutation.isPending && updateMutation.variables?.id === row.id}
            onChange={(next) =>
              updateMutation.mutate({ id: row.id, payload: { active: next } })
            }
          />
        </Tooltip>
      ),
    },
    {
      title: '구분',
      dataIndex: 'system',
      width: 160,
      render: (system: boolean) =>
        system ? (
          <Tooltip title="상태 전이 로직과 연결된 코드로 삭제·사용 중지가 제한됩니다.">
            <Tag color="geekblue">시스템 코드 · 삭제 불가</Tag>
          </Tooltip>
        ) : (
          <Tag>일반</Tag>
        ),
    },
    {
      title: '작업',
      key: 'action',
      width: 80,
      render: (_, row) => (
        <Button
          size="small"
          onClick={() => {
            setEditTarget(row);
            editForm.setFieldsValue({ name: row.name, sortOrder: row.sortOrder });
          }}
        >
          수정
        </Button>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title={title}
      extra={
        <Button
          size="small"
          icon={<PlusOutlined />}
          disabled={backendPending && listQuery.isError}
          onClick={() => setCreateOpen(true)}
        >
          추가
        </Button>
      }
    >
      {backendPending && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="백엔드 연동 예정"
          description="이 기준정보는 아직 백엔드 API가 제공되지 않습니다. mock 모드에서는 편집할 수 있지만 실서버에서는 조회·저장이 지원되지 않습니다."
        />
      )}
      <Table<MasterItem>
        rowKey="id"
        size="small"
        loading={listQuery.isLoading}
        dataSource={listQuery.data ?? []}
        columns={columns}
        pagination={false}
        locale={
          listQuery.isError
            ? { emptyText: '백엔드 연동 예정입니다. 실서버에서는 아직 조회할 수 없습니다.' }
            : undefined
        }
      />

      <Modal
        title={`${title} 수정`}
        open={!!editTarget}
        onCancel={() => setEditTarget(null)}
        okText="저장"
        cancelText="취소"
        confirmLoading={updateMutation.isPending}
        onOk={() =>
          void editForm.validateFields().then((values) => {
            if (!editTarget) return;
            updateMutation.mutate({ id: editTarget.id, payload: values });
          })
        }
        destroyOnClose
      >
        <Form<EditFormValues> form={editForm} layout="vertical">
          <Form.Item label="코드">
            <Input value={editTarget?.code} disabled />
          </Form.Item>
          <Form.Item
            label="표시명"
            name="name"
            rules={[{ required: true, message: '표시명을 입력해 주세요.' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            label="정렬 순서"
            name="sortOrder"
            rules={[{ required: true, message: '정렬 순서를 입력해 주세요.' }]}
          >
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`${title} 추가`}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="추가"
        cancelText="취소"
        confirmLoading={createMutation.isPending}
        onOk={() => void createForm.validateFields().then((values) => createMutation.mutate(values))}
        destroyOnClose
      >
        <Form<CreateFormValues> form={createForm} layout="vertical">
          <Form.Item
            label="코드"
            name="code"
            rules={[{ required: true, message: '코드를 입력해 주세요.' }]}
            extra="영문 대문자·언더스코어 권장. 생성 후 변경할 수 없습니다."
          >
            <Input placeholder="예: SEASON_EVENT" />
          </Form.Item>
          <Form.Item
            label="표시명"
            name="name"
            rules={[{ required: true, message: '표시명을 입력해 주세요.' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item label="정렬 순서" name="sortOrder">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="미입력 시 마지막" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

export function AdminMasterPage() {
  return (
    <Card
      title="기준정보 관리"
      extra={
        <Typography.Text type="secondary">
          과거 데이터가 참조하는 값은 삭제 대신 사용 중지 처리됩니다.
        </Typography.Text>
      }
    >
      <Tabs
        defaultActiveKey="appointment-purposes"
        items={[
          {
            key: 'appointment-purposes',
            label: '예약 목적',
            children: <MasterTable type="appointment-purposes" title="예약 목적" />,
          },
          {
            key: 'product',
            label: '품목·구성품 (연동 예정)',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <MasterTable type="product-category" title="품목 대분류" />
                <MasterTable type="component-type" title="구성품" />
              </Space>
            ),
          },
          {
            key: 'payment-method',
            label: '결제수단 (연동 예정)',
            children: <MasterTable type="payment-method" title="결제수단" />,
          },
          {
            key: 'repair-type',
            label: '수선 구분 (연동 예정)',
            children: <MasterTable type="repair-type" title="수선 구분" />,
          },
        ]}
      />
    </Card>
  );
}
