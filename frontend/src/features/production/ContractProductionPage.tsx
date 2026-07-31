/**
 * 계약 1:1 제작 관리 코크핏 — 계약의 전 품목을 한 화면에서: 작업지시서 출력·제작요청·구성품 입출고·가봉
 *
 * 구성품은 펼치기(+) 없이 처음부터 모두 행으로 낸다(스타일 컨설팅 화면과 동일한 방식).
 * 한 행 = 품목 × 구성품 하나이고, 품목 단위 칸(품목·작업지시서·품목 액션)은 첫 행에 rowSpan으로 붙인다.
 *
 * 열 순서는 설계서 11 §4.2의 "좌 → 우 라이프사이클"을 따른다.
 * 품목 단위 칸(품목 → 작업지시서 → 품목 액션)을 먼저 묶고, 그 뒤에 구성품 단위 칸을 둔다 —
 * rowSpan으로 합쳐지는 칸이 흩어지면 표가 읽히지 않기 때문이다.
 *
 * 완성복 입고 고객 연락은 여기서 띄우지 않는다(설계서 v2 02 §8 D7 일원화 — 진행 카드로 단일화).
 */
import {
  CheckOutlined,
  DownloadOutlined,
  EllipsisOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileExcelOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Dropdown,
  Form,
  Input,
  Modal,
  Space,
  Table,
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
  productionRequestBlockReason,
  fetchProductionItems,
  postComponentStatusEvent,
  postItemProductionEvent,
  receiveComponent,
  releaseComponent,
  type ComponentStatus,
  type ProductionComponent,
  type ProductionItem,
} from '../../api/production';
import { downloadWorkOrderVersionFile } from '../../api/workorders';
import { BackButton } from '../../shared/BackButton';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { labelOf, metaOf } from '../../shared/status-meta';
import { WorkOrderFormPreviewModal } from '../workorders/WorkOrderFormPreviewModal';
import { WORK_ORDER_STATUS_META } from '../workorders/wo-meta';
import { ComponentProgress } from './ComponentProgress';
import { exceptionActions, nextActions, type ComponentAction } from './component-flow';
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

/** ⋯ 예외 경로 — 갈 상태는 이미 정해졌고 사유만 받는다 */
interface ExceptionState {
  component: ProductionComponent;
  toStatus: ComponentStatus;
  /** 역행이면 사유 필수 (백엔드 validateTransition) */
  backward: boolean;
  label: string;
}

/** 목록의 한 행 = 품목 × 구성품 하나. 구성품이 없는 품목도 한 행으로 남긴다. */
interface ProductionRow {
  key: string;
  item: ProductionItem;
  component: ProductionComponent | null;
  /** 품목 셀 rowSpan — 그 품목의 첫 행만 구성품 수, 나머지는 0 */
  itemRowSpan: number;
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

  const [exceptionTarget, setExceptionTarget] = useState<ExceptionState | null>(null);
  const [inOutTarget, setInOutTarget] = useState<InOutState | null>(null);
  const [fittingTarget, setFittingTarget] = useState<ProductionItem | null>(null);
  /** 양식 미리보기 대상 품목 (출력 전 확인 — 버전이 생기지 않는다) */
  const [formPreviewItemId, setFormPreviewItemId] = useState<string | null>(null);

