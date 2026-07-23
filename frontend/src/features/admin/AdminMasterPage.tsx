/**
 * ADMIN-001 기준정보 관리
 * - 탭: 예약 목적 / 품목·구성품 / 결제수단 / 수선 구분
 * - 예약 목적·결제수단: DB 마스터 테이블 → 표시명·정렬·사용여부 편집 가능
 * - 품목·구성품·수선 구분: 코드 상수(고정) 기준정보 → 표시명만 편집(코드 추가·삭제 불가)
 */
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
import {
  CODE_LABELS_QUERY_KEY,
  updateCodeLabel,
  useCodeLabelsQuery,
  type CodeLabelDomain,
  type CodeLabelItem,
} from '../../api/code-labels';

interface EditFormValues {
  name: string;
  sortOrder: number;
}

interface CreateFormValues {
  code: string;
  name: string;
  sortOrder?: number;
}

/**
 * DB 마스터 테이블 기반 기준정보(예약 목적·결제수단)의 표 + 추가/수정/사용여부 토글.
 * 품목·구성품·수선 구분은 코드 상수라 편집 대상이 아니며 CodeConstantTable 로 표시한다.
 */
function MasterTable({ type, title }: { type: MasterType; title: string }) {
  const [editTarget, setEditTarget] = useState<MasterItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editForm] = Form.useForm<EditFormValues>();
  const [createForm] = Form.useForm<CreateFormValues>();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const listQuery = useQuery({
    queryKey: ['admin', 'master', type],
    queryFn: () => fetchMaster(type),
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
          onClick={() => setCreateOpen(true)}
        >
          추가
        </Button>
      }
    >
      <Table<MasterItem>
        rowKey="id"
        scroll={{ x: 'max-content' }}
        size="small"
        loading={listQuery.isLoading}
        dataSource={listQuery.data ?? []}
        columns={columns}
        pagination={false}
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

interface CodeLabelFormValues {
  label: string;
}

/**
 * 코드 상수로 관리되는 기준정보(품목·구성품·수선구분)의 표시명 편집 표.
 * 코드는 코드 분기·검증(@IsIn, repairLinkKind 등)과 엮여 고정이므로 추가·삭제·코드변경은 불가하고,
 * 코드와 무관한 "표시명"만 편집한다. 저장하면 전 화면 표시명이 함께 바뀐다.
 */
function CodeLabelTable({ domain, title }: { domain: CodeLabelDomain; title: string }) {
  const [editTarget, setEditTarget] = useState<CodeLabelItem | null>(null);
  const [form] = Form.useForm<CodeLabelFormValues>();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const labelsQuery = useCodeLabelsQuery();
  const items = labelsQuery.data?.[domain] ?? [];

  const updateMutation = useMutation({
    mutationFn: ({ code, label }: { code: string; label: string }) =>
      updateCodeLabel(domain, code, label),
    onSuccess: () => {
      setEditTarget(null);
      message.success('표시명이 저장되었습니다.');
      void queryClient.invalidateQueries({ queryKey: CODE_LABELS_QUERY_KEY });
    },
    onError: (e: unknown) =>
      message.error(e instanceof ApiError ? e.message : '저장에 실패했습니다.'),
  });

  const columns: ColumnsType<CodeLabelItem> = [
    { title: '코드', dataIndex: 'code', width: 220 },
    { title: '표시명', dataIndex: 'label' },
    {
      title: '작업',
      key: 'action',
      width: 80,
      render: (_, row) => (
        <Button
          size="small"
          onClick={() => {
            setEditTarget(row);
            form.setFieldsValue({ label: row.label });
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
        <Tooltip title="코드는 시스템에 고정되어 있어 표시명만 바꿀 수 있습니다.">
          <Tag color="geekblue">표시명만 편집</Tag>
        </Tooltip>
      }
    >
      <Table<CodeLabelItem>
        rowKey="code"
        size="small"
        scroll={{ x: 'max-content' }}
        loading={labelsQuery.isLoading}
        dataSource={items}
        columns={columns}
        pagination={false}
      />

      <Modal
        title={`${title} 표시명 수정`}
        open={!!editTarget}
        onCancel={() => setEditTarget(null)}
        okText="저장"
        cancelText="취소"
        confirmLoading={updateMutation.isPending}
        onOk={() =>
          void form.validateFields().then((values) => {
            if (!editTarget) return;
            updateMutation.mutate({ code: editTarget.code, label: values.label });
          })
        }
        destroyOnClose
      >
        <Form<CodeLabelFormValues> form={form} layout="vertical">
          <Form.Item label="코드">
            <Input value={editTarget?.code} disabled />
          </Form.Item>
          <Form.Item
            label="표시명"
            name="label"
            rules={[{ required: true, message: '표시명을 입력해 주세요.' }]}
          >
            <Input maxLength={100} />
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
            label: '품목·구성품',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <CodeLabelTable domain="product-category" title="품목 대분류" />
                <CodeLabelTable domain="component-type" title="구성품" />
              </Space>
            ),
          },
          {
            key: 'payment-method',
            label: '결제수단',
            children: <MasterTable type="payment-method" title="결제수단" />,
          },
          {
            key: 'repair-type',
            label: '수선 구분',
            children: <CodeLabelTable domain="repair-type" title="수선 구분" />,
          },
        ]}
      />
    </Card>
  );
}
