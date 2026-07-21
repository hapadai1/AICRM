import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  cloneContractType,
  createContractType,
  fetchContractTypes,
  retireContractType,
  updateContractType,
  type ContractType,
  type ContractTypeInput,
  type ContractTypeLine,
  type ProductCategory,
  type TransactionType,
} from '../../api/contracts';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { PRODUCT_CATEGORY_LABEL, TRANSACTION_TYPE_LABEL } from './labels';

/** CONT-001 계약 구분 관리 — 기본 품목 구성 CRUD·복제·사용 중지 */

const TRANSACTION_OPTIONS = (Object.keys(TRANSACTION_TYPE_LABEL) as TransactionType[]).map((v) => ({
  value: v,
  label: TRANSACTION_TYPE_LABEL[v],
}));

const CATEGORY_OPTIONS = (Object.keys(PRODUCT_CATEGORY_LABEL) as ProductCategory[]).map((v) => ({
  value: v,
  label: PRODUCT_CATEGORY_LABEL[v],
}));

interface TypeFormValues {
  name: string;
  description?: string;
  sortOrder?: number;
  lines: ContractTypeLine[];
}

export function ContractTypeAdminPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<TypeFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ContractType | null>(null);

  const { data: types, isLoading } = useQuery({
    queryKey: ['contract-types', { includeInactive: true }],
    queryFn: () => fetchContractTypes(true),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['contract-types'] });

  const onError = (e: unknown) => {
    message.error(e instanceof ApiError ? e.message : '처리 중 오류가 발생했습니다.');
  };

  const saveMutation = useMutation({
    mutationFn: (values: ContractTypeInput) =>
      editing ? updateContractType(editing.id, values) : createContractType(values),
    onSuccess: () => {
      message.success(editing ? '계약 구분을 수정했습니다.' : '계약 구분을 저장했습니다.');
      setOpen(false);
      setEditing(null);
      void invalidate();
    },
    onError,
  });

  /** 기존 코드와 겹치지 않는 복제용 관리 코드를 만든다 (백엔드 필수, 40자 제한). */
  const nextCloneCode = (source: ContractType): string => {
    const used = new Set((types ?? []).map((t) => t.code));
    const base = source.code.slice(0, 33);
    for (let i = 1; i < 100; i += 1) {
      const candidate = i === 1 ? `${base}_COPY` : `${base}_COPY${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${base}_COPY${Date.now() % 1000}`;
  };

  const cloneMutation = useMutation({
    mutationFn: (t: ContractType) =>
      cloneContractType(t.id, { code: nextCloneCode(t), name: `${t.name} 복사본` }),
    onSuccess: (created) => {
      message.success(`'${created.name}' 구분을 생성했습니다.`);
      void invalidate();
    },
    onError,
  });

  const retireMutation = useMutation({
    mutationFn: (id: string) => retireContractType(id),
    onSuccess: () => {
      message.success('사용 중지했습니다. 신규 계약 선택 목록에서 제외됩니다.');
      void invalidate();
    },
    onError,
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      lines: [{ transactionType: 'CUSTOM', productCategory: 'SUIT', defaultQuantity: 1 }],
    });
    setOpen(true);
  };

  const openEdit = (t: ContractType) => {
    setEditing(t);
    form.setFieldsValue({
      name: t.name,
      description: t.description,
      sortOrder: t.sortOrder,
      lines: t.lines.map((l) => ({ ...l })),
    });
    setOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const doSave = () => saveMutation.mutate(values);
    // 중복명 경고 (저장 자체는 허용 — 문서 03 §6.1)
    const duplicated = types?.some((t) => t.name === values.name.trim() && t.id !== editing?.id);
    if (duplicated) {
      modal.confirm({
        title: '중복된 계약 구분명',
        content: `'${values.name}' 이름의 계약 구분이 이미 있습니다. 그래도 저장할까요?`,
        okText: '저장',
        cancelText: '취소',
        onOk: doSave,
      });
      return;
    }
    doSave();
  };

  const columns: ColumnsType<ContractType> = [
    { title: '정렬', dataIndex: 'sortOrder', width: 70, align: 'center' },
    {
      title: '계약 구분명',
      dataIndex: 'name',
      width: 200,
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    { title: '설명', dataIndex: 'description', ellipsis: true, render: (v?: string) => v ?? '-' },
    {
      title: '기본 품목',
      dataIndex: 'lines',
      width: 320,
      render: (lines: ContractTypeLine[]) => (
        <Space size={[4, 4]} wrap>
          {lines.map((l, i) => (
            <Tag key={i} color={l.transactionType === 'CUSTOM' ? 'blue' : 'purple'}>
              {TRANSACTION_TYPE_LABEL[l.transactionType]} {PRODUCT_CATEGORY_LABEL[l.productCategory]} ×
              {l.defaultQuantity}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '사용 여부',
      dataIndex: 'active',
      width: 100,
      render: (active: boolean) =>
        active ? <StatusBadge label="사용중" color="green" /> : <StatusBadge label="사용 중지" color="red" />,
    },
    {
      title: '작업',
      key: 'actions',
      width: 220,
      render: (_, t) => (
        <Can permission="CONTRACT_TYPE_EDIT">
          <Space size={4} wrap>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(t)}>
              수정
            </Button>
            <Button
              size="small"
              icon={<CopyOutlined />}
              loading={cloneMutation.isPending && cloneMutation.variables?.id === t.id}
              onClick={() => cloneMutation.mutate(t)}
            >
              복제
            </Button>
            {t.active && (
              <Popconfirm
                title="사용 중지"
                description="신규 계약에서 선택할 수 없게 됩니다. 기존 계약에는 영향이 없습니다."
                okText="사용 중지"
                okButtonProps={{ danger: true }}
                cancelText="취소"
                onConfirm={() => retireMutation.mutate(t.id)}
              >
                <Button size="small" danger icon={<StopOutlined />}>
                  사용 중지
                </Button>
              </Popconfirm>
            )}
          </Space>
        </Can>
      ),
    },
  ];

  return (
    <Card>
      <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 8 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          계약 구분 관리
        </Typography.Title>
        <Can permission="CONTRACT_TYPE_EDIT">
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            계약 구분 추가
          </Button>
        </Can>
      </Flex>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        계약 구분은 계약서 작성 시 기본 품목 라인으로 복사됩니다. 가격은 계약 구분에 저장하지 않으며, 수량은
        계약서에서 수정할 수 있습니다.
      </Typography.Paragraph>

      <Table
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={types ?? []}
        pagination={false}
        scroll={{ x: 1000 }}
      />

      <Modal
        title={editing ? '계약 구분 수정' : '계약 구분 추가'}
        open={open}
        width={640}
        okText="저장"
        cancelText="취소"
        confirmLoading={saveMutation.isPending}
        onOk={() => void handleSubmit()}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          {!editing && (
            <Form.Item
              name="code"
              label="관리 코드"
              rules={[
                { required: true, whitespace: true, message: '관리 코드를 입력해 주세요.' },
                {
                  pattern: /^[A-Z0-9_]+$/,
                  message: '영문 대문자·숫자·밑줄만 사용합니다.',
                },
              ]}
              extra="등록 후에는 변경할 수 없습니다. 예: BUSINESS_SUIT_CUSTOM"
            >
              <Input placeholder="BUSINESS_SUIT_CUSTOM" maxLength={40} />
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="계약 구분명"
            rules={[{ required: true, whitespace: true, message: '계약 구분명을 입력해 주세요.' }]}
          >
            <Input placeholder="예: 비즈니스 정장 맞춤" maxLength={50} />
          </Form.Item>
          <Form.Item name="description" label="설명">
            <Input placeholder="계약서 선택 목록에 함께 표시할 설명" maxLength={200} />
          </Form.Item>
          <Form.Item name="sortOrder" label="정렬 순서">
            <InputNumber min={0} style={{ width: 160 }} placeholder="비우면 마지막" />
          </Form.Item>

          <Typography.Text strong>기본 품목 라인</Typography.Text>
          <Form.List name="lines">
            {(fields, { add, remove }) => (
              <Flex vertical gap={8} style={{ marginTop: 8 }}>
                {fields.map((field) => (
                  <Space key={field.key} align="baseline" wrap>
                    <Form.Item
                      name={[field.name, 'transactionType']}
                      rules={[{ required: true, message: '거래 방식 선택' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <Select style={{ width: 110 }} placeholder="거래 방식" options={TRANSACTION_OPTIONS} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'productCategory']}
                      rules={[{ required: true, message: '품목 선택' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <Select style={{ width: 110 }} placeholder="품목" options={CATEGORY_OPTIONS} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'defaultQuantity']}
                      rules={[{ required: true, message: '기본 수량 입력' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <InputNumber min={1} style={{ width: 110 }} placeholder="기본 수량" />
                    </Form.Item>
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label="기본 품목 삭제"
                      onClick={() => remove(field.name)}
                    />
                  </Space>
                ))}
                <Button
                  icon={<PlusOutlined />}
                  onClick={() => add({ transactionType: 'CUSTOM', productCategory: 'SUIT', defaultQuantity: 1 })}
                >
                  기본 품목 추가
                </Button>
              </Flex>
            )}
          </Form.List>
        </Form>
      </Modal>
    </Card>
  );
}
