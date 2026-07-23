/** 계약 1:1 제작 관리 코크핏 — 계약의 전 품목을 한 화면에서: 작업지시서 출력·제작요청·구성품 입출고·가봉, 전체 입고 시 고객 연락 */
import {
  ArrowLeftOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  FileExcelOutlined,
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
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { fetchContract } from '../../api/contracts';
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
  type ProductionNotificationSuggestion,
} from '../../api/production';
import { BackButton } from '../../shared/BackButton';
import { Can } from '../../shared/Can';
import { NotificationConfirmModal } from '../../shared/NotificationConfirmModal';
import { StatusBadge } from '../../shared/StatusBadge';
import { labelOf, metaOf } from '../../shared/status-meta';
import { WORK_ORDER_STATUS_META } from '../workorders/wo-meta';
import { FittingModal } from './FittingModal';

function statusBadge(code: string) {
  const meta = metaOf(PRODUCTION_STATUS_META, code);
  return <StatusBadge label={meta.label} color={meta.color} />;
}
function workOrderBadge(code: string) {
  const meta = metaOf(WORK_ORDER_STATUS_META, code);
  return <StatusBadge label={meta.label} color={meta.color} />;
}
function statusLabel(code: string) {
  return metaOf(PRODUCTION_STATUS_META, code).label;
}
function componentLabel(code: string) {
  return labelOf(COMPONENT_TYPE_LABELS, code);
}

interface InOutState {
  component: ProductionComponent;
  mode: 'receive' | 'release';
}

