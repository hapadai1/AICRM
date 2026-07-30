import {
  MinusCircleOutlined,
  PlusOutlined,
  RollbackOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
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
  REPAIR_TARGET_PRODUCTS,
  REPAIR_TYPES,
  createRepair,
  fetchRepair,
  fetchRepairs,
  isTargetProductRequired,
  nextRepairStatus,
  prevRepairStatus,
  postRepairStatusEvent,
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
import { RepairWorkCard } from './RepairWorkCard';
import { NotificationConfirmModal } from '../../shared/NotificationConfirmModal';
import { StatusBadge } from '../../shared/StatusBadge';
import { autoWidth } from '../../shared/table-width';

interface ReceiptValues {
  customerId: string;
  repairType: string;
  /** 대상 품목·개수 (상의·하의·베스트·셔츠·구두) — 계약 등록 품목과 무관하게 고른다 */
  items?: { targetProduct?: string; quantity?: number }[];
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
  // 완료된 건은 기본적으로 숨긴다 (상태를 직접 고르면 그 선택이 우선한다).
  const [excludeReleased, setExcludeReleased] = useState(true);
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
    queryKey: ['repairs', 'list', { statusFilter, customerFilter, excludeReleased, page, size }],
    queryFn: () =>
      fetchRepairs({
        status: statusFilter,
        customerId: customerFilter,
        excludeReleased,
        page,
        size,
      }),
  });

  // 고객 검색 — 필터·접수 모달 공용 (전화번호로도 검색된다).
  // 수선은 계약 보유 고객만 대상이다 — 다른 화면(계약·실측)의 scope=ALL 검색과
  // 캐시가 섞이지 않도록 queryKey에 scope를 포함한다.
  const customerQuery = useQuery({
    queryKey: ['customers', 'search', 'CONTRACT', customerKeyword],
    queryFn: () =>
      fetchCustomers({ q: customerKeyword || undefined, scope: 'CONTRACT', size: 20 }),
  });

  const receiptType = Form.useWatch('repairType', receiptForm);
  const targetRequired = isTargetProductRequired(receiptType ?? 'AFTER_SALE');

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
        // 빈 줄(품목 미선택)은 보내지 않는다 — 일반 수선은 품목 없이도 접수된다.
        items: (v.items ?? [])
          .filter((i) => i?.targetProduct)
          .map((i) => ({ targetProduct: i.targetProduct as string, quantity: i.quantity ?? 1 })),
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

  // 대상 품목: 계약에 등록된 물품이 아니라 품목 목록에서 자유롭게 고른다.
  const targetProductOptions = REPAIR_TARGET_PRODUCTS.map((code) => ({
    value: code,
    label: REPAIR_COMPONENT_TYPE_LABELS[code] ?? code,
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

  // 되돌리기 = 목표 상태가 현재 상태보다 앞 단계(진행 확인창과 같은 모달을 공유한다)
  const isRevert =
    !!statusTarget &&
    REPAIR_STATUS_FLOW.indexOf(statusTarget.toStatus) <
      REPAIR_STATUS_FLOW.indexOf(statusTarget.repair.status as RepairStatus);

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
              <Checkbox
                checked={excludeReleased}
                onChange={(e) => {
                  setExcludeReleased(e.target.checked);
                  setPage(1);
                }}
              >
                출고완료 제외
              </Checkbox>
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
              // 단계별 이벤트를 상태 코드로 매핑 — 되돌리기로 같은 단계를 여러 번 거치면
              // 가장 최근 전이를 남긴다(그 단계의 최신 날짜·담당자·사유가 보이도록).
              // events는 백엔드에서 시간순(오름차순)으로 오므로 그냥 덮어쓰면 최신이 남는다.
              const eventByStatus = new Map<string, RepairEvent>();
              for (const ev of events) {
                eventByStatus.set(ev.newStatus, ev);
              }
              const cancelled = r.status === 'CANCELLED';
              const cancelEvent = eventByStatus.get('CANCELLED');
              // 현재 상태 = 그 단계를 "끝낸" 상태다(접수 등록 = 접수 완료). 그래서 진행중 표시는
              // 다음 단계로 한 칸 민다 — 출고 완료면 flow 길이가 되어 전 단계가 완료로 찍힌다.
              const currentIndex = REPAIR_STATUS_FLOW.indexOf(r.status as RepairStatus) + 1;

              const stepItems = REPAIR_STATUS_FLOW.map((status) => {
                const ev = eventByStatus.get(status);
                return {
                  title: repairStatusMeta(status).label,
                  description: ev ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {ev.eventDate} · {ev.actorName}
                      {ev.notes ? ` · 비고: ${ev.notes}` : ''}
                    </Typography.Text>
                  ) : undefined,
                };
              });

              const next = nextRepairStatus(r.status);
              // 취소된 건은 되돌릴 수 없고, 접수(첫 단계)는 이전 단계가 없다.
              const prev = cancelled ? undefined : prevRepairStatus(r.status);
              const pending =
                statusMutation.isPending && statusMutation.variables?.repair.id === r.id;

              return (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  {detailQuery.isLoading && !detail ? (
                    <Typography.Text type="secondary">단계 정보를 불러오는 중…</Typography.Text>
                  ) : (
                    <Steps
                      size="small"
                      direction="vertical"
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
                      {prev && (
                        <Button
                          icon={<RollbackOutlined />}
                          loading={pending}
                          onClick={() => openStatusChange(r, prev)}
                        >
                          이전 단계로 ({repairStatusMeta(prev).label})
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
      </PageCard>

      {/* 고객별 업무 처리 — 상태 관리 목록 아래에 붙는다(설계 PDF 2페이지 수선 업무 흐름). */}
      <RepairWorkCard
        customerOptions={customerOptions}
        customerLoading={customerQuery.isLoading}
        onCustomerSearch={setCustomerKeyword}
        onWork={openStatusChange}
        pendingRepairId={statusMutation.isPending ? statusMutation.variables?.repair.id : undefined}
      />

      {/* 수선 접수 모달 — 고객·대상 품목·수선 내용을 받는다. */}
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
          // 접수·출고 방식은 고객 방문이 대부분이라 기본값으로 채운다(방문 수거·배송만 바꿔 고른다).
          initialValues={{
            repairType: 'AFTER_SALE',
            requestDate: dayjs(),
            receiptMethod: 'VISIT',
            releaseMethod: 'VISIT',
          }}
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
            />
          </Form.Item>

          <Form.Item name="repairType" label="수선 유형" rules={[{ required: true }]}>
            <Select options={REPAIR_TYPES.map((t) => ({ value: t, label: repairTypeLabel(t) }))} />
          </Form.Item>

          {/* 계약에 등록된 물품을 찾아 연결하지 않는다 — 품목과 개수를 줄 단위로 적는다. */}
          <Form.List name="items" initialValue={[{ quantity: 1 }]}>
            {(fields, { add, remove }) => (
              <Form.Item
                label="대상 품목"
                required={targetRequired}
                extra={targetRequired ? undefined : '일반 수선은 품목 없이도 접수할 수 있습니다.'}
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {fields.map((field, index) => (
                    <Space key={field.key} size={8} align="start">
                      <Form.Item
                        name={[field.name, 'targetProduct']}
                        noStyle
                        rules={
                          // 첫 줄만 필수 — 나머지는 비워 두면 접수 시 버린다.
                          targetRequired && index === 0
                            ? [{ required: true, message: '대상 품목을 선택해 주세요.' }]
                            : []
                        }
                      >
                        <Select
                          allowClear
                          style={{ width: 200 }}
                          placeholder="품목 선택"
                          options={targetProductOptions}
                        />
                      </Form.Item>
                      <Form.Item name={[field.name, 'quantity']} noStyle initialValue={1}>
                        <InputNumber min={1} max={99} style={{ width: 90 }} addonAfter="개" />
                      </Form.Item>
                      {fields.length > 1 && (
                        <Button
                          type="text"
                          icon={<MinusCircleOutlined />}
                          onClick={() => remove(field.name)}
                          aria-label="품목 삭제"
                        />
                      )}
                    </Space>
                  ))}
                  <Button
                    type="dashed"
                    icon={<PlusOutlined />}
                    onClick={() => add({ quantity: 1 })}
                    style={{ width: 300 }}
                  >
                    품목 추가
                  </Button>
                </Space>
              </Form.Item>
            )}
          </Form.List>

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
            extra={!targetRequired ? '일반 수선은 대상 설명을 내용에 함께 적어 주세요.' : undefined}
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

      {/* 상태 변경 확인 — 진행/되돌리기 공용, 사유는 선택 */}
      <Modal
        title={
          statusTarget
            ? `${repairStatusMeta(statusTarget.repair.status).label} → ${repairStatusMeta(statusTarget.toStatus).label}`
            : '상태 변경'
        }
        open={!!statusTarget}
        onCancel={() => setStatusTarget(null)}
        onOk={() => noteForm.submit()}
        okText={isRevert ? '되돌리기' : '변경'}
        cancelText="닫기"
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
            label={isRevert ? '되돌리기 사유' : '메모 (선택)'}
            rules={isRevert ? [{ required: true, message: '되돌리기 사유를 입력해 주세요.' }] : []}
          >
            <Input.TextArea
              rows={2}
              placeholder={isRevert ? '되돌리기 사유 (필수)' : '상태 변경 메모'}
            />
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
    </PageShell>
  );
}
