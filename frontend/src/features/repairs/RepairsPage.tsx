import { PlusOutlined, StopOutlined, SwapOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { LAYOUT } from '../../app/theme';
import { DataTable, PAGE_SIZE_OPTIONS } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { fetchCustomers } from '../../api/customers';
import {
  REPAIR_COMPONENT_TYPE_LABELS,
  REPAIR_STATUS_FLOW,
  REPAIR_TYPES,
  createRepair,
  fetchRepair,
  fetchRepairLinkTargets,
  fetchRepairs,
  nextRepairStatus,
  postRepairStatusEvent,
  repairLinkKind,
  repairStatusMeta,
  repairTypeLabel,
  REPAIR_METHOD_LABELS,
  REPAIR_RECEIPT_METHODS,
  REPAIR_RELEASE_METHODS,
  type Repair,
  type RepairEvent,
  type RepairNotificationSuggestion,
  type RepairReceiptMethod,
  type RepairReleaseMethod,
  type RepairStatus,
} from '../../api/repairs';
import { Can } from '../../shared/Can';
import { NotificationConfirmModal } from '../../shared/NotificationConfirmModal';
import { StatusBadge } from '../../shared/StatusBadge';
import { autoWidth } from '../../shared/table-width';

interface ReceiptValues {
  customerId: string;
  repairType: string;
  orderItemId?: string;
  componentId?: string;
  requestDate: Dayjs;
  dueDate?: Dayjs;
  description: string;
  notes?: string;
  /** 접수·출고 방식 (개발설계서 05 G-07) */
  receiptMethod?: RepairReceiptMethod;
  releaseMethod?: RepairReleaseMethod;
  pickupAddress?: string;
  deliveryAddress?: string;
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
      fetchCustomers({ q: customerKeyword || undefined, scope: 'ALL', size: 20 }),
  });

  const receiptCustomerId = Form.useWatch('customerId', receiptForm);
  const receiptType = Form.useWatch('repairType', receiptForm);
  const linkKind = repairLinkKind(receiptType ?? 'AFTER_SALE');

  const linkTargetsQuery = useQuery({
    queryKey: ['repairs', 'link-targets', receiptCustomerId],
    queryFn: () => fetchRepairLinkTargets(receiptCustomerId as string),
    enabled: receiptOpen && !!receiptCustomerId,
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
        notes: v.notes,
        receiptMethod: v.receiptMethod,
        releaseMethod: v.releaseMethod,
        pickupAddress: v.pickupAddress,
        deliveryAddress: v.deliveryAddress,
        orderItemId: v.componentId ? undefined : v.orderItemId,
        componentId: v.componentId,
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

  const openStatusChange = (repair: Repair, toStatus: RepairStatus) => {
    noteForm.resetFields();
    setStatusTarget({ repair, toStatus });
  };

  const columns: ColumnsType<Repair> = [
    {
      title: '고객',
      dataIndex: 'customerName',
      ...autoWidth(140),
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
      ...autoWidth(),
      render: (t: string) => <Tag>{repairTypeLabel(t)}</Tag>,
    },
    {
      title: '대상',
      dataIndex: 'targetLabel',
      ...autoWidth(140),
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
    { title: '접수일', dataIndex: 'requestDate', ...autoWidth() },
    {
      title: '완료 예정일',
      dataIndex: 'dueDate',
      ...autoWidth(),
      render: (d: string | undefined, r) => (
        <Space size={4}>
          {d ?? '-'}
          {d && d < dayjs().format('YYYY-MM-DD') && !['RELEASED', 'CANCELLED'].includes(r.status) && (
            <Tag color="red">지연</Tag>
          )}
        </Space>
      ),
    },
    {
      title: '상태',
      dataIndex: 'status',
      ...autoWidth(),
      align: 'center',
      render: (s: string) => {
        const meta = repairStatusMeta(s);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
  ];

  const isCancel = statusTarget?.toStatus === 'CANCELLED';

  return (
    <PageShell>
      <PageCard>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <ListToolbar
          filters={
            <>
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
                style={{ width: LAYOUT.filterWidth }}
                value={statusFilter}
                onChange={(v: string | undefined) => {
                  setStatusFilter(v);
                  setPage(1);
                }}
                options={STATUS_FILTER_OPTIONS}
              />
            </>
          }
          actions={
            <Can permission="REPAIR_EDIT">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setReceiptOpen(true)}>
                수선 접수
              </Button>
            </Can>
          }
        />

        <Alert
          type="info"
          showIcon
          message={
            <Typography.Text strong>
              진행 순서: 접수 → 수선 요청 → 수선 중 → 수선 입고 → 고객 연락 → 출고 완료
            </Typography.Text>
          }
          description="다음 단계로만 이동할 수 있고, 취소는 어느 단계에서든 가능합니다. 행을 누르면 상세가 펼쳐지며 상태 변경도 그곳에서 진행합니다."
        />

        <DataTable<Repair>
          rowKey="id"
          loading={listQuery.isLoading}
          dataSource={listQuery.data?.data ?? []}
          columns={columns}
          onRow={(r) => ({
            onClick: () => setExpandedId((cur) => (cur === r.id ? null : r.id)),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: page,
            pageSize: size,
            total: listQuery.data?.page.totalElements ?? 0,
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showTotal: (total) => `총 ${total}건`,
            onChange: (nextPage, nextSize) => {
              setPage(nextSize !== size ? 1 : nextPage);
              setSize(nextSize);
            },
          }}
          expandable={{
            showExpandColumn: false,
            expandedRowKeys: expandedId ? [expandedId] : [],
            expandedRowRender: (r) => {
              const detail = detailQuery.data?.id === r.id ? detailQuery.data : undefined;
              const events = detail?.events ?? r.events;
              // 단계별 완료(전이) 이벤트를 상태 코드로 매핑 — 가장 이른 전이만 남긴다.
              const eventByStatus = new Map<string, RepairEvent>();
              for (const ev of events) {
                if (!eventByStatus.has(ev.newStatus)) eventByStatus.set(ev.newStatus, ev);
              }
              const cancelled = r.status === 'CANCELLED';
              const cancelEvent = eventByStatus.get('CANCELLED');
              const currentIndex = REPAIR_STATUS_FLOW.indexOf(r.status as RepairStatus);

              const stepItems = REPAIR_STATUS_FLOW.map((status) => {
                const ev = eventByStatus.get(status);
                return {
                  title: repairStatusMeta(status).label,
                  description: ev ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {ev.eventDate}
                      <br />
                      {ev.actorName}
                    </Typography.Text>
                  ) : undefined,
                };
              });

              const next = nextRepairStatus(r.status);
              const closed = cancelled || r.status === 'RELEASED';
              const pending =
                statusMutation.isPending && statusMutation.variables?.repair.id === r.id;

              return (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  {detailQuery.isLoading && !detail ? (
                    <Typography.Text type="secondary">단계 정보를 불러오는 중…</Typography.Text>
                  ) : (
                    <Steps
                      size="small"
                      labelPlacement="vertical"
                      current={cancelled ? -1 : currentIndex}
                      status={cancelled ? 'error' : r.status === 'RELEASED' ? 'finish' : 'process'}
                      items={stepItems}
                    />
                  )}
                  {cancelled && (
                    <Typography.Text type="danger">
                      취소됨{cancelEvent ? ` · ${cancelEvent.eventDate}` : ''}
                      {cancelEvent?.notes ? ` · 사유: ${cancelEvent.notes}` : ''}
                    </Typography.Text>
                  )}
                  <Typography.Text>내용: {r.description}</Typography.Text>
                  {(r.receiptMethod || r.releaseMethod) && (
                    <Typography.Text type="secondary">
                      접수·출고:{' '}
                      {[
                        r.receiptMethod && `접수 ${REPAIR_METHOD_LABELS[r.receiptMethod]}`,
                        r.releaseMethod && `출고 ${REPAIR_METHOD_LABELS[r.releaseMethod]}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      {r.pickupAddress ? ` / 수거 주소: ${r.pickupAddress}` : ''}
                      {r.deliveryAddress ? ` / 배송 주소: ${r.deliveryAddress}` : ''}
                    </Typography.Text>
                  )}
                  {r.notes && <Typography.Text type="secondary">비고: {r.notes}</Typography.Text>}
                  <Can permission="REPAIR_EDIT">
                    <Space wrap>
                      {next && (
                        <Button
                          type="primary"
                          ghost
                          icon={<SwapOutlined />}
                          loading={pending}
                          onClick={() => openStatusChange(r, next)}
                        >
                          {repairStatusMeta(r.status).label} → {repairStatusMeta(next).label} 처리
                        </Button>
                      )}
                      {!closed && (
                        <Button
                          danger
                          icon={<StopOutlined />}
                          onClick={() => openStatusChange(r, 'CANCELLED')}
                        >
                          취소
                        </Button>
                      )}
                    </Space>
                  </Can>
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
                })
              }
            />
          </Form.Item>

          <Form.Item name="repairType" label="수선 유형" rules={[{ required: true }]}>
            <Select
              options={REPAIR_TYPES.map((t) => ({ value: t, label: repairTypeLabel(t) }))}
              onChange={() =>
                receiptForm.setFieldsValue({
                  orderItemId: undefined,
                  componentId: undefined,
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
          </Space>

          <Form.Item
            name="description"
            label="수선 내용"
            rules={[{ required: true, message: '수선 내용을 입력해 주세요.' }]}
            extra={linkKind === 'NONE' ? '일반 수선은 대상 설명을 내용에 함께 적어 주세요.' : undefined}
          >
            <Input.TextArea rows={3} placeholder="예: 하의 기장 1.5cm 줄임" />
          </Form.Item>
          {/* 설계 PDF 1페이지 "수선 물품 방문" — 고객 방문인지 우리가 오가는지 구분 */}
          <Space size="large" wrap align="start">
            <Form.Item name="receiptMethod" label="접수 방식">
              <Select
                allowClear
                style={{ width: 150 }}
                placeholder="선택"
                options={REPAIR_RECEIPT_METHODS.map((v) => ({
                  value: v,
                  label: REPAIR_METHOD_LABELS[v],
                }))}
              />
            </Form.Item>
            <Form.Item name="releaseMethod" label="출고 방식">
              <Select
                allowClear
                style={{ width: 150 }}
                placeholder="선택"
                options={REPAIR_RELEASE_METHODS.map((v) => ({
                  value: v,
                  label: REPAIR_METHOD_LABELS[v],
                }))}
              />
            </Form.Item>
          </Space>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) =>
              prev.receiptMethod !== cur.receiptMethod || prev.releaseMethod !== cur.releaseMethod
            }
          >
            {({ getFieldValue }) => (
              <>
                {getFieldValue('receiptMethod') === 'PICKUP' && (
                  <Form.Item
                    name="pickupAddress"
                    label="수거 주소"
                    rules={[{ required: true, message: '수거 주소를 입력해 주세요.' }]}
                  >
                    <Input placeholder="고객 물품을 받으러 갈 주소" maxLength={300} />
                  </Form.Item>
                )}
                {getFieldValue('releaseMethod') === 'DELIVERY' && (
                  <Form.Item
                    name="deliveryAddress"
                    label="배송 주소"
                    rules={[{ required: true, message: '배송 주소를 입력해 주세요.' }]}
                  >
                    <Input placeholder="완료된 물품을 가져다줄 주소" maxLength={300} />
                  </Form.Item>
                )}
              </>
            )}
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
      </PageCard>
    </PageShell>
  );
}
