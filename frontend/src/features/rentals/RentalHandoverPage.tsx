import { ExportOutlined, ImportOutlined, SwapOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  RENTAL_ITEM_STATUS_META,
  RENTAL_COMPONENT_TYPE_LABELS,
  RETURN_NEXT_STATUSES,
  changeAllocationItem,
  checkoutAllocation,
  fetchAllocations,
  fetchAvailability,
  returnAllocation,
  type RentalAllocation,
  type RentalItemStatus,
} from '../../api/rentals';
import { LAYOUT } from '../../app/theme';
import { DataTable } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { useRentalCodeNames } from './rental-codes';

/** RENT-004 렌탈 출고·반납 */
export function RentalHandoverPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const [checkoutTarget, setCheckoutTarget] = useState<RentalAllocation | null>(null);
  const [returnTarget, setReturnTarget] = useState<RentalAllocation | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);

  const [checkoutForm] = Form.useForm<{ checkoutDate: Dayjs; notes?: string }>();
  const [returnForm] = Form.useForm<{ returnDate: Dayjs; availableFrom: Dayjs; nextStatus: RentalItemStatus }>();
  const [changeForm] = Form.useForm<{ newInventoryItemId: string; reason: string }>();

  // 진행 단계 카드 등에서 특정 주문으로 걸러 들어올 수 있게 한다 (?q=ORD-...).
  // q가 있으면 서버가 날짜 제한을 풀어 미래 픽업 예약·이미 출고된 건까지 함께 반환한다.
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = searchParams.get('q') ?? '';
  const q = keyword.trim();

  const pickupsQuery = useQuery({
    queryKey: ['rentals', 'allocations', 'pickup', q],
    queryFn: () => fetchAllocations('pickup', { q }),
  });
  const returnsQuery = useQuery({
    queryKey: ['rentals', 'allocations', 'return', q],
    queryFn: () => fetchAllocations('return', { q }),
  });

  const pickups = pickupsQuery.data ?? [];
  const returns = returnsQuery.data ?? [];

  // q로 진입했을 때는 실제 매칭 행이 있는 탭을 자동 선택한다.
  // (이미 출고된 건은 '반납 대상'에만 있고, 픽업 탭만 열려 "데이터 없음"으로 보이던 문제 해결)
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  const autoTab = q && pickups.length === 0 && returns.length > 0 ? 'return' : 'pickup';
  const activeTab = tabOverride ?? autoTab;

  // ID 변경 다이얼로그: 배정 기간 기준 가용 실물 조회
  const changeCandidatesQuery = useQuery({
    queryKey: ['rentals', 'change-candidates', checkoutTarget?.id, checkoutTarget?.managementCode],
    queryFn: () =>
      fetchAvailability({
        // 백엔드 필수 파라미터 — 같은 구분의 실물끼리만 교체할 수 있다.
        componentType: checkoutTarget!.componentType!,
        pickupDate: checkoutTarget!.pickupDate,
        availabilityEndDate: checkoutTarget!.availabilityEndDate,
      }),
    enabled: changeOpen && !!checkoutTarget?.componentType,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['rentals'] });

  const checkoutMutation = useMutation({
    mutationFn: (v: { checkoutDate: Dayjs; notes?: string }) =>
      checkoutAllocation(checkoutTarget!.id, {
        checkoutDate: v.checkoutDate.format('YYYY-MM-DD'),
        notes: v.notes?.trim() || undefined,
        version: checkoutTarget!.version,
      }),
    onSuccess: (alloc) => {
      message.success(`관리 ID ${alloc.managementCode} 출고 처리되었습니다.`);
      setCheckoutTarget(null);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '출고 처리에 실패했습니다.'),
  });

  const changeMutation = useMutation({
    mutationFn: (v: { newInventoryItemId: string; reason: string }) =>
      changeAllocationItem(checkoutTarget!.id, {
        newInventoryItemId: v.newInventoryItemId,
        reason: v.reason,
        version: checkoutTarget!.version,
      }),
    onSuccess: (alloc) => {
      message.success(`배정 실물이 ${alloc.managementCode}(으)로 변경되었습니다. 이어서 출고하세요.`);
      setChangeOpen(false);
      setCheckoutTarget(alloc); // 변경된 배정으로 이어서 출고
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : 'ID 변경에 실패했습니다.'),
  });

  const returnMutation = useMutation({
    mutationFn: (v: { returnDate: Dayjs; availableFrom: Dayjs; nextStatus: RentalItemStatus }) =>
      returnAllocation(returnTarget!.id, {
        returnDate: v.returnDate.format('YYYY-MM-DD'),
        availableFrom: v.availableFrom.format('YYYY-MM-DD'),
        nextStatus: v.nextStatus,
        version: returnTarget!.version,
      }),
    onSuccess: (alloc) => {
      message.success(`관리 ID ${alloc.managementCode} 반납 처리되었습니다.`);
      setReturnTarget(null);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '반납 처리에 실패했습니다.'),
  });

  // 출고·반납 대상은 품목을 가리지 않으므로 전 품목 코드를 받아 이름으로 바꾼다.
  const codes = useRentalCodeNames();

  const todayStr = dayjs().format('YYYY-MM-DD');

  /**
   * 출고·반납 공통 열.
   * 현장에서 필요한 건 "누가 / 무엇을 / 어떤 옷을"이다 —
   * 고객은 연락처까지, 실물은 관리코드만이 아니라 구분·컬러·사이즈까지 보여 준다.
   */
  const commonColumns: ColumnsType<RentalAllocation> = [
    {
      title: '고객',
      dataIndex: 'customerName',
      width: 130,
      render: (name: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{name}</Typography.Text>
          {r.customerPhone && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.customerPhone}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: '주문번호', dataIndex: 'orderNo', width: 150 },
    {
      title: '주문 품목',
      dataIndex: 'displayName',
      width: 150,
      render: (v: string | undefined, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{v ?? '-'}</Typography.Text>
          {r.componentType && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {RENTAL_COMPONENT_TYPE_LABELS[r.componentType] ?? r.componentType}
              {r.componentSequenceNo ? ` #${r.componentSequenceNo}` : ''}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '실물',
      dataIndex: 'managementCode',
      width: 200,
      render: (code: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{code}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {codes.colorName(r.color)} / {codes.sizeName(r.size)}
          </Typography.Text>
        </Space>
      ),
    },
  ];

  const pickupColumns: ColumnsType<RentalAllocation> = [
    ...commonColumns,
    {
      title: '픽업일',
      dataIndex: 'pickupDate',
      width: 120,
      render: (d: string) => (
        <Space size={4}>
          {d}
          {d < todayStr && <Tag color="red">지연</Tag>}
        </Space>
      ),
    },
    { title: '반납 예정일', dataIndex: 'returnDueDate', width: 110 },
    {
      title: '액션',
      key: 'actions',
      width: 110,
      render: (_, r) => (
        <Button
          size="small"
          type="primary"
          icon={<ExportOutlined />}
          onClick={() => {
            setCheckoutTarget(r);
            checkoutForm.setFieldsValue({ checkoutDate: dayjs(), notes: undefined });
          }}
        >
          출고
        </Button>
      ),
    },
  ];

  const returnColumns: ColumnsType<RentalAllocation> = [
    ...commonColumns,
    {
      title: '출고일',
      dataIndex: 'checkoutDate',
      width: 110,
      // 예정일이 아니라 실제로 나간 날. 백엔드 뷰는 actualPickupAt으로 내려 준다.
      render: (d: string | undefined, r) => d ?? r.actualPickupAt?.slice(0, 10) ?? '-',
    },
    {
      title: '반납 예정일',
      dataIndex: 'returnDueDate',
      width: 130,
      render: (d: string) => (
        <Space size={4}>
          {d}
          {d < todayStr && <Tag color="red">반납 지연</Tag>}
          {d === todayStr && <Tag color="orange">오늘</Tag>}
        </Space>
      ),
    },
    {
      title: '액션',
      key: 'actions',
      width: 110,
      render: (_, r) => (
        <Button
          size="small"
          icon={<ImportOutlined />}
          onClick={() => {
            setReturnTarget(r);
            returnForm.setFieldsValue({
              returnDate: dayjs(),
              availableFrom: dayjs().add(2, 'day'),
              nextStatus: 'RETURNED_HOLD',
            });
          }}
        >
          반납
        </Button>
      ),
    },
  ];

  return (
    <PageShell>
      <PageCard>
        {/* 화면끼리 잇던 [재고 목록]·[가용 검색·배정으로] 버튼은 뺐다 —
            좌측 메뉴 "렌탈 관리" 아래 같은 이동이 있고, 렌탈 세 화면이 그 버튼을
            저마다 다른 자리에 두는 바람에 배치가 어긋나 있었다. */}
        <ListToolbar
          filters={
            <Input.Search
              allowClear
              style={{ width: LAYOUT.searchWidth }}
              placeholder="고객명 · 주문번호 · 실물 ID 검색"
              defaultValue={keyword}
              onSearch={(v) => {
                const next = new URLSearchParams(searchParams);
                if (v.trim()) next.set('q', v.trim());
                else next.delete('q');
                setSearchParams(next, { replace: true });
              }}
            />
          }
        />

        <Tabs
          style={{ marginTop: 8 }}
          activeKey={activeTab}
          onChange={setTabOverride}
          items={[
            {
              key: 'pickup',
              label: `오늘 픽업(출고) 예정 (${pickups.length})`,
              children: (
                <DataTable<RentalAllocation>
                  rowKey="id"
                  loading={pickupsQuery.isLoading}
                  dataSource={pickups}
                  columns={pickupColumns}
                  pagination={false}
                />
              ),
            },
            {
              key: 'return',
              label: `반납 대상 (대여 중 ${returns.length})`,
              children: (
                <DataTable<RentalAllocation>
                  rowKey="id"
                  loading={returnsQuery.isLoading}
                  dataSource={returns}
                  columns={returnColumns}
                  pagination={false}
                />
              ),
            },
          ]}
        />
      </PageCard>

      {/* 출고 모달: 확인 ID 검증 → 불일치 시 RENTAL_ID_MISMATCH → ID 변경 */}
      <Modal
        title={checkoutTarget ? `출고 — ${checkoutTarget.customerName} · ${checkoutTarget.displayName ?? checkoutTarget.managementCode}` : '출고'}
        open={!!checkoutTarget}
        onCancel={() => setCheckoutTarget(null)}
        onOk={() => checkoutForm.submit()}
        okText="출고"
        cancelText="취소"
        confirmLoading={checkoutMutation.isPending}
        destroyOnClose
      >
        {checkoutTarget && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="예약 실물">
                <Space>
                  <Typography.Text strong>{checkoutTarget.managementCode}</Typography.Text>
                  <Typography.Text type="secondary">
                    {codes.colorName(checkoutTarget.color)} / {codes.sizeName(checkoutTarget.size)}
                  </Typography.Text>
                  {/*
                    확인 ID 대조를 없애면서 실물 교체로 들어가는 유일한 입구였던
                    불일치 알림도 함께 사라졌다 — 상시 버튼으로 되살린다.
                    비고는 기록용이고, 배정 자체를 바꾸려면 이쪽을 쓴다.
                  */}
                  <Button
                    size="small"
                    icon={<SwapOutlined />}
                    onClick={() => {
                      changeForm.resetFields();
                      setChangeOpen(true);
                    }}
                  >
                    실물 교체
                  </Button>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="대여 기간">
                {checkoutTarget.pickupDate} ~ {checkoutTarget.returnDueDate}
              </Descriptions.Item>
            </Descriptions>

            <Form
              form={checkoutForm}
              layout="vertical"
              onFinish={(values) => checkoutMutation.mutate(values)}
            >
              <Form.Item
                name="checkoutDate"
                label="실제 출고일"
                rules={[{ required: true, message: '출고일을 선택해 주세요.' }]}
              >
                <DatePicker style={{ width: '100%' }} autoFocus />
              </Form.Item>
              {/*
                예약된 옷과 다른 걸 내보낸 경우 등 현장 상황을 적어 둔다.
                배정 자체를 바꾸려면 아래 [배정 실물 변경]을 쓴다 — 이 비고는 기록용이다.
              */}
              <Form.Item name="notes" label="비고 (선택)">
                <Input.TextArea
                  rows={3}
                  placeholder="예: 예약된 JKT-BLACK-48-001 대신 JKT-BLACK-50-001로 출고 (사이즈 교환 요청)"
                />
              </Form.Item>
            </Form>
          </Space>
        )}
      </Modal>

      {/* ID 변경 다이얼로그: 신규 실물 선택 + 사유 → 재검증 후 출고 */}
      <Modal
        title="배정 실물 ID 변경"
        open={changeOpen}
        onCancel={() => setChangeOpen(false)}
        onOk={() => changeForm.submit()}
        okText="ID 변경"
        cancelText="취소"
        confirmLoading={changeMutation.isPending}
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="예약된 실물과 실제 출고 실물이 다르면 먼저 배정 ID를 변경해야 합니다. 변경 후 확인 ID를 다시 검증합니다."
        />
        <Form
          form={changeForm}
          layout="vertical"
          onFinish={(values) => changeMutation.mutate(values)}
        >
          <Form.Item
            name="newInventoryItemId"
            label="신규 실물 (배정 기간 가용 실물)"
            rules={[{ required: true, message: '신규 실물을 선택해 주세요.' }]}
          >
            <Select
              showSearch
              loading={changeCandidatesQuery.isLoading}
              placeholder="가용 실물 선택"
              optionFilterProp="label"
              options={(changeCandidatesQuery.data ?? [])
                .filter((it) => it.id !== checkoutTarget?.inventoryItemId)
                .map((it) => ({
                  value: it.id,
                  label: `${it.managementCode} · ${it.color} · ${it.size} (${metaOf(RENTAL_ITEM_STATUS_META, it.status).label})`,
                }))}
            />
          </Form.Item>
          <Form.Item
            name="reason"
            label="변경 사유"
            rules={[{ required: true, message: '변경 사유를 입력해 주세요.' }]}
          >
            <Input.TextArea rows={2} placeholder="예: 오염 확인으로 동일 규격 실물 교체" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 반납 모달: 실반납일 + 대여 가능 예정일 + 다음 상태 */}
      <Modal
        title={returnTarget ? `반납 — ${returnTarget.customerName} · ${returnTarget.managementCode}` : '반납'}
        open={!!returnTarget}
        onCancel={() => setReturnTarget(null)}
        onOk={() => returnForm.submit()}
        okText="반납 처리"
        cancelText="취소"
        confirmLoading={returnMutation.isPending}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="반납만으로 자동 대여 가능 처리되지 않습니다. 정비 완료 후 상태를 직접 전환하세요."
        />
        <Form form={returnForm} layout="vertical" onFinish={(values) => returnMutation.mutate(values)}>
          <Form.Item
            name="returnDate"
            label="실제 반납일"
            rules={[{ required: true, message: '실제 반납일을 선택해 주세요.' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="availableFrom"
            label="대여 가능 예정일"
            rules={[{ required: true, message: '대여 가능 예정일을 선택해 주세요.' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="nextStatus"
            label="다음 상태"
            rules={[{ required: true, message: '다음 상태를 선택해 주세요.' }]}
          >
            <Select
              options={RETURN_NEXT_STATUSES.map((s) => ({
                value: s,
                label: metaOf(RENTAL_ITEM_STATUS_META, s).label,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <PageCard>
        <Space size="large" wrap>
          <StatusBadge label="지연: 픽업일 또는 반납 예정일이 오늘 이전" color="red" />
        </Space>
      </PageCard>
    </PageShell>
  );
}
