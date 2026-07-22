import {
  DownloadOutlined,
  ExperimentOutlined,
  SendOutlined,
  SwapOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  COMPONENT_TYPE_LABELS,
  PRODUCTION_STATUS_META,
  backwardTransitions,
  fetchProductionItems,
  forwardTransitions,
  isBackwardTransition,
  postComponentStatusEvent,
  postItemProductionEvent,
  receiveComponent,
  releaseComponent,
  type ComponentStatus,
  type ProductionComponent,
  type ProductionItem,
} from '../../api/production';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { labelOf, metaOf } from '../../shared/status-meta';
import { FittingModal } from './FittingModal';

function statusBadge(code: string) {
  const meta = metaOf(PRODUCTION_STATUS_META, code);
  return <StatusBadge label={meta.label} color={meta.color} />;
}

function statusLabel(code: string) {
  return metaOf(PRODUCTION_STATUS_META, code).label;
}

function componentLabel(code: string) {
  return labelOf(COMPONENT_TYPE_LABELS, code);
}

interface StatusChangeState {
  component: ProductionComponent;
}

interface InOutState {
  component: ProductionComponent;
  mode: 'receive' | 'release';
}

/** PROD-001 제작·구성품 상태: 맞춤 품목·구성품 제작/입고/출고 관리 */
export function ProductionPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();

  const itemsQuery = useQuery({ queryKey: ['production', 'items'], queryFn: fetchProductionItems });

  // 진행 단계 카드 등에서 특정 주문으로 걸러 들어올 수 있게 한다 (?q=ORD-...).
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = searchParams.get('q') ?? '';
  const filteredItems = useMemo(() => {
    const items = itemsQuery.data ?? [];
    const q = keyword.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) =>
      [r.customerName, r.orderNo, r.displayName].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [itemsQuery.data, keyword]);

  const [statusTarget, setStatusTarget] = useState<StatusChangeState | null>(null);
  const [inOutTarget, setInOutTarget] = useState<InOutState | null>(null);
  const [fittingTarget, setFittingTarget] = useState<ProductionItem | null>(null);

  const [statusForm] = Form.useForm<{ toStatus: ComponentStatus; reason?: string }>();
  const [inOutForm] = Form.useForm<{ date: Dayjs }>();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['production'] });

  const statusMutation = useMutation({
    mutationFn: (v: { componentId: string; toStatus: ComponentStatus; reason?: string }) =>
      postComponentStatusEvent(v.componentId, { toStatus: v.toStatus, reason: v.reason }),
    onSuccess: () => {
      message.success('구성품 상태가 변경되었습니다.');
      setStatusTarget(null);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '상태 변경에 실패했습니다.'),
  });

  const inOutMutation = useMutation({
    mutationFn: (v: { componentId: string; mode: 'receive' | 'release'; date: string }) =>
      v.mode === 'receive'
        ? receiveComponent(v.componentId, { receivedDate: v.date })
        : releaseComponent(v.componentId, { releasedDate: v.date }),
    onSuccess: (_data, v) => {
      message.success(v.mode === 'receive' ? '입고 처리되었습니다.' : '출고 처리되었습니다.');
      setInOutTarget(null);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '입출고 처리에 실패했습니다.'),
  });

  const requestMutation = useMutation({
    mutationFn: (orderItemId: string) =>
      postItemProductionEvent(orderItemId, { toStatus: 'PRODUCTION_REQUESTED' }),
    onSuccess: () => {
      message.success('제작 요청 상태로 변경되었습니다.');
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '제작 요청에 실패했습니다.'),
  });

  const handleProductionRequest = (item: ProductionItem) => {
    // 작업지시서 출력 이력은 목록 API에 없어(docs/dev/08 §4) 항상 확인 후 진행한다.
    modal.confirm({
      title: '제작 요청',
      content:
        '작업지시서 출력 여부는 이 목록에서 확인할 수 없습니다. 작업지시서를 확인한 뒤 제작 요청을 진행하시겠습니까?',
      okText: '진행',
      cancelText: '취소',
      onOk: () => requestMutation.mutate(item.orderItemId),
    });
  };

  const openStatusModal = (component: ProductionComponent) => {
    statusForm.resetFields();
    setStatusTarget({ component });
  };

  const openInOutModal = (component: ProductionComponent, mode: 'receive' | 'release') => {
    inOutForm.setFieldsValue({ date: dayjs() });
    setInOutTarget({ component, mode });
  };

  const statusOptions = useMemo(() => {
    if (!statusTarget) return [];
    const from = statusTarget.component.status;
    // 미등록 상태 코드(RESERVED 등)가 와도 죽지 않도록 조회는 항상 헬퍼를 쓴다.
    const forward = forwardTransitions(from);
    const backward = backwardTransitions(from);
    return [
      ...forward.map((s) => ({ value: s, label: `${statusLabel(s)} (정방향)` })),
      ...backward.map((s) => ({ value: s, label: `${statusLabel(s)} (역행 — 사유 필수)` })),
    ];
  }, [statusTarget]);

  const selectedToStatus = Form.useWatch('toStatus', statusForm);
  const needsReason =
    !!statusTarget && !!selectedToStatus && isBackwardTransition(statusTarget.component.status, selectedToStatus);

  const componentColumns: ColumnsType<ProductionComponent> = [
    {
      title: '구성품',
      key: 'componentType',
      render: (_, c) => `${componentLabel(c.componentType)} #${c.sequenceNo}`,
      width: 140,
    },
    { title: '현재 상태', dataIndex: 'status', render: (s: string) => statusBadge(s), width: 140 },
    { title: '입고 예정일', dataIndex: 'expectedInboundDate', render: (d?: string) => d ?? '-', width: 120 },
    { title: '실입고', dataIndex: 'actualInboundAt', render: (d?: string) => d ?? '-', width: 120 },
    { title: '출고', dataIndex: 'actualOutboundAt', render: (d?: string) => d ?? '-', width: 120 },
    {
      title: '액션',
      key: 'actions',
      render: (_, c) => (
        <Can permission="PRODUCTION_EDIT">
          <Space size="small" wrap>
            <Button size="small" icon={<SwapOutlined />} onClick={() => openStatusModal(c)}>
              상태 변경
            </Button>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              disabled={c.status === 'RECEIVED' || c.status === 'RELEASED' || c.status === 'CANCELLED'}
              onClick={() => openInOutModal(c, 'receive')}
            >
              입고
            </Button>
            <Button
              size="small"
              icon={<UploadOutlined />}
              disabled={c.status !== 'RECEIVED'}
              onClick={() => openInOutModal(c, 'release')}
            >
              출고
            </Button>
          </Space>
        </Can>
      ),
    },
  ];

  const itemColumns: ColumnsType<ProductionItem> = [
    {
      title: '고객 / 주문',
      key: 'customer',
      render: (_, r) => (
        <>
          <Typography.Text strong>{r.customerName}</Typography.Text>
          <br />
          <Typography.Text type="secondary">{r.orderNo}</Typography.Text>
        </>
      ),
      width: 180,
    },
    { title: '품목', dataIndex: 'displayName', width: 140 },
    {
      title: '품목 집계 상태',
      dataIndex: 'itemStatus',
      render: (s: string) => statusBadge(s),
      width: 160,
    },
    {
      // 작업지시서 출력 이력은 목록 API가 제공하지 않는다 (docs/dev/08 §4).
      title: '작업지시서',
      key: 'workOrder',
      render: () => <Typography.Text type="secondary">-</Typography.Text>,
      width: 130,
    },
    {
      title: '구성품 진행',
      key: 'componentSummary',
      render: (_, r) => (
        <Space size={4} wrap>
          {r.components.map((c) => (
            <Tag key={c.id}>
              {componentLabel(c.componentType)}: {statusLabel(c.status)}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '액션',
      key: 'actions',
      width: 230,
      render: (_, r) => (
        <Space size="small" wrap>
          <Can permission="PRODUCTION_EDIT">
            <Button
              size="small"
              type="primary"
              ghost
              icon={<SendOutlined />}
              disabled={r.itemStatus !== 'READY_TO_ORDER' && r.itemStatus !== 'CREATED'}
              loading={requestMutation.isPending && requestMutation.variables === r.orderItemId}
              onClick={() => handleProductionRequest(r)}
            >
              제작 요청
            </Button>
          </Can>
          <Can permission="FITTING_EDIT">
            <Button size="small" icon={<ExperimentOutlined />} onClick={() => setFittingTarget(r)}>
              가봉 기록
            </Button>
          </Can>
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          제작·구성품 상태 (PROD-001)
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="구성품별 입고·출고를 처리하면 품목 상태(부분 입고·부분 출고 등)가 자동 집계됩니다. 상태 역행은 사유 입력이 필수입니다."
        />
        <Input.Search
          allowClear
          style={{ maxWidth: 320 }}
          placeholder="고객명 · 주문번호 · 품목 검색"
          defaultValue={keyword}
          onSearch={(v) => {
            const next = new URLSearchParams(searchParams);
            if (v.trim()) next.set('q', v.trim());
            else next.delete('q');
            setSearchParams(next, { replace: true });
          }}
        />
        <Table<ProductionItem>
          rowKey={(r) => r.orderItemId}
          scroll={{ x: 'max-content' }}
          size="middle"
          loading={itemsQuery.isLoading}
          dataSource={filteredItems}
          columns={itemColumns}
          pagination={false}
          expandable={{
            // 구성품 상태 이력은 목록 API에 포함되지 않아 표시하지 않는다 (docs/dev/08 §4).
            expandedRowRender: (item) => (
              <Table<ProductionComponent>
                rowKey="id"
                scroll={{ x: 'max-content' }}
                size="small"
                dataSource={item.components}
                columns={componentColumns}
                pagination={false}
              />
            ),
          }}
        />
      </Space>

      {/* 구성품 상태 변경 모달 */}
      <Modal
        title={
          statusTarget
            ? `상태 변경 — ${componentLabel(statusTarget.component.componentType)} (현재: ${statusLabel(statusTarget.component.status)})`
            : '상태 변경'
        }
        open={!!statusTarget}
        onCancel={() => setStatusTarget(null)}
        onOk={() => statusForm.submit()}
        okText="변경"
        cancelText="취소"
        confirmLoading={statusMutation.isPending}
        destroyOnClose
      >
        <Form
          form={statusForm}
          layout="vertical"
          onFinish={(values) => {
            if (!statusTarget) return;
            statusMutation.mutate({
              componentId: statusTarget.component.id,
              toStatus: values.toStatus,
              reason: values.reason,
            });
          }}
        >
          <Form.Item
            name="toStatus"
            label="변경할 상태 (허용 전이만 표시)"
            rules={[{ required: true, message: '변경할 상태를 선택해 주세요.' }]}
          >
            <Select placeholder="상태 선택" options={statusOptions} />
          </Form.Item>
          {needsReason && (
            <Form.Item
              name="reason"
              label="역행 사유"
              rules={[{ required: true, message: '상태 역행 사유를 입력해 주세요.' }]}
            >
              <Input.TextArea rows={2} placeholder="역행 사유 (필수)" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 입고/출고 모달 */}
      <Modal
        title={inOutTarget?.mode === 'receive' ? '구성품 입고 처리' : '구성품 출고 처리'}
        open={!!inOutTarget}
        onCancel={() => setInOutTarget(null)}
        onOk={() => inOutForm.submit()}
        okText={inOutTarget?.mode === 'receive' ? '입고' : '출고'}
        cancelText="취소"
        confirmLoading={inOutMutation.isPending}
        destroyOnClose
      >
        <Form
          form={inOutForm}
          layout="vertical"
          onFinish={(values: { date: Dayjs }) => {
            if (!inOutTarget) return;
            inOutMutation.mutate({
              componentId: inOutTarget.component.id,
              mode: inOutTarget.mode,
              date: values.date.format('YYYY-MM-DD'),
            });
          }}
        >
          <Form.Item
            name="date"
            label={inOutTarget?.mode === 'receive' ? '실제 입고일' : '고객 출고일'}
            rules={[{ required: true, message: '일자를 선택해 주세요.' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {fittingTarget && (
        <FittingModal item={fittingTarget} open onClose={() => setFittingTarget(null)} />
      )}
    </Card>
  );
}
