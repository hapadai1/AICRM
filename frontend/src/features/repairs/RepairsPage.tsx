import { PlusOutlined, StopOutlined, SwapOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { fetchCustomers } from '../../api/customers';
import { fetchRentalItems } from '../../api/rentals';
import {
  REPAIR_COMPONENT_TYPE_LABELS,
  REPAIR_STATUS_FLOW,
  REPAIR_TYPES,
  REPAIR_TYPE_LABELS,
  createRepair,
  fetchRepair,
  fetchRepairLinkTargets,
  fetchRepairs,
  nextRepairStatus,
  postRepairStatusEvent,
  repairLinkKind,
  repairStatusMeta,
  repairTypeLabel,
  type Repair,
  type RepairNotificationSuggestion,
  type RepairStatus,
  type RepairType,
} from '../../api/repairs';
import { Can } from '../../shared/Can';
import { NotificationConfirmModal } from '../../shared/NotificationConfirmModal';
import { StatusBadge } from '../../shared/StatusBadge';

interface ReceiptValues {
  customerId: string;
  repairType: RepairType;
  orderItemId?: string;
  componentId?: string;
  rentalInventoryItemId?: string;
  requestDate: Dayjs;
  dueDate?: Dayjs;
  description: string;
  cost?: number;
  notes?: string;
}

interface StatusChangeState {
  repair: Repair;
  toStatus: RepairStatus;
}

const STATUS_FILTER_OPTIONS = [...REPAIR_STATUS_FLOW, 'CANCELLED' as const].map((s) => ({
  value: s,
  label: repairStatusMeta(s).label,
}));

/** REPAIR-001 수선 접수·진행 */
export function RepairsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [customerFilter, setCustomerFilter] = useState<string | undefined>();
  const [customerKeyword, setCustomerKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<StatusChangeState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 상태 변경 후 뜨는 고객 연락 확인창 (개발설계서 05 G-06)
  const [suggestion, setSuggestion] = useState<RepairNotificationSuggestion | null>(null);
  const [suggestionTitle, setSuggestionTitle] = useState('');

  const [receiptForm] = Form.useForm<ReceiptValues>();
  const [noteForm] = Form.useForm<{ notes?: string }>();

  const listQuery = useQuery({
    queryKey: ['repairs', 'list', { statusFilter, customerFilter, page, size }],
    queryFn: () =>
      fetchRepairs({ status: statusFilter, customerId: customerFilter, page, size }),
  });

  // 고객 검색 — 필터·접수 모달 공용 (전화번호로도 검색된다)
  const customerQuery = useQuery({
    queryKey: ['customers', 'search', customerKeyword],
    queryFn: () =>
      fetchCustomers({ q: customerKeyword || undefined, includeProspect: true, size: 20 }),
  });

  const receiptCustomerId = Form.useWatch('customerId', receiptForm);
  const receiptType = Form.useWatch('repairType', receiptForm);
  const linkKind = repairLinkKind((receiptType ?? 'AFTER_SALE') as RepairType);

  const linkTargetsQuery = useQuery({
    queryKey: ['repairs', 'link-targets', receiptCustomerId],
    queryFn: () => fetchRepairLinkTargets(receiptCustomerId as string),
    enabled: receiptOpen && !!receiptCustomerId,
  });

  const rentalItemsQuery = useQuery({
    queryKey: ['repairs', 'rental-items'],
    queryFn: () => fetchRentalItems({ size_: 100 }),
    enabled: receiptOpen && linkKind === 'RENTAL',
  });

  const detailQuery = useQuery({
    queryKey: ['repairs', 'detail', expandedId],
    queryFn: () => fetchRepair(expandedId as string),
    enabled: !!expandedId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['repairs'] });
    void queryClient.invalidateQueries({ queryKey: ['rentals'] });
  };

  const createMutation = useMutation({
    mutationFn: (v: ReceiptValues) =>
      createRepair({
        customerId: v.customerId,
        repairType: v.repairType,
        requestDate: v.requestDate.format('YYYY-MM-DD'),
        dueDate: v.dueDate?.format('YYYY-MM-DD'),
        description: v.description,
        cost: v.cost,
        notes: v.notes,
        orderItemId: v.componentId ? undefined : v.orderItemId,
        componentId: v.componentId,
        rentalInventoryItemId: v.rentalInventoryItemId,
      }),
    onSuccess: (r) => {
      message.success(`${r.customerName} 고객의 수선이 접수되었습니다.`);
      setReceiptOpen(false);
      receiptForm.resetFields();
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '수선 접수에 실패했습니다.'),
  });

  const statusMutation = useMutation({
    mutationFn: (v: { repair: Repair; toStatus: RepairStatus; notes?: string }) =>
      postRepairStatusEvent(v.repair.id, { newStatus: v.toStatus, notes: v.notes }),
    onSuccess: (result, v) => {
      setStatusTarget(null);
      noteForm.resetFields();
      invalidate();
      // 연락 대상 상태면 문구를 확인하고 보낼 수 있게 확인창을 띄운다.
      if (result.suggestedNotification) {
        setSuggestionTitle(`상태를 '${repairStatusMeta(v.toStatus).label}'(으)로 변경했습니다`);
        setSuggestion(result.suggestedNotification);
      } else {
        message.success(`상태가 '${repairStatusMeta(v.toStatus).label}'(으)로 변경되었습니다.`);
      }
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '상태 변경에 실패했습니다.'),
  });

  const customerOptions = (customerQuery.data?.data ?? []).map((c) => ({
    value: c.id,
    label: `${c.name} (${c.phone})`,
  }));

  // 맞춤 수선 대상: 품목과 그 하위 구성품을 한 셀렉트에서 고른다.
  const customTargetOptions = (linkTargetsQuery.data?.orderItems ?? []).map((item) => ({
    label: `${item.orderNo} · ${item.displayName}`,
    options: [
      { value: `item:${item.id}`, label: `${item.displayName} (품목 전체)` },
      ...item.components.map((c) => ({
        value: `component:${c.id}:${item.id}`,
        label: `${item.displayName} · ${REPAIR_COMPONENT_TYPE_LABELS[c.componentType] ?? c.componentType} #${c.sequenceNo}`,
      })),
    ],
  }));

  const allocatedRentalIds = new Set(
    (linkTargetsQuery.data?.rentalItems ?? []).map((it) => it.id),
  );
  const rentalTargetOptions = [
    {
      label: '이 고객에게 배정된 실물',
      options: (linkTargetsQuery.data?.rentalItems ?? []).map((it) => ({
        value: it.id,
        label: `${it.managementCode} · ${it.design} · ${it.color} · ${it.size}`,
      })),
    },
    {
      label: '전체 실물',
      options: (rentalItemsQuery.data?.data ?? [])
        .filter((it) => it.status !== 'RETIRED' && !allocatedRentalIds.has(it.id))
        .map((it) => ({
          value: it.id,
          label: `${it.managementCode} · ${it.design} · ${it.color} · ${it.size}`,
        })),
    },
  ];

  const openStatusChange = (repair: Repair, toStatus: RepairStatus) => {
    noteForm.resetFields();
    setStatusTarget({ repair, toStatus });
  };

  const columns: ColumnsType<Repair> = [
    {
      title: '고객',
      dataIndex: 'customerName',
      width: 160,
      render: (name: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.customerPhone}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '유형',
      dataIndex: 'repairType',
      width: 120,
      render: (t: string) => <Tag>{repairTypeLabel(t)}</Tag>,
    },
    {
      title: '대상',
      dataIndex: 'targetLabel',
      width: 190,
      render: (label: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{label}</Typography.Text>
          {r.orderNo && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.orderNo}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: '접수일', dataIndex: 'requestDate', width: 110 },
    {
      title: '완료 예정일',
      dataIndex: 'dueDate',
      width: 130,
      render: (d: string | undefined, r) => (
        <Space size={4}>
          {d ?? '-'}
          {d && d < dayjs().format('YYYY-MM-DD') && !['RELEASED', 'CANCELLED'].includes(r.status) && (
            <Tag color="red">지연</Tag>
          )}
        </Space>
      ),
    },
    { title: '내용', dataIndex: 'description', ellipsis: true },
    {
      title: '비용',
      dataIndex: 'cost',
      width: 100,
      align: 'right',
      render: (c?: number) => (c != null ? `${c.toLocaleString()}원` : '-'),
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: 120,
      render: (s: string) => {
        const meta = repairStatusMeta(s);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    {
      title: '액션',
      key: 'actions',
      width: 190,
      render: (_, r) => {
        const next = nextRepairStatus(r.status);
        const closed = r.status === 'CANCELLED' || r.status === 'RELEASED';
        const pending = statusMutation.isPending && statusMutation.variables?.repair.id === r.id;
        return (
          <Can permission="REPAIR_EDIT">
            <Space size="small" wrap>
              {next && (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<SwapOutlined />}
                  loading={pending}
                  onClick={() => openStatusChange(r, next)}
                >
                  {repairStatusMeta(next).label} 처리
                </Button>
              )}
              {!closed && (
                <Button size="small" danger icon={<StopOutlined />} onClick={() => openStatusChange(r, 'CANCELLED')}>
                  취소
                </Button>
              )}
            </Space>
          </Can>
        );
      },
    },
  ];

  const isCancel = statusTarget?.toStatus === 'CANCELLED';

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              수선 접수·진행 (REPAIR-001)
            </Typography.Title>
            <Select
              showSearch
              allowClear
              placeholder="고객 검색 (이름·전화)"
              style={{ width: 220 }}
              filterOption={false}
              onSearch={setCustomerKeyword}
              loading={customerQuery.isLoading}
              options={customerOptions}
              value={customerFilter}
              onChange={(v: string | undefined) => {
                setCustomerFilter(v);
                setPage(1);
              }}
            />
            <Select
              allowClear
              placeholder="상태 전체"
              style={{ width: 150 }}
              value={statusFilter}
              onChange={(v: string | undefined) => {
                setStatusFilter(v);
                setPage(1);
              }}
              options={STATUS_FILTER_OPTIONS}
            />
          </Space>
          <Can permission="REPAIR_EDIT">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setReceiptOpen(true)}>
              수선 접수
            </Button>
          </Can>
        </Space>

        <Typography.Text type="secondary">
          진행 순서: 접수 → 수선 요청 → 수선 중 → 수선 입고 → 고객 연락 → 출고 완료 (다음 단계로만 이동,
          취소는 어느 단계에서든 가능)
        </Typography.Text>

        <Table<Repair>
          rowKey="id"
          size="middle"
          loading={listQuery.isLoading}
          dataSource={listQuery.data?.data ?? []}
          columns={columns}
          scroll={{ x: 1300 }}
          pagination={{
            current: page,
            pageSize: size,
            total: listQuery.data?.page.totalElements ?? 0,
            showSizeChanger: true,
            pageSizeOptions: ['30', '50', '100'],
            showTotal: (total) => `총 ${total}건`,
            onChange: (nextPage, nextSize) => {
              setPage(nextSize !== size ? 1 : nextPage);
              setSize(nextSize);
            },
          }}
          expandable={{
            expandedRowKeys: expandedId ? [expandedId] : [],
            onExpand: (expanded, r) => setExpandedId(expanded ? r.id : null),
            expandedRowRender: (r) => {
              const detail = detailQuery.data?.id === r.id ? detailQuery.data : undefined;
              return (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Typography.Text>내용: {r.description}</Typography.Text>
                  {r.notes && <Typography.Text type="secondary">비고: {r.notes}</Typography.Text>}
                  {detailQuery.isLoading && !detail ? (
                    <Typography.Text type="secondary">상태 이력을 불러오는 중…</Typography.Text>
                  ) : (
                    <Timeline
                      style={{ marginTop: 8 }}
                      items={[...(detail?.events ?? [])]
                        .sort((a, b) => b.eventDate.localeCompare(a.eventDate))
                        .map((ev) => ({
                          key: ev.id,
                          children: (
                            <>
                              <Typography.Text strong>
                                {repairStatusMeta(ev.newStatus).label}
                              </Typography.Text>
                              <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                                {ev.eventDate} · {ev.actorName}
                              </Typography.Text>
                              {ev.notes && (
                                <div>
                                  <Typography.Text type="secondary">사유: {ev.notes}</Typography.Text>
                                </div>
                              )}
                            </>
                          ),
                        }))}
                    />
                  )}
                </Space>
              );
            },
          }}
        />
      </Space>

      {/* 수선 접수 모달 — 고객을 먼저 고르면 연결 대상 후보가 채워진다. */}
      <Modal
        title="수선 접수"
        open={receiptOpen}
        onCancel={() => setReceiptOpen(false)}
        onOk={() => receiptForm.submit()}
        okText="접수"
        cancelText="취소"
        confirmLoading={createMutation.isPending}
        width={640}
        destroyOnClose
      >
        <Form<ReceiptValues>
          form={receiptForm}
          layout="vertical"
          initialValues={{ repairType: 'AFTER_SALE', requestDate: dayjs() }}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item
            name="customerId"
            label="고객"
            rules={[{ required: true, message: '고객을 선택해 주세요.' }]}
          >
            <Select
              showSearch
              placeholder="이름·전화번호 검색"
              filterOption={false}
              onSearch={setCustomerKeyword}
              loading={customerQuery.isLoading}
              options={customerOptions}
              onChange={() =>
                receiptForm.setFieldsValue({
                  orderItemId: undefined,
                  componentId: undefined,
                  rentalInventoryItemId: undefined,
                })
              }
            />
          </Form.Item>

          <Form.Item name="repairType" label="수선 유형" rules={[{ required: true }]}>
            <Select
              options={REPAIR_TYPES.map((t) => ({ value: t, label: REPAIR_TYPE_LABELS[t] }))}
              onChange={() =>
                receiptForm.setFieldsValue({
                  orderItemId: undefined,
                  componentId: undefined,
                  rentalInventoryItemId: undefined,
                })
              }
            />
          </Form.Item>

          {linkKind === 'CUSTOM' && (
            <Form.Item
              label="대상 품목·구성품"
              required
              rules={[{ required: true }]}
              extra={!receiptCustomerId ? '고객을 먼저 선택해 주세요.' : undefined}
            >
              <Select
                placeholder="맞춤 품목 또는 구성품 선택"
                loading={linkTargetsQuery.isLoading}
                disabled={!receiptCustomerId}
                options={customTargetOptions}
                onChange={(v: string) => {
                  const [kind, id, itemId] = v.split(':');
                  receiptForm.setFieldsValue(
                    kind === 'component'
                      ? { componentId: id, orderItemId: itemId }
                      : { componentId: undefined, orderItemId: id },
                  );
                }}
              />
            </Form.Item>
          )}
          {/* 백엔드로 보내는 실제 값 (구성품 선택 시 상위 품목도 함께 채운다) */}
          <Form.Item
            name="orderItemId"
            hidden
            rules={
              linkKind === 'CUSTOM'
                ? [{ required: true, message: '대상 품목 또는 구성품을 선택해 주세요.' }]
                : []
            }
          >
            <Input />
          </Form.Item>
          <Form.Item name="componentId" hidden>
            <Input />
          </Form.Item>

          {linkKind === 'RENTAL' && (
            <Form.Item
              name="rentalInventoryItemId"
              label="대상 렌탈 실물"
              rules={[{ required: true, message: '렌탈 실물을 선택해 주세요.' }]}
              extra="수선 중에는 해당 실물을 신규 배정할 수 없습니다."
            >
              <Select
                showSearch
                placeholder="관리 ID 검색"
                optionFilterProp="label"
                loading={rentalItemsQuery.isLoading || linkTargetsQuery.isLoading}
                options={rentalTargetOptions}
              />
            </Form.Item>
          )}

          <Space size="middle" style={{ display: 'flex' }} align="start">
            <Form.Item
              name="requestDate"
              label="접수일"
              rules={[{ required: true, message: '접수일을 선택해 주세요.' }]}
            >
              <DatePicker />
            </Form.Item>
            <Form.Item name="dueDate" label="완료 예정일">
              <DatePicker />
            </Form.Item>
            <Form.Item name="cost" label="수선 비용(원)">
              <InputNumber min={0} step={1000} style={{ width: 160 }} />
            </Form.Item>
          </Space>

          <Form.Item
            name="description"
            label="수선 내용"
            rules={[{ required: true, message: '수선 내용을 입력해 주세요.' }]}
            extra={linkKind === 'NONE' ? '일반 수선은 대상 설명을 내용에 함께 적어 주세요.' : undefined}
          >
            <Input.TextArea rows={3} placeholder="예: 하의 기장 1.5cm 줄임" />
          </Form.Item>
          <Form.Item name="notes" label="비고">
            <Input placeholder="예: 반납 검수 중 발견" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 상태 변경 확인 — 취소는 사유 필수 */}
      <Modal
        title={
          statusTarget
            ? `${repairStatusMeta(statusTarget.repair.status).label} → ${repairStatusMeta(statusTarget.toStatus).label}`
            : '상태 변경'
        }
        open={!!statusTarget}
        onCancel={() => setStatusTarget(null)}
        onOk={() => noteForm.submit()}
        okText="변경"
        cancelText="닫기"
        okButtonProps={{ danger: isCancel }}
        confirmLoading={statusMutation.isPending}
        destroyOnClose
      >
        <Form
          form={noteForm}
          layout="vertical"
          onFinish={(values: { notes?: string }) => {
            if (!statusTarget) return;
            statusMutation.mutate({
              repair: statusTarget.repair,
              toStatus: statusTarget.toStatus,
              notes: values.notes,
            });
          }}
        >
          <Typography.Paragraph type="secondary">
            {statusTarget?.repair.customerName} · {statusTarget?.repair.targetLabel}
          </Typography.Paragraph>
          <Form.Item
            name="notes"
            label={isCancel ? '취소 사유' : '메모 (선택)'}
            rules={isCancel ? [{ required: true, message: '취소 사유를 입력해 주세요.' }] : []}
          >
            <Input.TextArea rows={2} placeholder={isCancel ? '취소 사유 (필수)' : '상태 변경 메모'} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 수선은 진행 단계와 같은 확인창을 공유한다. 자동 발송은 하지 않는다. */}
      <NotificationConfirmModal
        open={suggestion != null}
        title={suggestionTitle}
        suggestion={suggestion}
        onDone={() => setSuggestion(null)}
        onCancel={() => setSuggestion(null)}
      />
    </Card>
  );
}