  const [reasonForm] = Form.useForm<{ reason?: string }>();
  const [inOutForm] = Form.useForm<{ date: Dayjs }>();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['production'] });

  /** 최신 작업지시서 Excel 내려받기 — 저장된 파일을 그대로 주므로 새 버전이 생기지 않는다. */
  const downloadMutation = useMutation({
    mutationFn: (v: { versionId: string; fileName: string }) =>
      downloadWorkOrderVersionFile(v.versionId, v.fileName),
    onError: (e) =>
      message.error(e instanceof ApiError ? e.message : '작업지시서 파일을 내려받지 못했습니다.'),
  });

  const statusMutation = useMutation({
    mutationFn: (v: { componentId: string; toStatus: ComponentStatus; reason?: string }) =>
      postComponentStatusEvent(v.componentId, { toStatus: v.toStatus, reason: v.reason }),
    onSuccess: (_result, v) => {
      message.success(`${statusLabel(v.toStatus)} 상태로 변경되었습니다.`);
      setExceptionTarget(null);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.'),
  });

  const inOutMutation = useMutation({
    mutationFn: (v: { componentId: string; mode: 'receive' | 'release'; date: string }) =>
      v.mode === 'receive'
        ? receiveComponent(v.componentId, { receivedDate: v.date })
        : releaseComponent(v.componentId, { releasedDate: v.date }),
    onSuccess: (_result, v) => {
      message.success(v.mode === 'receive' ? '입고 처리되었습니다.' : '출고 처리되었습니다.');
      setInOutTarget(null);
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

  const openInOutModal = (component: ProductionComponent, mode: 'receive' | 'release') => {
    inOutForm.setFieldsValue({ date: dayjs() });
    setInOutTarget({ component, mode });
  };

  /**
   * 다음 단계 버튼 — 담당자가 작업을 끝내고 한 번 누르면 그대로 완료된다(확인창 없음).
   * 입고·출고만 일자를 남겨야 하므로 날짜 모달을 거친다.
   */
  const runAction = (component: ProductionComponent, action: ComponentAction) => {
    if (action.mode) {
      openInOutModal(component, action.mode);
      return;
    }
    statusMutation.mutate({ componentId: component.id, toStatus: action.toStatus });
  };

  // 품목마다 구성품 행으로 펼친다 — 접힘 없이 전 구성품이 처음부터 보인다.
  const rows: ProductionRow[] = useMemo(() => {
    const out: ProductionRow[] = [];
    for (const item of itemsQuery.data ?? []) {
      // 구성품이 아직 없는 품목도 목록에서 사라지면 안 된다 — 구성품 없는 한 행으로 둔다.
      if (item.components.length === 0) {
        out.push({ key: `${item.orderItemId}:none`, item, component: null, itemRowSpan: 1 });
        continue;
      }
      item.components.forEach((c, i) => {
        out.push({
          key: c.id,
          item,
          component: c,
          itemRowSpan: i === 0 ? item.components.length : 0,
        });
      });
    }
    return out;
  }, [itemsQuery.data]);

  const spanCell = (row: ProductionRow) => ({ rowSpan: row.itemRowSpan });

  const columns: ColumnsType<ProductionRow> = [
    {
      title: '품목',
      key: 'item',
      width: 180,
      onCell: spanCell,
      render: (_, { item }) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong style={{ fontSize: 15 }}>
            {item.displayName}
          </Typography.Text>
          <Typography.Text type="secondary">{item.orderNo}</Typography.Text>
          {statusBadge(item.itemStatus)}
        </Space>
      ),
    },
    {
      // 작업지시서는 품목 단위다 — 품목 첫 행에 rowSpan으로 한 번만 붙인다.
      title: '작업지시서',
      key: 'workOrder',
      width: 184,
      onCell: spanCell,
      render: (_, { item: r }) => {
        const wo = r.workOrder;
        return (
          <Space direction="vertical" size={4}>
            <Space size={6}>
              {workOrderBadge(wo.status)}
              {wo.currentVersionNo ? (
                <Typography.Text type="secondary">V{wo.currentVersionNo}</Typography.Text>
              ) : null}
            </Space>
            <Space size={6}>
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
              {/* 출력 전 양식 확인 — 버전·파일이 생기지 않는다. */}
              <Tooltip title={wo.canIssue ? '작업지시서 양식 미리보기' : '옵션 확정과 채촌 완료 후 볼 수 있습니다.'}>
                <Button
                  size="small"
                  icon={<EyeOutlined />}
                  disabled={!wo.canIssue}
                  onClick={() => setFormPreviewItemId(r.orderItemId)}
                >
                  보기
                </Button>
              </Tooltip>
              {/* 최신 출력본은 미리보기 화면을 거치지 않고 여기서 바로 받는다(버전 안 늘어남). */}
              {wo.currentVersionId && wo.currentFileName && (
                <Tooltip title={`최신 출력본 V${wo.currentVersionNo} 내려받기`}>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    loading={
                      downloadMutation.isPending &&
                      downloadMutation.variables?.versionId === wo.currentVersionId
                    }
                    onClick={() =>
                      downloadMutation.mutate({
                        versionId: wo.currentVersionId as string,
                        fileName: wo.currentFileName as string,
                      })
                    }
                  >
                    Excel
                  </Button>
                </Tooltip>
              )}
            </Space>
          </Space>
        );
      },
    },
    {
      // 제작요청·가봉도 품목 단위 — 품목 첫 행에만 낸다.
      title: '품목 액션',
      key: 'itemActions',
      width: 184,
      onCell: spanCell,
      render: (_, { item: r }) => {
        // 맞춤은 준비(옵션 확정 + 채촌 연결)가 끝나야 제작요청 가능 — 준비 미완이면 잠근다.
        // 작업지시서 출력과 "행위"를 커플링하는 게 아니라 "준비 상태"를 게이트하는 것(설계서 11 §9와 양립).
        const requestBlockReason = productionRequestBlockReason(r);
        return (
        <Space size="small" wrap>
          <Can permission="PRODUCTION_EDIT">
            <Tooltip title={requestBlockReason ?? ''}>
              <Button
                size="small"
                type="primary"
                ghost
                icon={<SendOutlined />}
                disabled={!!requestBlockReason}
                loading={requestMutation.isPending && requestMutation.variables === r.orderItemId}
                onClick={() => requestMutation.mutate(r.orderItemId)}
              >
                제작요청 완료
              </Button>
            </Tooltip>
          </Can>
          <Can permission="FITTING_EDIT">
            <Button size="small" icon={<ExperimentOutlined />} onClick={() => setFittingTarget(r)}>
              가봉 기록
            </Button>
          </Can>
        </Space>
        );
      },
    },
    {
      title: '구성품',
      key: 'componentType',
      width: 112,
      render: (_, { component: c }) =>
        c ? (
          <Typography.Text strong>
            {componentLabel(c.componentType)} #{c.sequenceNo}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">구성품 없음</Typography.Text>
        ),
    },
    {
      // 뱃지 하나가 아니라 전 단계를 깔아 둔다 — 그래야 구성품끼리 어디서 밀렸는지 세로로 비교된다.
      title: '진행',
      key: 'componentStatus',
      width: 268,
      render: (_, { component: c, item }) =>
        c ? (
          <Space direction="vertical" size={4}>
            {/* 색만으로 판단하지 않도록 현재 상태는 텍스트로도 병기한다 (구현표준 §2) */}
            {statusBadge(c.status)}
            <ComponentProgress status={c.status} transactionType={item.transactionType} />
          </Space>
        ) : (
          '-'
        ),
    },
    {
      title: '입고 예정일',
      key: 'expectedInboundDate',
      width: 96,
      render: (_, { component: c }) => c?.expectedInboundDate ?? '-',
    },
    {
      title: '실입고',
      key: 'actualInboundAt',
      width: 96,
      render: (_, { component: c }) => c?.actualInboundAt ?? '-',
    },
    {
      title: '출고',
      key: 'actualOutboundAt',
      width: 96,
      render: (_, { component: c }) => c?.actualOutboundAt ?? '-',
    },
    {
      // "상태를 고르는" 칸이 아니라 "다음 할 일을 끝내는" 칸이다.
      // 통상 경로는 버튼으로 바로 내고, 되돌리기 같은 예외만 ⋯ 안으로 넣는다.
      title: '다음 할 일',
      key: 'componentActions',
      width: 210,
      render: (_, { component: c }) => {
        if (!c) return null;
        const actions = nextActions(c.status);
        const exceptions = exceptionActions(c.status);
        const pendingTo =
          statusMutation.isPending && statusMutation.variables?.componentId === c.id
            ? statusMutation.variables?.toStatus
            : undefined;

        return (
          <Can permission="PRODUCTION_EDIT">
            <Space size={4} wrap>
              {actions.length === 0 && (
                <Typography.Text type="secondary">
                  {c.status === 'CANCELLED' ? '취소됨' : '모든 단계 완료'}
                </Typography.Text>
              )}
              {actions.map((a, i) => (
                <Button
                  key={a.toStatus}
                  size="small"
                  // 통상 경로만 강조한다 — 건너뛰기 경로까지 강조하면 둘 다 안 읽힌다.
                  type={i === 0 ? 'primary' : 'default'}
                  ghost={i === 0}
                  icon={i === 0 ? <CheckOutlined /> : undefined}
                  loading={pendingTo === a.toStatus}
                  onClick={() => runAction(c, a)}
                >
                  {a.label}
                </Button>
              ))}
              {exceptions.length > 0 && (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: ['건너뛰기', '되돌리기']
                      .map((group) => ({
                        key: group,
                        type: 'group' as const,
                        label: group,
                        children: exceptions
                          .filter((e) => e.group === group)
                          .map((e) => ({
                            key: `${group}:${e.toStatus}`,
                            label: e.backward ? `${e.label} (사유 필요)` : e.label,
                            onClick: () => {
                              // 되돌리기만 사유를 받는다. 건너뛰기는 정방향이라 바로 처리한다.
                              if (e.group === '건너뛰기') {
                                runAction(c, e);
                                return;
                              }
                              reasonForm.resetFields();
                              setExceptionTarget({
                                component: c,
                                toStatus: e.toStatus,
                                backward: e.backward,
                                label: e.label,
                              });
                            },
                          })),
                      }))
                      .filter((g) => g.children.length > 0),
                  }}
                >
                  <Tooltip title="건너뛰기·되돌리기">
                    <Button size="small" icon={<EllipsisOutlined />} />
                  </Tooltip>
                </Dropdown>
              )}
            </Space>
          </Can>
        );
      },
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
      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* 화면 이동은 하단 [이전화면] 하나로 통일한다 — 계약 상세·제작 목록 양쪽에서 들어오므로 상단에 고정 목적지를 두지 않는다. */}
          <div>
            <Typography.Title level={4} style={{ marginBottom: 4 }}>
              제작 관리 — {contract?.customerName ?? ''}
            </Typography.Title>
            <Typography.Text type="secondary">
              {[contract?.customerPhone, contract?.contractNo].filter(Boolean).join(' · ')}
            </Typography.Text>
          </div>
          <Table<ProductionRow>
            rowKey="key"
            scroll={{ x: 'max-content' }}
            size="middle"
            loading={itemsQuery.isLoading}
            dataSource={rows}
            columns={columns}
            pagination={false}
            locale={{ emptyText: '이 계약에는 제작 대상 품목이 없습니다.' }}
          />
        </Space>
      </Card>

      {/* 계약 상세 등 여러 경로로 들어오므로 뒤로가기로 통일 */}
      <BackButton />

      {/* 예외 처리(되돌리기) 확인 — 갈 상태는 메뉴에서 이미 정해졌고 여기서는 사유만 받는다 */}
      <Modal
        title={
          exceptionTarget
            ? `${componentLabel(exceptionTarget.component.componentType)} — ${exceptionTarget.label}`
            : '예외 처리'
        }
        open={!!exceptionTarget}
        onCancel={() => setExceptionTarget(null)}
        onOk={() => reasonForm.submit()}
        okText="처리"
        cancelText="취소"
        confirmLoading={statusMutation.isPending}
        destroyOnClose
      >
        {exceptionTarget && (
          <Form
            form={reasonForm}
            layout="vertical"
            onFinish={(values) => {
              statusMutation.mutate({
                componentId: exceptionTarget.component.id,
                toStatus: exceptionTarget.toStatus,
                reason: values.reason,
              });
            }}
          >
            <Typography.Paragraph type="secondary">
              {statusLabel(exceptionTarget.component.status)} →{' '}
              {statusLabel(exceptionTarget.toStatus)}
            </Typography.Paragraph>
            <Form.Item
              name="reason"
              label={exceptionTarget.backward ? '되돌리는 사유' : '메모'}
              rules={
                exceptionTarget.backward
                  ? [{ required: true, message: '상태 역행 사유를 입력해 주세요.' }]
                  : undefined
              }
            >
              <Input.TextArea
                rows={2}
                placeholder={exceptionTarget.backward ? '되돌리는 사유 (필수)' : '메모 (선택)'}
              />
            </Form.Item>
          </Form>
        )}
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

      <WorkOrderFormPreviewModal
        open={formPreviewItemId != null}
        onClose={() => setFormPreviewItemId(null)}
        orderItemId={formPreviewItemId ?? undefined}
      />
    </Space>
  );
}
