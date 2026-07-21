import { ArrowLeftOutlined, ExportOutlined, ImportOutlined, SwapOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  RENTAL_ITEM_STATUS_META,
  RETURN_NEXT_STATUSES,
  changeAllocationItem,
  checkoutAllocation,
  fetchAllocations,
  fetchAvailability,
  returnAllocation,
  type RentalAllocation,
  type RentalItemStatus,
} from '../../api/rentals';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';

/** RENT-004 렌탈 출고·반납 */
export function RentalHandoverPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [checkoutTarget, setCheckoutTarget] = useState<RentalAllocation | null>(null);
  const [returnTarget, setReturnTarget] = useState<RentalAllocation | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const [mismatchError, setMismatchError] = useState<string | null>(null);

  const [checkoutForm] = Form.useForm<{ confirmedItemCode: string; checkoutDate: Dayjs }>();
  const [returnForm] = Form.useForm<{ returnDate: Dayjs; availableFrom: Dayjs; nextStatus: RentalItemStatus }>();
  const [changeForm] = Form.useForm<{ newInventoryItemId: string; reason: string }>();

  const pickupsQuery = useQuery({
    queryKey: ['rentals', 'allocations', 'pickup'],
    queryFn: () => fetchAllocations('pickup'),
  });
  const returnsQuery = useQuery({
    queryKey: ['rentals', 'allocations', 'return'],
    queryFn: () => fetchAllocations('return'),
  });

  // ID 변경 다이얼로그: 배정 기간 기준 가용 실물 조회
  const changeCandidatesQuery = useQuery({
    queryKey: ['rentals', 'change-candidates', checkoutTarget?.id, checkoutTarget?.managementCode],
    queryFn: () =>
      fetchAvailability({
        pickupDate: checkoutTarget!.pickupDate,
        availabilityEndDate: checkoutTarget!.availabilityEndDate,
      }),
    enabled: changeOpen && !!checkoutTarget,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['rentals'] });

  const checkoutMutation = useMutation({
    mutationFn: (v: { confirmedItemCode: string; checkoutDate: Dayjs }) =>
      checkoutAllocation(checkoutTarget!.id, {
        confirmedItemCode: v.confirmedItemCode.trim(),
        checkoutDate: v.checkoutDate.format('YYYY-MM-DD'),
        version: checkoutTarget!.version,
      }),
    onSuccess: (alloc) => {
      message.success(`관리 ID ${alloc.managementCode} 출고 처리되었습니다.`);
      setCheckoutTarget(null);
      setMismatchError(null);
      void invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'RENTAL_ID_MISMATCH') {
        // 불일치: 오류를 표시하고 "ID 변경" 흐름을 안내
        setMismatchError(e.message);
      } else {
        message.error(e instanceof ApiError ? e.message : '출고 처리에 실패했습니다.');
      }
    },
  });

  const changeMutation = useMutation({
    mutationFn: (v: { newInventoryItemId: string; reason: string }) =>
      changeAllocationItem(checkoutTarget!.id, {
        newInventoryItemId: v.newInventoryItemId,
        reason: v.reason,
        version: checkoutTarget!.version,
      }),
    onSuccess: (alloc) => {
      message.success(`배정 실물이 ${alloc.managementCode}(으)로 변경되었습니다. 확인 ID를 다시 검증한 뒤 출고하세요.`);
      setChangeOpen(false);
      setMismatchError(null);
      setCheckoutTarget(alloc); // 변경된 배정으로 재검증
      checkoutForm.setFieldsValue({ confirmedItemCode: '' });
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

  const todayStr = dayjs().format('YYYY-MM-DD');

  const pickupColumns: ColumnsType<RentalAllocation> = [
    { title: '고객', dataIndex: 'customerName', width: 100 },
    { title: '주문번호', dataIndex: 'orderNo', width: 150 },
    { title: '구성품', dataIndex: 'componentLabel' },
    { title: '예약 실물 ID', dataIndex: 'managementCode', width: 170 },
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
            setMismatchError(null);
            checkoutForm.setFieldsValue({ confirmedItemCode: '', checkoutDate: dayjs() });
          }}
        >
          출고
        </Button>
      ),
    },
  ];

  const returnColumns: ColumnsType<RentalAllocation> = [
    { title: '고객', dataIndex: 'customerName', width: 100 },
    { title: '주문번호', dataIndex: 'orderNo', width: 150 },
    { title: '구성품', dataIndex: 'componentLabel' },
    { title: '실물 ID', dataIndex: 'managementCode', width: 170 },
    { title: '출고일', dataIndex: 'checkoutDate', width: 110, render: (d?: string) => d ?? '-' },
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
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/rentals')}>
              재고 목록
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              렌탈 출고·반납 (RENT-004)
            </Typography.Title>
          </Space>
          <Button onClick={() => navigate('/rentals/allocate')}>가용 검색·배정으로</Button>
        </Space>

        <Tabs
          style={{ marginTop: 8 }}
          items={[
            {
              key: 'pickup',
              label: `오늘 픽업(출고) 예정 (${pickupsQuery.data?.length ?? 0})`,
              children: (
                <Table<RentalAllocation>
                  rowKey="id"
                  size="middle"
                  loading={pickupsQuery.isLoading}
                  dataSource={pickupsQuery.data ?? []}
                  columns={pickupColumns}
                  pagination={false}
                />
              ),
            },
            {
              key: 'return',
              label: `반납 대상 (대여 중 ${returnsQuery.data?.length ?? 0})`,
              children: (
                <Table<RentalAllocation>
                  rowKey="id"
                  size="middle"
                  loading={returnsQuery.isLoading}
                  dataSource={returnsQuery.data ?? []}
                  columns={returnColumns}
                  pagination={false}
                />
              ),
            },
          ]}
        />
      </Card>

      {/* 출고 모달: 확인 ID 검증 → 불일치 시 RENTAL_ID_MISMATCH → ID 변경 */}
      <Modal
        title={checkoutTarget ? `출고 — ${checkoutTarget.customerName} · ${checkoutTarget.componentLabel}` : '출고'}
        open={!!checkoutTarget}
        onCancel={() => {
          setCheckoutTarget(null);
          setMismatchError(null);
        }}
        onOk={() => checkoutForm.submit()}
        okText="출고"
        cancelText="취소"
        confirmLoading={checkoutMutation.isPending}
        destroyOnClose
      >
        {checkoutTarget && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="예약 실물 ID">
                <Typography.Text strong>{checkoutTarget.managementCode}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="대여 기간">
                {checkoutTarget.pickupDate} ~ {checkoutTarget.returnDueDate}
              </Descriptions.Item>
            </Descriptions>

            {mismatchError && (
              <Alert
                type="error"
                showIcon
                message="확인 ID 불일치 (RENTAL_ID_MISMATCH)"
                description={mismatchError}
                action={
                  <Button
                    danger
                    size="small"
                    icon={<SwapOutlined />}
                    onClick={() => {
                      changeForm.resetFields();
                      setChangeOpen(true);
                    }}
                  >
                    ID 변경
                  </Button>
                }
              />
            )}

            <Form
              form={checkoutForm}
              layout="vertical"
              onFinish={(values) => checkoutMutation.mutate(values)}
            >
              <Form.Item
                name="confirmedItemCode"
                label="확인 ID (실물 라벨의 관리 ID 입력)"
                rules={[{ required: true, message: '확인 ID를 입력해 주세요.' }]}
              >
                <Input placeholder="예: JKT-BLK-100-001" autoFocus />
              </Form.Item>
              <Form.Item
                name="checkoutDate"
                label="실제 출고일"
                rules={[{ required: true, message: '출고일을 선택해 주세요.' }]}
              >
                <DatePicker style={{ width: '100%' }} />
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
                  label: `${it.managementCode} · ${it.design} · ${it.color} · ${it.size} (${metaOf(RENTAL_ITEM_STATUS_META, it.status).label})`,
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

      <Card size="small">
        <Space size="large" wrap>
          <StatusBadge label="지연: 픽업일 또는 반납 예정일이 오늘 이전" color="red" />
          <Typography.Text type="secondary">
            출고는 확인 ID가 예약 ID와 일치해야 하며, 불일치 시 ID 변경 후 재검증합니다.
          </Typography.Text>
        </Space>
      </Card>
    </Space>
  );
}
