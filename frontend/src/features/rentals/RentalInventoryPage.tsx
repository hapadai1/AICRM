import { PlusOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  RENTAL_COMPONENT_TYPE_LABELS,
  RENTAL_ITEM_STATUS_META,
  createRentalItem,
  fetchRentalColors,
  fetchRentalItems,
  fetchRentalSizes,
  retireRentalItem,
  type RentalComponentType,
  type RentalItem,
  type RentalItemStatus,
} from '../../api/rentals';
import { Can } from '../../shared/Can';
import { DataTable, DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { StatusBadge } from '../../shared/StatusBadge';
import { autoWidth } from '../../shared/table-width';
import { DESIGN_OPTIONS, COLOR_OPTIONS, componentTypeOptions, statusOptions } from './rental-constants';

interface FilterValues {
  componentType?: RentalComponentType;
  design?: string;
  color?: string;
  skuSize?: string;
  status?: RentalItemStatus;
  availableOn?: Dayjs;
}

interface RegisterValues {
  componentType: RentalComponentType;
  design: string;
  color: string;
  size: string;
  quantity: number;
  managementCode: string;
  notes?: string;
}

/** RENT-001 렌탈 실물 재고 목록 */
export function RentalInventoryPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filterForm] = Form.useForm<FilterValues>();
  const [registerForm] = Form.useForm<RegisterValues>();
  const [filters, setFilters] = useState<FilterValues>({});
  const [registerOpen, setRegisterOpen] = useState(false);

  // E10: 컬러·사이즈는 기준정보(rental_colors/rental_sizes) 활성 코드에서 선택한다.
  const colorsQuery = useQuery({ queryKey: ['rentals', 'colors'], queryFn: fetchRentalColors });
  const sizesQuery = useQuery({ queryKey: ['rentals', 'sizes'], queryFn: fetchRentalSizes });
  const colorSelectOptions = useMemo(
    () => (colorsQuery.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` })),
    [colorsQuery.data],
  );
  const sizeSelectOptions = useMemo(
    () => (sizesQuery.data ?? []).map((s) => ({ value: s.code, label: `${s.name} (${s.code})` })),
    [sizesQuery.data],
  );

  const listQuery = useQuery({
    queryKey: ['rentals', 'inventory', filters],
    queryFn: () =>
      fetchRentalItems({
        componentType: filters.componentType,
        design: filters.design,
        color: filters.color,
        skuSize: filters.skuSize,
        status: filters.status,
        availableOn: filters.availableOn?.format('YYYY-MM-DD'),
        size_: 100,
      }),
  });

  const registerMutation = useMutation({
    // 계약 §5: managementCode 필수, quantity>1이면 연번 일괄 생성
    mutationFn: (v: RegisterValues) =>
      createRentalItem({
        managementCode: v.managementCode.trim(),
        componentType: v.componentType,
        design: v.design,
        color: v.color,
        size: v.size,
        quantity: v.quantity,
        notes: v.notes,
      }),
    onSuccess: (created) => {
      message.success(`렌탈 실물 ${created.length}건이 등록되었습니다.`);
      setRegisterOpen(false);
      registerForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '실물 등록에 실패했습니다.'),
  });

  const retireMutation = useMutation({
    mutationFn: (id: string) => retireRentalItem(id, { reason: '재고 화면에서 폐기 처리' }),
    onSuccess: () => {
      message.success('폐기 처리되었습니다.');
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '폐기 처리에 실패했습니다.'),
  });

  const quantity = Form.useWatch('quantity', registerForm) ?? 1;

  const columns: ColumnsType<RentalItem> = [
    // 사람이 아는 정보(구분·디자인·컬러·사이즈)를 앞에, 관리코드는 참고용으로 뒤에 둔다.
    {
      title: '구분',
      dataIndex: 'componentType',
      render: (c: RentalComponentType) => RENTAL_COMPONENT_TYPE_LABELS[c] ?? c,
      ...autoWidth(),
    },
    { title: '디자인', dataIndex: 'design', ...autoWidth() },
    { title: '컬러', dataIndex: 'color', ...autoWidth() },
    { title: '사이즈', dataIndex: 'size', ...autoWidth() },
    {
      title: '상태',
      dataIndex: 'status',
      render: (s: RentalItemStatus) => (
        <StatusBadge label={RENTAL_ITEM_STATUS_META[s]?.label ?? s} color={RENTAL_ITEM_STATUS_META[s]?.color} />
      ),
      ...autoWidth(),
    },
    { title: '대여 가능 예정일', dataIndex: 'availableFrom', render: (d?: string) => d ?? '-', ...autoWidth() },
    {
      title: '현재 배정 / 고객',
      key: 'allocation',
      ...autoWidth(),
      // 배정 요약은 한 줄이 길어 이 열 하나가 표를 가로 스크롤로 밀어낸다(액션 열이 잘림).
      // 셀 안에서 잘라 폭 상한을 두고, 전문은 툴팁으로 본다.
      render: (_, r) => {
        if (!r.currentAllocation) return '-';
        const a = r.currentAllocation;
        const detail = `(${a.orderNo} · ${a.pickupDate} ~ ${a.returnDueDate})`;
        return (
          <Typography.Text style={{ maxWidth: 300 }} ellipsis={{ tooltip: `${a.customerName} ${detail}` }}>
            {a.customerName} <Typography.Text type="secondary">{detail}</Typography.Text>
          </Typography.Text>
        );
      },
    },
    {
      title: '관리코드',
      dataIndex: 'managementCode',
      render: (code: string, r) => (
        <Link to={`/rentals/${r.id}`}>
          <Typography.Text type="secondary">{code}</Typography.Text>
        </Link>
      ),
      ...autoWidth(),
    },
    {
      title: '액션',
      key: 'actions',
      ...autoWidth(),
      render: (_, r) => (
        <Can permission="RENTAL_EDIT">
          <Popconfirm
            title="폐기 처리"
            // 파손으로 잠시 빼두는 것과 혼동해 누르는 사고를 막는다 — 되돌릴 수 없다는 점을 확인창에 명시한다.
            // 일시 제외는 상세 화면의 상태 변경(사용 불가·수선 중)을 쓴다.
            description={
              <>
                관리코드 {r.managementCode}를 폐기 처리합니다.
                <br />
                재고에서 영구 제외되며 되돌릴 수 없습니다. (이력은 보존됩니다)
                <br />
                파손 등으로 잠시 빼두려면 상세 화면에서 &lsquo;사용 불가&rsquo;로 바꾸세요.
              </>
            }
            okText="폐기 처리"
            cancelText="취소"
            onConfirm={() => retireMutation.mutate(r.id)}
            disabled={r.status === 'RETIRED' || !!r.currentAllocation}
          >
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              disabled={r.status === 'RETIRED' || !!r.currentAllocation}
            >
              폐기 처리
            </Button>
          </Popconfirm>
        </Can>
      ),
    },
  ];

  return (
    <PageShell>
      <PageCard>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <ListToolbar
          filters={
            /*
              필터에 "구분 :", "디자인 :" 처럼 라벨을 달아 두면 렌탈 화면만 다른 시스템처럼 보였다.
              다른 목록과 같이 라벨 없이 placeholder 로 뜻을 전달한다.
              Form 은 값 관리·초기화 때문에 그대로 두고 라벨만 걷어낸다.
            */
            <Form<FilterValues>
              form={filterForm}
              layout="inline"
              onFinish={(values) => setFilters({ ...values })}
              style={{ rowGap: 8, columnGap: 0 }}
            >
              <Form.Item name="componentType">
                <Select allowClear placeholder="구분 전체" style={{ width: 140 }} options={componentTypeOptions} />
              </Form.Item>
              <Form.Item name="design">
                <Select allowClear placeholder="디자인 전체" style={{ width: 130 }} options={DESIGN_OPTIONS} />
              </Form.Item>
              <Form.Item name="color">
                <Select allowClear placeholder="컬러 전체" style={{ width: 120 }} options={COLOR_OPTIONS} />
              </Form.Item>
              <Form.Item name="skuSize">
                <Input allowClear placeholder="사이즈 (예: 100)" style={{ width: 130 }} />
              </Form.Item>
              <Form.Item name="status">
                <Select allowClear placeholder="상태 전체" style={{ width: 130 }} options={statusOptions} />
              </Form.Item>
              <Form.Item name="availableOn">
                <DatePicker placeholder="대여 가능일" />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
                  검색
                </Button>
              </Form.Item>
            </Form>
          }
          actions={
            /*
              화면끼리 서로를 잇던 [가용 검색·배정]·[출고·반납] 버튼은 뺐다.
              좌측 메뉴 "렌탈 관리" 아래 같은 이동이 이미 있고, 세 화면이 그 버튼을
              저마다 다른 자리(좌상단·우상단)에 두는 바람에 배치가 어긋나 있었다.
            */
            <Can permission="RENTAL_EDIT">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setRegisterOpen(true)}>
                실물 등록
              </Button>
            </Can>
          }
        />

        <DataTable<RentalItem>
          rowKey="id"
          loading={listQuery.isLoading}
          dataSource={listQuery.data?.data ?? []}
          columns={columns}
          pagination={{ pageSize: DEFAULT_PAGE_SIZE, showSizeChanger: true, pageSizeOptions: PAGE_SIZE_OPTIONS }}
          onRow={(r) => ({ onDoubleClick: () => navigate(`/rentals/${r.id}`) })}
        />
      </Space>

      {/* 실물 등록 모달: 관리코드 필수 + 수량 2 이상이면 연번 일괄 생성 */}
      <Modal
        title="렌탈 실물 등록"
        open={registerOpen}
        onCancel={() => setRegisterOpen(false)}
        onOk={() => registerForm.submit()}
        okText="등록"
        cancelText="취소"
        confirmLoading={registerMutation.isPending}
        destroyOnClose
      >
        <Form<RegisterValues>
          form={registerForm}
          layout="vertical"
          initialValues={{ quantity: 1, design: '클래식A', color: 'BLACK' }}
          onFinish={(values) => registerMutation.mutate(values)}
        >
          <Form.Item name="componentType" label="구분" rules={[{ required: true, message: '구분을 선택해 주세요.' }]}>
            <Select placeholder="구분 선택" options={componentTypeOptions} />
          </Form.Item>
          <Form.Item name="design" label="디자인" rules={[{ required: true, message: '디자인을 선택해 주세요.' }]}>
            <Select options={DESIGN_OPTIONS} />
          </Form.Item>
          <Form.Item name="color" label="컬러" rules={[{ required: true, message: '컬러를 선택해 주세요.' }]}>
            <Select
              placeholder="컬러 선택"
              loading={colorsQuery.isLoading}
              options={colorSelectOptions}
            />
          </Form.Item>
          <Form.Item name="size" label="사이즈" rules={[{ required: true, message: '사이즈를 선택해 주세요.' }]}>
            <Select
              placeholder="사이즈 선택"
              loading={sizesQuery.isLoading}
              options={sizeSelectOptions}
            />
          </Form.Item>
          <Form.Item
            name="managementCode"
            label="관리코드"
            rules={[{ required: true, message: '관리코드를 입력해 주세요.' }]}
            extra={
              quantity > 1
                ? '수량이 2 이상이면 입력한 관리코드 뒤에 -001, -002… 연번이 붙습니다.'
                : undefined
            }
          >
            <Input placeholder="예: JKT-BLK-100-004" />
          </Form.Item>
          <Form.Item
            name="quantity"
            label="등록 수량 (2 이상이면 동일 속성으로 일괄 생성)"
            rules={[{ required: true, message: '수량을 입력해 주세요.' }]}
          >
            <InputNumber min={1} max={50} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="notes" label="메모">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
      </PageCard>
    </PageShell>
  );
}