export function ContractProductionPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const { data: contract } = useQuery({
    queryKey: ['contracts', id],
    queryFn: () => fetchContract(id),
    enabled: !!id,
  });

  const itemsQuery = useQuery({
    queryKey: ['production', 'items', id],
    queryFn: () => fetchProductionItems(id),
    enabled: !!id,
  });

  const [statusTarget, setStatusTarget] = useState<{ component: ProductionComponent } | null>(null);
  const [inOutTarget, setInOutTarget] = useState<InOutState | null>(null);
  const [fittingTarget, setFittingTarget] = useState<ProductionItem | null>(null);
  const [suggestion, setSuggestion] = useState<ProductionNotificationSuggestion | null>(null);

  const [statusForm] = Form.useForm<{ toStatus: ComponentStatus; reason?: string }>();
  const [inOutForm] = Form.useForm<{ date: Dayjs }>();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['production'] });

  const statusMutation = useMutation({
    mutationFn: (v: { componentId: string; toStatus: ComponentStatus; reason?: string }) =>
      postComponentStatusEvent(v.componentId, { toStatus: v.toStatus, reason: v.reason }),
    onSuccess: (result) => {
      message.success('구성품 상태가 변경되었습니다.');
      setStatusTarget(null);
      if (result.suggestedNotification) setSuggestion(result.suggestedNotification);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '상태 변경에 실패했습니다.'),
  });

  const inOutMutation = useMutation({
    mutationFn: (v: { componentId: string; mode: 'receive' | 'release'; date: string }) =>
      v.mode === 'receive'
        ? receiveComponent(v.componentId, { receivedDate: v.date })
        : releaseComponent(v.componentId, { releasedDate: v.date }),
    onSuccess: (result, v) => {
      message.success(v.mode === 'receive' ? '입고 처리되었습니다.' : '출고 처리되었습니다.');
      setInOutTarget(null);
      if (result.suggestedNotification) setSuggestion(result.suggestedNotification);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '입출고 처리에 실패했습니다.'),
  });

  // 제작요청은 작업지시서 출력과 커플링하지 않는다 — 담당자가 누르면 바로 완료 처리하는 독립 버튼.
  const requestMutation = useMutation({
    mutationFn: (orderItemId: string) =>
      postItemProductionEvent(orderItemId, { toStatus: 'PRODUCTION_REQUESTED' }),
    onSuccess: () => {
      message.success('제작요청 완료 처리되었습니다.');
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '제작요청 처리에 실패했습니다.'),
  });

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
    const forward = forwardTransitions(from);
    const backward = backwardTransitions(from);
    return [
      ...forward.map((s) => ({ value: s, label: `${statusLabel(s)} (정방향)` })),
      ...backward.map((s) => ({ value: s, label: `${statusLabel(s)} (역행 — 사유 필수)` })),
    ];
  }, [statusTarget]);

  const selectedToStatus = Form.useWatch('toStatus', statusForm);
  const needsReason =
    !!statusTarget &&
    !!selectedToStatus &&
    isBackwardTransition(statusTarget.component.status, selectedToStatus);

  const componentColumns: ColumnsType<ProductionComponent> = [
    {
      title: '구성품',
      key: 'componentType',
      render: (_, c) => `${componentLabel(c.componentType)} #${c.sequenceNo}`,
      width: 140,
    },
    { title: '현재 상태', dataIndex: 'status', render: (s: string) => statusBadge(s), width: 130 },
    { title: '입고 예정일', dataIndex: 'expectedInboundDate', render: (d?: string) => d ?? '-', width: 110 },
    { title: '실입고', dataIndex: 'actualInboundAt', render: (d?: string) => d ?? '-', width: 110 },
    { title: '출고', dataIndex: 'actualOutboundAt', render: (d?: string) => d ?? '-', width: 110 },
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
    { title: '품목', dataIndex: 'displayName', width: 160 },
    { title: '주문', dataIndex: 'orderNo', width: 150 },
    {
      title: '작업지시서',
      key: 'workOrder',
      width: 200,
      render: (_, r) => {
        const wo = r.workOrder;
        return (
          <Space direction="vertical" size={4}>
            <Space size={6}>
              {workOrderBadge(wo.status)}
              {wo.currentVersionNo ? (
                <Typography.Text type="secondary">V{wo.currentVersionNo}</Typography.Text>
              ) : null}
            </Space>
            <Tooltip title={wo.canIssue ? '' : '옵션 확정과 채촌 완료 후 출력할 수 있습니다.'}>
              <Button
                size="small"
                icon={<FileExcelOutlined />}
                disabled={!wo.canIssue}
                onClick={() => navigate(`/work-orders/${r.orderItemId}`)}
              >
                {wo.currentVersionNo ? '재출력' : '출력'}
              </Button>
            </Tooltip>
          </Space>
        );
      },
    },
    { title: '품목 집계 상태', dataIndex: 'itemStatus', render: (s: string) => statusBadge(s), width: 150 },
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
              onClick={() => requestMutation.mutate(r.orderItemId)}
            >
              제작요청 완료
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

  if (itemsQuery.error) {
    return (
      <Alert
        type="error"
        showIcon
        message="제작·입출고 목록을 불러오지 못했습니다."
        description={(itemsQuery.error as Error).message}
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/contracts/${id}`)}>
          계약으로
        </Button>
      </Space>

      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={4} style={{ marginBottom: 4 }}>
              제작 관리 — {contract?.customerName ?? ''}
            </Typography.Title>
            <Typography.Text type="secondary">
              {[contract?.customerPhone, contract?.contractNo].filter(Boolean).join(' · ')}
            </Typography.Text>
          </div>
          <Table<ProductionItem>
            rowKey={(r) => r.orderItemId}
            scroll={{ x: 'max-content' }}
            size="middle"
            loading={itemsQuery.isLoading}
            dataSource={itemsQuery.data ?? []}
            columns={itemColumns}
            pagination={false}
            locale={{ emptyText: '이 계약에는 제작 대상 품목이 없습니다.' }}
            expandable={{
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
      </Card>

      {/* 계약 상세 등 여러 경로로 들어오므로 뒤로가기로 통일 */}
      <BackButton />

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

      <NotificationConfirmModal
        open={suggestion != null}
        title="완성복이 전체 입고되었습니다"
        suggestion={suggestion}
        onDone={() => setSuggestion(null)}
        onCancel={() => setSuggestion(null)}
      />
    </Space>
  );
}
