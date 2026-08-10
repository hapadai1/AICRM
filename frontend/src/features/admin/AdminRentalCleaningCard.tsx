/**
 * ADMIN-001 "렌탈 정비 기준" 탭.
 *
 * 반납한 옷은 세탁 여부를 확인해야 해서 바로 다시 빌려줄 수 없다. 며칠을 잡을지는
 * 색 계열로 갈린다 — 화이트·베이지 계열은 오염이 그대로 보여 하루 더 잡는다
 * (현업 확정 2026-08-01). 여기서 정한 값이 반납 화면의 대여 가능 예정일이 되고,
 * 그날이 오면 서버가 실물을 대여 가능으로 올린다.
 */
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import {
  createMaster,
  fetchMaster,
  fetchRentalReturnPolicy,
  updateMaster,
  updateRentalReturnPolicy,
  type MasterItem,
  type RentalColorTone,
  type RentalReturnPolicy,
} from '../../api/admin';
import { ApiError } from '../../api/client';
import { RENTAL_COMPONENT_TYPE_LABELS, type RentalComponentType } from '../../api/rentals';

const POLICY_KEY = ['admin', 'rental-return-policy'];
const COLORS_KEY = ['admin', 'master', 'rental-colors'];

function PolicyForm() {
  const [form] = Form.useForm<RentalReturnPolicy>();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const policyQuery = useQuery({ queryKey: POLICY_KEY, queryFn: fetchRentalReturnPolicy });

  // 서버 값이 도착하면 폼을 채운다 — 초기값을 하드코딩하면 저장 전 값이 잠깐 다르게 보인다.
  useEffect(() => {
    if (policyQuery.data) form.setFieldsValue(policyQuery.data);
  }, [policyQuery.data, form]);

  const saveMutation = useMutation({
    mutationFn: updateRentalReturnPolicy,
    onSuccess: (saved) => {
      form.setFieldsValue(saved);
      message.success('정비 기준을 저장했습니다.');
      void queryClient.invalidateQueries({ queryKey: POLICY_KEY });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '저장에 실패했습니다.'),
  });

  return (
    <Card size="small" title="정비 소요일" loading={policyQuery.isLoading}>
      <Form<RentalReturnPolicy>
        form={form}
        layout="inline"
        onFinish={(values) => saveMutation.mutate(values)}
        style={{ rowGap: 12 }}
      >
        <Form.Item
          label="밝은색"
          name="lightCleaningDays"
          rules={[{ required: true, message: '정비 소요일을 입력해 주세요.' }]}
          extra="화이트·베이지 계열"
        >
          <InputNumber min={0} max={30} addonAfter="일" style={{ width: 130 }} />
        </Form.Item>
        <Form.Item
          label="블랙 타입"
          name="darkCleaningDays"
          rules={[{ required: true, message: '정비 소요일을 입력해 주세요.' }]}
          extra="그 외 전부"
        >
          <InputNumber min={0} max={30} addonAfter="일" style={{ width: 130 }} />
        </Form.Item>
        {/* 자동 대여 가능 전환은 켜고 끌 값이 아니다 — 정비일이 지나면 언제나 다시 빌려줄 수 있다
            (현업 확정 2026-08-01). 스위치를 두면 꺼 놓고 재고가 왜 안 도는지 찾게 된다. */}
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saveMutation.isPending}>
            저장
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}

/**
 * 컬러 추가는 표시명과 색 계열만 받는다.
 * 코드는 시스템이 실물 관리코드에 쓰는 값이라 서버가 채번하고, 적용 품목을 비워 두면
 * 전 품목 공통이 된다 — 색마다 부위를 고르게 하면 등록이 복잡하기만 하다.
 */
interface ColorFormValues {
  name: string;
  tone: RentalColorTone;
}

