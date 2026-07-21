import { ArrowLeftOutlined, EditOutlined, SwapOutlined, ToolOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  ALLOCATION_STATUS_META,
  RENTAL_COMPONENT_TYPE_LABELS,
  RENTAL_ITEM_STATUS_META,
  fetchRentalItemDetail,
  patchRentalItem,
  postRentalItemStatusEvent,
  type RentalAllocation,
  type RentalItemEvent,
  type RentalItemStatus,
} from '../../api/rentals';
import { createRepair } from '../../api/repairs';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { COLOR_OPTIONS, DESIGN_OPTIONS, statusOptions } from './rental-constants';
import { metaOf } from '../../shared/status-meta';

const EVENT_TYPE_META: Record<RentalItemEvent['type'], { label: string; color: string }> = {
  REGISTER: { label: '등록', color: 'default' },
  STATUS: { label: '상태', color: 'blue' },
  RENTAL: { label: '대여', color: 'geekblue' },
  ID_CHANGE: { label: 'ID 변경', color: 'orange' },
  REPAIR: { label: '수선', color: 'purple' },
};

/** RENT-002 렌탈 실물 상세: 속성·상태·배정·이력 */
export function RentalItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const [statusOpen, setStatusOpen] = useState(false);
  const [attrOpen, setAttrOpen] = useState(false);
  const [repairOpen, setRepairOpen] = useState(false);
  const [statusForm] = Form.useForm<{ newStatus: RentalItemStatus; availableFrom?: Dayjs; reason?: string }>();
  const [attrForm] = Form.useForm<{ design: string; color: string; size: string; notes?: string }>();
  const [repairForm] = Form.useForm<{ notes?: string; description: string; dueDate?: Dayjs }>();

  const detailQuery = useQuery({
    queryKey: ['rentals', 'inventory', id],
    queryFn: () => fetchRentalItemDetail(id!),
    enabled: !!id,
  });

  /** 수선 접수 시 사용할 고객 — 최근 배정 이력 기준 */
  const repairCustomer = (detailQuery.data?.allocations ?? []).find((a) => a.customerId);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['rentals'] });

  const statusMutation = useMutation({
    mutationFn: (v: { newStatus: RentalItemStatus; availableFrom?: Dayjs; reason?: string }) =>
      postRentalItemStatusEvent(id!, {
        newStatus: v.newStatus,
        availableFrom: v.availableFrom?.format('YYYY-MM-DD'),
        reason: v.reason,
        version: detailQuery.data?.item.version ?? 1,
      }),
    onSuccess: () => {
      message.success('상태가 변경되었습니다.');
      setStatusOpen(false);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '상태 변경에 실패했습니다.'),
  });

  const attrMutation = useMutation({
    mutationFn: (v: { design: string; color: string; size: string; notes?: string }) =>
      patchRentalItem(id!, { ...v, version: detailQuery.data?.item.version ?? 1 }),
    onSuccess: () => {
      message.success('속성이 수정되었습니다.');
      setAttrOpen(false);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '속성 수정에 실패했습니다.'),
  });

  const repairMutation = useMutation({
    mutationFn: (v: { notes?: string; description: string; dueDate?: Dayjs }) => {
      // 백엔드는 수선 접수에 고객이 필수다 — 이 실물의 최근 배정 고객으로 접수한다.
      const customerId = repairCustomer?.customerId;
      if (!customerId) {
        return Promise.reject(
          new ApiError('REPAIR_CUSTOMER_REQUIRED', '배정 이력이 없는 실물은 수선 메뉴에서 고객을 지정해 접수해 주세요.'),
        );
      }
      return createRepair({
        customerId,
        repairType: 'RENTAL_POST',
        rentalInventoryItemId: id,
        requestDate: dayjs().format('YYYY-MM-DD'),
        dueDate: v.dueDate?.format('YYYY-MM-DD'),
        description: v.description,
        notes: v.notes,
      });
    },
    onSuccess: () => {
      message.success('수선이 접수되었습니다. 수선 메뉴에서 진행 상태를 관리하세요.');
      setRepairOpen(false);
      repairForm.resetFields();
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '수선 접수에 실패했습니다.'),
  });

  if (detailQuery.isLoading) {
    return (
      <Card>
        <Spin style={{ display: 'block', margin: '48px auto' }} />
      </Card>
    );
  }
  if (detailQuery.isError || !detailQuery.data) {
    return (
      <Card>
        <Result
          status="404"
          title="렌탈 실물을 찾을 수 없습니다"
          extra={
            <Button onClick={() => navigate('/rentals')} icon={<ArrowLeftOutlined />}>
              재고 목록으로
            </Button>
          }
        />
      </Card>
    );
  }

  const { item, allocations, events } = detailQuery.data;
  const activeAllocations = allocations.filter(
    (a) => a.status === 'RESERVED' || a.status === 'PREPARING' || a.status === 'CHECKED_OUT',
  );
  const statusMeta = metaOf(RENTAL_ITEM_STATUS_META, item.status);

  const allocationColumns: ColumnsType<RentalAllocation> = [
    { title: '고객', dataIndex: 'customerName', width: 100 },
    { title: '주문번호', dataIndex: 'orderNo', width: 150 },
    { title: '구성품', dataIndex: 'componentLabel' },
    { title: '픽업일', dataIndex: 'pickupDate', width: 110 },
    { title: '반납 예정일', dataIndex: 'returnDueDate', width: 110 },
    { title: '가용 종료일', dataIndex: 'availabilityEndDate', width: 110 },
    {
      title: '상태',
      dataIndex: 'status',
      width: 100,
      render: (s: RentalAllocation['status']) => (
        <StatusBadge label={metaOf(ALLOCATION_STATUS_META, s).label} color={metaOf(ALLOCATION_STATUS_META, s).color} />
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/rentals')}>
              목록
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              렌탈 실물 상세 — {item.managementCode}
            </Typography.Title>
            <StatusBadge label={statusMeta.label} color={statusMeta.color} />
          </Space>
          <Space wrap>
            <Can permission="RENTAL_EDIT">
              <Button
                icon={<EditOutlined />}
                onClick={() => {
                  attrForm.setFieldsValue({
                    design: item.design,
                    color: item.color,
                    size: item.size,
                    notes: item.notes,
                  });
                  setAttrOpen(true);
                }}
              >
                속성 수정
              </Button>
            </Can>
            <Can permission="RENTAL_STATUS_EDIT">
              <Button
                type="primary"
                icon={<SwapOutlined />}
                onClick={() => {
                  statusForm.resetFields();
                  statusForm.setFieldsValue({
                    availableFrom: item.availableFrom ? dayjs(item.availableFrom) : undefined,
                  });
                  setStatusOpen(true);
                }}
              >
                상태 변경
              </Button>
            </Can>
            <Can permission="REPAIR_EDIT">
              <Button icon={<ToolOutlined />} onClick={() => setRepairOpen(true)}>
                수선 접수
              </Button>
            </Can>
          </Space>
        </Space>

        <Descriptions bordered size="small" column={3} style={{ marginTop: 16 }}>
          <Descriptions.Item label="관리코드">{item.managementCode}</Descriptions.Item>
          <Descriptions.Item label="구분">{RENTAL_COMPONENT_TYPE_LABELS[item.componentType]}</Descriptions.Item>
          <Descriptions.Item label="디자인">{item.design}</Descriptions.Item>
          <Descriptions.Item label="컬러">{item.color}</Descriptions.Item>
          <Descriptions.Item label="사이즈">{item.size}</Descriptions.Item>
          <Descriptions.Item label="현재 상태">
            <StatusBadge label={statusMeta.label} color={statusMeta.color} />
          </Descriptions.Item>
          <Descriptions.Item label="대여 가능 예정일">{item.availableFrom ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="메모" span={2}>
            {item.notes ?? '-'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={14}>
          <Card title="현재·미래 예약 기간" size="small">
            {activeAllocations.length > 0 ? (
              <Table<RentalAllocation>
                rowKey="id"
                size="small"
                dataSource={activeAllocations}
                columns={allocationColumns}
                pagination={false}
              />
            ) : (
              <Empty description="진행 중이거나 예정된 배정이 없습니다." image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
            {allocations.length > activeAllocations.length && (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                종료(반납·취소)된 배정 {allocations.length - activeAllocations.length}건은 이력 타임라인에서 확인할 수 있습니다.
              </Typography.Paragraph>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="대여·ID 변경·수선 이력" size="small">
            {events.length > 0 ? (
              <Timeline
                items={events.map((ev) => ({
                  key: ev.id,
                  children: (
                    <>
                      <Space size="small">
                        <Tag color={metaOf(EVENT_TYPE_META, ev.type).color}>{metaOf(EVENT_TYPE_META, ev.type).label}</Tag>
                        <Typography.Text strong>{ev.label}</Typography.Text>
                      </Space>
                      <div>
                        <Typography.Text type="secondary">
                          {dayjs(ev.at).format('YYYY-MM-DD HH:mm')} · {ev.by}
                        </Typography.Text>
                      </div>
                      {ev.detail && <Typography.Text type="secondary">{ev.detail}</Typography.Text>}
                      {ev.reason && (
                        <div>
                          <Typography.Text type="secondary">사유: {ev.reason}</Typography.Text>
                        </div>
                      )}
                    </>
                  ),
                }))}
              />
            ) : (
              <Empty description="이력이 없습니다." image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>

      {/* 상태 수동 변경 모달 */}
      <Modal
        title={`상태 변경 — 현재: ${statusMeta.label}`}
        open={statusOpen}
        onCancel={() => setStatusOpen(false)}
        onOk={() => statusForm.submit()}
        okText="변경"
        cancelText="취소"
        confirmLoading={statusMutation.isPending}
        destroyOnClose
      >
        <Form
          form={statusForm}
          layout="vertical"
          onFinish={(values) => statusMutation.mutate(values)}
        >
          <Form.Item
            name="newStatus"
            label="변경할 상태"
            rules={[{ required: true, message: '상태를 선택해 주세요.' }]}
          >
            <Select
              placeholder="상태 선택"
              options={statusOptions.filter((o) => o.value !== item.status)}
            />
          </Form.Item>
          <Form.Item
            name="availableFrom"
            label="대여 가능 예정일"
            tooltip="AVAILABLE 전환 시 오늘 이전이어야 합니다."
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="변경 사유">
            <Input.TextArea rows={2} placeholder="상태 변경 사유" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 속성 수정 모달 */}
      <Modal
        title="속성 수정"
        open={attrOpen}
        onCancel={() => setAttrOpen(false)}
        onOk={() => attrForm.submit()}
        okText="저장"
        cancelText="취소"
        confirmLoading={attrMutation.isPending}
        destroyOnClose
      >
        <Form form={attrForm} layout="vertical" onFinish={(values) => attrMutation.mutate(values)}>
          <Form.Item name="design" label="디자인" rules={[{ required: true, message: '디자인을 선택해 주세요.' }]}>
            <Select options={DESIGN_OPTIONS} />
          </Form.Item>
          <Form.Item name="color" label="컬러" rules={[{ required: true, message: '컬러를 선택해 주세요.' }]}>
            <Select options={COLOR_OPTIONS} />
          </Form.Item>
          <Form.Item name="size" label="사이즈" rules={[{ required: true, message: '사이즈를 입력해 주세요.' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="notes" label="메모">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 실물 연결 수선 접수 모달 */}
      <Modal
        title={`수선 접수 — ${item.managementCode}`}
        open={repairOpen}
        onCancel={() => setRepairOpen(false)}
        onOk={() => repairForm.submit()}
        okText="접수"
        cancelText="취소"
        confirmLoading={repairMutation.isPending}
        destroyOnClose
      >
        <Form form={repairForm} layout="vertical" onFinish={(values) => repairMutation.mutate(values)}>
          <Form.Item label="고객">
            {repairCustomer ? (
              <Typography.Text>
                {repairCustomer.customerName}
                <Typography.Text type="secondary"> · 최근 배정 기준</Typography.Text>
              </Typography.Text>
            ) : (
              <Typography.Text type="warning">
                배정 이력이 없어 이 화면에서 접수할 수 없습니다. 수선 메뉴에서 고객을 지정해 접수해 주세요.
              </Typography.Text>
            )}
          </Form.Item>
          <Form.Item
            name="description"
            label="수선 내용"
            rules={[{ required: true, message: '수선 내용을 입력해 주세요.' }]}
          >
            <Input.TextArea rows={3} placeholder="예: 소매 안감 뜯어짐 수선" />
          </Form.Item>
          <Form.Item name="notes" label="비고">
            <Input placeholder="예: 반납 검수 중 발견" />
          </Form.Item>
          <Form.Item name="dueDate" label="완료 예정일">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
