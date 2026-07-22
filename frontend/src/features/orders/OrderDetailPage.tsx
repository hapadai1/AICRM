import {
  ColumnHeightOutlined,
  FileExcelOutlined,
  PlusOutlined,
  SkinOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Flex,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  addOrderItemComponent,
  fetchOrder,
  fetchOrderItems,
  type ComponentType,
  type OrderComponent,
  type OrderItem,
} from '../../api/orders';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { labelOf } from '../../shared/status-meta';
import {
  COMPONENT_STATUS_META,
  COMPONENT_TYPE_LABEL,
  metaOf,
  ORDER_ITEM_STATUS_META,
  ORDER_STATUS_META,
  TRANSACTION_TYPE_LABEL,
  TRANSACTION_TYPE_TAG_COLOR,
} from '../contracts/labels';

/**
 * ORD-001 주문 상세 — 품목 카드, 구성품 부분 입출고
 *
 * 옵션 진행률·채촌 연결 여부·작업지시서 출력 이력·렌탈 실물 코드·상태 타임라인은
 * 백엔드가 아직 내려주지 않는다. 값을 지어내지 않고 '-'로 표시한다 (docs/dev/08 §4).
 */

/** 백엔드 미제공 필드 자리 표시 */
const PENDING = '-';

const COMPONENT_TYPE_OPTIONS = (['JACKET', 'TROUSERS', 'VEST', 'SHIRT', 'SHOES'] as ComponentType[]).map((v) => ({
  value: v,
  label: COMPONENT_TYPE_LABEL[v],
}));

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const { data: order, isLoading, error } = useQuery({
    queryKey: ['orders', id],
    queryFn: () => fetchOrder(id),
    enabled: !!id,
  });

  const { data: items } = useQuery({
    queryKey: ['orders', id, 'items'],
    queryFn: () => fetchOrderItems(id),
    enabled: !!id,
  });

  const [componentModalItem, setComponentModalItem] = useState<OrderItem | null>(null);
  const [componentType, setComponentType] = useState<ComponentType | undefined>(undefined);

  const addComponentMutation = useMutation({
    mutationFn: (vars: { itemId: string; componentType: ComponentType }) =>
      addOrderItemComponent(vars.itemId, { componentType: vars.componentType }),
    onSuccess: () => {
      message.success('구성품을 추가했습니다.');
      setComponentModalItem(null);
      setComponentType(undefined);
      void queryClient.invalidateQueries({ queryKey: ['orders', id, 'items'] });
    },
    onError: (e: unknown) => {
      message.error(e instanceof ApiError ? e.message : '처리 중 오류가 발생했습니다.');
    },
  });

  if (error) {
    return (
      <Card>
        <Alert
          type="error"
          showIcon
          message="주문을 찾을 수 없습니다"
          description={error instanceof ApiError ? error.message : undefined}
          action={<Button onClick={() => navigate('/contracts')}>계약 목록으로</Button>}
        />
      </Card>
    );
  }

  const isRental = order?.transactionType === 'RENTAL';
  const orderStatusMeta = metaOf(ORDER_STATUS_META, order?.status ?? '');

  const componentColumns = (item: OrderItem): ColumnsType<OrderComponent> => [
    {
      title: '구성품',
      dataIndex: 'componentType',
      width: 120,
      render: (v: string) => labelOf(COMPONENT_TYPE_LABEL, v),
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: 120,
      render: (v: string) => {
        const meta = metaOf(COMPONENT_STATUS_META, v);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    { title: '입고 예정일', dataIndex: 'expectedInboundDate', width: 110, render: (v?: string) => v ?? '-' },
    { title: '실제 입고일', dataIndex: 'actualInboundAt', width: 110, render: (v?: string) => v ?? '-' },
    { title: '출고일', dataIndex: 'actualOutboundAt', width: 110, render: (v?: string) => v ?? '-' },
    {
      // 배정된 렌탈 실물 코드는 백엔드 응답에 없다 (docs/dev/08 §4 — 필드 추가 대기).
      title: '렌탈 실물 ID',
      key: 'rentalItemCode',
      width: 160,
      render: () => PENDING,
    },
    ...(isRental
      ? ([
          {
            title: '',
            key: 'allocate',
            width: 110,
            render: (_: unknown, cmp: OrderComponent) =>
              item.status === 'CANCELLED' || cmp.status === 'CANCELLED' ? null : (
                <Can permission="RENTAL_ALLOCATE">
                  <Button
                    size="small"
                    icon={<SwapOutlined />}
                    onClick={() => navigate(`/rentals/allocate?componentId=${cmp.id}`)}
                  >
                    렌탈 배정
                  </Button>
                </Can>
              ),
          },
        ] as ColumnsType<OrderComponent>)
      : []),
  ];

  return (
    <Flex vertical gap={16}>
      <Card loading={isLoading}>
        <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 16 }}>
          <Space size={12} wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              주문 {order?.orderNo}
            </Typography.Title>
            {order && (
              <Tag color={TRANSACTION_TYPE_TAG_COLOR[order.transactionType]}>
                {TRANSACTION_TYPE_LABEL[order.transactionType]}
              </Tag>
            )}
            <StatusBadge label={orderStatusMeta.label} color={orderStatusMeta.color} />
          </Space>
          <Button onClick={() => navigate(`/contracts/${order?.contractId}`)}>계약 상세</Button>
        </Flex>

        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }} bordered>
          {/* 고객은 주문이 아니라 계약 아래(contract.customer)에 있다. */}
          <Descriptions.Item label="고객">
            {order?.customerName} {order?.customerPhone && `(${order.customerPhone})`}
          </Descriptions.Item>
          <Descriptions.Item label="계약">{order?.contractNo ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="완료 예정일">{order?.completionDueDate ?? '-'}</Descriptions.Item>
          {/* 촬영일·예식일은 주문 자체가 들고 있다. */}
          <Descriptions.Item label="촬영일 / 예식일">
            {order?.photoDate ?? '-'} / {order?.weddingDate ?? '-'}
          </Descriptions.Item>
        </Descriptions>

        <Alert
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          message="주문 품목 수량은 이 화면에서 변경할 수 없습니다."
          description="품목·수량 조정은 계약 상세의 변경 계약에서만 수행합니다."
          action={
            <Button size="small" onClick={() => navigate(`/contracts/${order?.contractId}`)}>
              계약 변경으로 이동
            </Button>
          }
        />
      </Card>

      {(items ?? []).map((item) => {
        const itemMeta = metaOf(ORDER_ITEM_STATUS_META, item.status);
        const cancelled = item.status === 'CANCELLED';
        const activeComponents = item.components.filter((c) => c.status !== 'CANCELLED');
        const receivedCount = activeComponents.filter((c) =>
          ['RECEIVED', 'RELEASED', 'RETURNED'].includes(c.status),
        ).length;
        return (
          <Card
            key={item.id}
            style={cancelled ? { opacity: 0.6 } : undefined}
            title={
              <Space>
                <SkinOutlined />
                <Typography.Text strong>{item.displayName}</Typography.Text>
                <StatusBadge label={itemMeta.label} color={itemMeta.color} />
              </Space>
            }
            extra={
              !cancelled && (
                <Space wrap>
                  {!isRental && (
                    <>
                      <Button
                        size="small"
                        icon={<ColumnHeightOutlined />}
                        onClick={() => navigate(`/contracts/${order?.contractId}/options`)}
                      >
                        옵션 진행
                      </Button>
                      <Button
                        size="small"
                        onClick={() => navigate(`/measurements?customerId=${order?.customerId}`)}
                      >
                        채촌
                      </Button>
                      <Button
                        size="small"
                        icon={<FileExcelOutlined />}
                        onClick={() => navigate(`/work-orders/${item.id}`)}
                      >
                        작업지시서
                      </Button>
                    </>
                  )}
                  <Can permission="ORDER_EDIT">
                    <Button size="small" icon={<PlusOutlined />} onClick={() => setComponentModalItem(item)}>
                      구성품 추가
                    </Button>
                  </Can>
                </Space>
              )
            }
          >
            <Flex vertical gap={16}>
              {/* 옵션 진행률·채촌 연결·작업지시서 출력 (GET /orders/:id/items, docs/dev/08 §4) */}
              {!isRental && !cancelled && (
                <Space size={24} wrap>
                  <Space>
                    <Typography.Text type="secondary">옵션 진행률</Typography.Text>
                    <Typography.Text>
                      {item.optionProgress.total > 0
                        ? `${item.optionProgress.current}/${item.optionProgress.total} 단계`
                        : '미시작'}
                    </Typography.Text>
                  </Space>
                  <Space>
                    <Typography.Text type="secondary">채촌</Typography.Text>
                    <Typography.Text>
                      {item.measurement.linked
                        ? `V${item.measurement.versionNo} ${item.measurement.completed ? '완료' : '작성중'}`
                        : '미연결'}
                    </Typography.Text>
                  </Space>
                  <Space>
                    <Typography.Text type="secondary">작업지시서</Typography.Text>
                    <Typography.Text>
                      {item.workOrderVersionCount > 0
                        ? `${item.workOrderVersionCount}회 출력`
                        : '미출력'}
                    </Typography.Text>
                  </Space>
                </Space>
              )}

              <div>
                <Typography.Text strong>
                  구성품{' '}
                  <Typography.Text type="secondary">
                    (입고 {receivedCount}/{activeComponents.length} — 부분 입출고는 구성품별 상태로 관리)
                  </Typography.Text>
                </Typography.Text>
                <Table
                  style={{ marginTop: 8 }}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  columns={componentColumns(item)}
                  dataSource={item.components}
                  scroll={{ x: 760 }}
                />
              </div>
            </Flex>
          </Card>
        );
      })}

      {/* 상태 타임라인 카드는 제거했다 — 백엔드에 주문 상태 이력 API가 없다 (docs/dev/08 §4). */}

      {/* 구성품 추가 (베스트 등) */}
      <Modal
        title={`구성품 추가 — ${componentModalItem?.displayName ?? ''}`}
        open={!!componentModalItem}
        okText="추가"
        cancelText="취소"
        okButtonProps={{ disabled: !componentType }}
        confirmLoading={addComponentMutation.isPending}
        onOk={() => {
          if (componentModalItem && componentType) {
            addComponentMutation.mutate({ itemId: componentModalItem.id, componentType });
          }
        }}
        onCancel={() => {
          setComponentModalItem(null);
          setComponentType(undefined);
        }}
      >
        <Flex vertical gap={8}>
          <Typography.Text type="secondary">
            정장 기본 구성품은 상의·하의이며 베스트는 필요 시 추가합니다.
          </Typography.Text>
          <Select
            placeholder="구성품 종류 선택"
            style={{ width: '100%' }}
            options={COMPONENT_TYPE_OPTIONS}
            value={componentType}
            onChange={setComponentType}
          />
        </Flex>
      </Modal>
    </Flex>
  );
}