function ColorToneTable() {
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<ColorFormValues>();

  const colorsQuery = useQuery({ queryKey: COLORS_KEY, queryFn: () => fetchMaster('rental-colors') });

  const toneMutation = useMutation({
    mutationFn: ({ id, tone }: { id: string; tone: RentalColorTone }) =>
      updateMaster('rental-colors', id, { tone }),
    onSuccess: () => {
      message.success('색 계열을 변경했습니다.');
      void queryClient.invalidateQueries({ queryKey: COLORS_KEY });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '변경에 실패했습니다.'),
  });

  const activeMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      updateMaster('rental-colors', id, { active }),
    onSuccess: (_, { active }) => {
      message.success(active ? '다시 사용합니다.' : '사용을 중지했습니다.');
      void queryClient.invalidateQueries({ queryKey: COLORS_KEY });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '변경에 실패했습니다.'),
  });

  const createMutation = useMutation({
    mutationFn: (values: ColorFormValues) =>
      createMaster('rental-colors', { name: values.name.trim(), tone: values.tone }),
    onSuccess: (created) => {
      message.success(`${created.name}(${created.code}) 컬러를 추가했습니다.`);
      setCreateOpen(false);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: COLORS_KEY });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '추가에 실패했습니다.'),
  });

  // 코드 열은 두지 않는다 — 실물 관리코드를 만들 때만 쓰는 내부 값이라 화면에서 다룰 일이 없다.
  const columns: ColumnsType<MasterItem> = [
    { title: '컬러명', dataIndex: 'name' },
    {
      // 이 화면의 본 일이라 적용 품목보다 앞에 둔다.
      title: '색 계열',
      dataIndex: 'tone',
      width: 210,
      // 스위치는 꺼진 쪽이 회색 바탕에 흰 글씨라 "블랙 타입"이 읽히지 않았다.
      // 두 값을 나란히 두고 고른 쪽만 칠한다.
      render: (tone: RentalColorTone | undefined, row) => (
        <Segmented<RentalColorTone>
          size="small"
          value={tone === 'LIGHT' ? 'LIGHT' : 'DARK'}
          disabled={toneMutation.isPending && toneMutation.variables?.id === row.id}
          options={[
            { value: 'LIGHT', label: '밝은색' },
            { value: 'DARK', label: '블랙 타입' },
          ]}
          onChange={(next) => toneMutation.mutate({ id: row.id, tone: next })}
        />
      ),
    },
    {
      title: '적용 품목',
      dataIndex: 'componentTypes',
      width: 260,
      // 색 하나가 여러 품목에 걸린다 — 3피스면 상의·하의·베스트가 같은 코드를 쓴다.
      render: (types?: string[]) =>
        types?.length ? (
          <Space size={4} wrap>
            {types.map((t) => (
              <Tag key={t}>{RENTAL_COMPONENT_TYPE_LABELS[t as RentalComponentType] ?? t}</Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">전 품목</Typography.Text>
        ),
    },
    {
      title: '사용여부',
      dataIndex: 'active',
      width: 160,
      // 태그로 감싸면 옅어져 더 안 보인다 — 글자 그대로 쓰고 중지만 눈에 띄게 한다.
      // 색은 지우지 않는다. 그 색으로 등록된 실물과 지난 계약이 코드를 참조하기 때문에,
      // 안 쓰는 색은 중지로 내려 재고 등록 드롭다운에서만 빠지게 한다.
      render: (active: boolean, row) => (
        <Space size={8}>
          {active ? <Typography.Text>사용</Typography.Text> : <Typography.Text type="danger">중지</Typography.Text>}
          <Button
            size="small"
            type="link"
            loading={activeMutation.isPending && activeMutation.variables?.id === row.id}
            onClick={() => activeMutation.mutate({ id: row.id, active: !active })}
          >
            {active ? '중지' : '재사용'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="컬러별 색 계열"
      extra={
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            form.setFieldsValue({ tone: 'DARK' });
            setCreateOpen(true);
          }}
        >
          컬러 추가
        </Button>
      }
    >
      <Table<MasterItem>
        rowKey="id"
        size="small"
        scroll={{ x: 'max-content' }}
        loading={colorsQuery.isLoading}
        dataSource={colorsQuery.data ?? []}
        columns={columns}
        pagination={false}
      />

      <Modal
        title="컬러 추가"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void form.validateFields().then((values) => createMutation.mutate(values))}
        okText="추가"
        cancelText="취소"
        confirmLoading={createMutation.isPending}
        destroyOnHidden
      >
        <Form<ColorFormValues> form={form} layout="vertical">
          <Form.Item
            label="컬러명"
            name="name"
            rules={[{ required: true, message: '컬러명을 입력해 주세요.' }]}
          >
            <Input placeholder="예: 세이지 그린" autoFocus />
          </Form.Item>
          <Form.Item label="색 계열" name="tone" rules={[{ required: true }]}>
            <Segmented<RentalColorTone>
              options={[
                { value: 'LIGHT', label: '밝은색' },
                { value: 'DARK', label: '블랙 타입' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

export function AdminRentalCleaningCard() {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="반납한 옷은 세탁 확인이 끝나야 다시 빌려줄 수 있습니다."
        description="여기서 정한 소요일이 반납 화면의 대여 가능 예정일로 채워지고, 그날이 되면 반납 대기 실물이 자동으로 대여 가능이 됩니다. 수선·사용중지로 내려 둔 실물은 자동 전환 대상이 아닙니다."
      />
      <PolicyForm />
      <ColorToneTable />
    </Space>
  );
}
