import { CheckOutlined, FileTextOutlined, SearchOutlined, SwapOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  RENTAL_COMPONENT_TYPE_LABELS,
  RENTAL_ITEM_STATUS_META,
  RENTAL_SELECTION_STATUS_META,
  confirmRentalSelection,
  fetchCurrentRentalSelection,
  fetchRentalColors,
  fetchRentalLineCandidates,
  fetchRentalSelectionReview,
  fetchRentalSizes,
  saveRentalLine,
  saveRentalPeriod,
  selectRentalLineItem,
  startRentalSelection,
  type RentalAllocatePrefill,
  type RentalCandidate,
  type RentalComponentType,
  type RentalSelectionComponent,
  type RentalSelectionDetail,
} from '../../api/rentals';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';

interface Draft {
  colorCode?: string;
  sizeCode?: string;
  notes?: string;
}

/**
 * 렌탈 스타일 선택 화면 (v2 D3 / 설계서 04 §4).
 * 렌탈 주문 품목의 **대여 기간**을 먼저 정하고, 구성품(상의/하의/베스트)별로 컬러·사이즈·비고를
 * 지정한 뒤 그 기간에 비어 있는 후보 실물을 골라 확정한다.
 * 대여 날짜는 필수값이다(현업 확정 2026-07-28) — 기간 없이는 후보 검색·확정이 막힌다.
 */
export function RentalSelectionPage() {
  const { orderItemId } = useParams<{ orderItemId: string }>();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [candidateFor, setCandidateFor] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const sessionKey = ['rentals', 'selection', orderItemId];
  const sessionQuery = useQuery({
    queryKey: sessionKey,
    queryFn: () => fetchCurrentRentalSelection(orderItemId!),
    enabled: !!orderItemId,
  });
  const detail = sessionQuery.data?.session ?? null;
  const sessionId = detail?.sessionId;
  const editable = detail?.status === 'IN_PROGRESS';

  const colorsQuery = useQuery({ queryKey: ['rentals', 'colors'], queryFn: fetchRentalColors });
  const sizesQuery = useQuery({ queryKey: ['rentals', 'sizes'], queryFn: fetchRentalSizes });

  const colorOptions = useMemo(
    () => (colorsQuery.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` })),
    [colorsQuery.data],
  );
  const sizeOptions = useMemo(
    () => (sizesQuery.data ?? []).map((s) => ({ value: s.code, label: `${s.name} (${s.code})` })),
    [sizesQuery.data],
  );

  // 세션 상세가 (재)로드될 때마다 편집 초안을 서버값으로 동기화한다.
  useEffect(() => {
    if (!detail) return;
    const next: Record<string, Draft> = {};
    for (const c of detail.components) {
      next[c.orderItemComponentId] = {
        colorCode: c.colorCode ?? undefined,
        sizeCode: c.sizeCode ?? undefined,
        notes: c.notes ?? undefined,
      };
    }
    setDrafts(next);
  }, [detail]);

  const applyDetail = (d: RentalSelectionDetail) => {
    queryClient.setQueryData(sessionKey, { session: d });
  };

  const startMut = useMutation({
    mutationFn: () => startRentalSelection(orderItemId!),
    onSuccess: applyDetail,
    onError: (e) => message.error(e instanceof ApiError ? e.message : '세션을 시작할 수 없습니다.'),
  });

  const saveLineMut = useMutation({
    mutationFn: (componentId: string) =>
      saveRentalLine(sessionId!, componentId, { ...drafts[componentId], version: detail?.version }),
    onSuccess: (d) => {
      applyDetail(d);
      message.success('부위 정보를 저장했습니다. (조건 변경 시 선택 실물은 초기화됩니다)');
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '저장에 실패했습니다.'),
  });

  const selectItemMut = useMutation({
    mutationFn: (v: { componentId: string; inventoryItemId: string | null }) =>
      selectRentalLineItem(sessionId!, v.componentId, {
        inventoryItemId: v.inventoryItemId,
        version: detail?.version,
      }),
    onSuccess: (d) => {
      applyDetail(d);
      setCandidateFor(null);
      message.success('후보 실물을 반영했습니다.');
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '실물 선택에 실패했습니다.'),
  });

  // 대여 기간 — 필수값. 없으면 후보 검색·확정이 서버에서 막힌다(RENTAL_PERIOD_REQUIRED).
  const period: [Dayjs, Dayjs] | null =
    detail?.pickupDate && detail?.returnDueDate
      ? [dayjs(detail.pickupDate), dayjs(detail.returnDueDate)]
      : null;
  const hasPeriod = !!period;

  const periodMut = useMutation({
    mutationFn: (range: [Dayjs, Dayjs]) =>
      saveRentalPeriod(sessionId!, {
        pickupDate: range[0].format('YYYY-MM-DD'),
        returnDueDate: range[1].format('YYYY-MM-DD'),
        version: detail?.version,
      }),
    onSuccess: (d) => {
      applyDetail(d);
      setCandidateFor(null);
      message.success('대여 기간을 저장했습니다. 이 기간에 비어 있는 실물만 후보로 나옵니다.');
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '대여 기간 저장에 실패했습니다.'),
  });

  const confirmMut = useMutation({
    mutationFn: () => confirmRentalSelection(sessionId!, { version: detail?.version }),
    onSuccess: (d) => {
      applyDetail(d);
      message.success('렌탈 선택을 확정했습니다.');
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '확정에 실패했습니다.'),
  });

  const candidatesQuery = useQuery({
    queryKey: ['rentals', 'selection', sessionId, 'candidates', candidateFor],
    queryFn: () => fetchRentalLineCandidates(sessionId!, candidateFor!),
    enabled: !!sessionId && !!candidateFor,
  });

  const reviewQuery = useQuery({
    queryKey: ['rentals', 'selection', sessionId, 'review'],
    queryFn: () => fetchRentalSelectionReview(sessionId!),
    enabled: !!sessionId && reviewOpen,
  });

  if (!orderItemId) {
    return <Alert type="warning" showIcon message="주문 품목이 지정되지 않았습니다." />;
  }

  if (sessionQuery.isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  if (!detail) {
    return (
      <Card>
        <Empty
          description="이 품목의 렌탈 선택 세션이 아직 없습니다."
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Button type="primary" loading={startMut.isPending} onClick={() => startMut.mutate()}>
            렌탈 선택 시작
          </Button>
        </Empty>
      </Card>
    );
  }

  const columns: ColumnsType<RentalSelectionComponent> = [
    {
      title: '부위',
      dataIndex: 'componentType',
      width: 130,
      render: (c: RentalComponentType) => (
        <Typography.Text strong>{RENTAL_COMPONENT_TYPE_LABELS[c] ?? c}</Typography.Text>
      ),
    },
    {
      title: '컬러',
      width: 180,
      render: (_, r) => (
        <Select
          allowClear
          disabled={!editable}
          loading={colorsQuery.isLoading}
          placeholder="컬러 선택"
          style={{ width: '100%' }}
          value={drafts[r.orderItemComponentId]?.colorCode}
          options={colorOptions}
          onChange={(v) =>
            setDrafts((d) => ({ ...d, [r.orderItemComponentId]: { ...d[r.orderItemComponentId], colorCode: v } }))
          }
        />
      ),
    },
    {
      title: '사이즈',
      width: 160,
      render: (_, r) => (
        <Select
          allowClear
          disabled={!editable}
          loading={sizesQuery.isLoading}
          placeholder="사이즈 선택"
          style={{ width: '100%' }}
          value={drafts[r.orderItemComponentId]?.sizeCode}
          options={sizeOptions}
          onChange={(v) =>
            setDrafts((d) => ({ ...d, [r.orderItemComponentId]: { ...d[r.orderItemComponentId], sizeCode: v } }))
          }
        />
      ),
    },
    {
      title: '비고(수치 등)',
      render: (_, r) => (
        <Input
          disabled={!editable}
          placeholder="수선명령·수치 등"
          value={drafts[r.orderItemComponentId]?.notes}
          onChange={(e) =>
            setDrafts((d) => ({
              ...d,
              [r.orderItemComponentId]: { ...d[r.orderItemComponentId], notes: e.target.value },
            }))
          }
        />
      ),
    },
    {
      title: '선택 실물',
      width: 220,
      render: (_, r) =>
        r.selectedItem ? (
          <Space direction="vertical" size={0}>
            <Typography.Text>{r.selectedItem.managementCode}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.selectedItem.design} · {r.selectedItem.color} · {r.selectedItem.size}
            </Typography.Text>
            <StatusBadge
              label={metaOf(RENTAL_ITEM_STATUS_META, r.selectedItem.status).label}
              color={metaOf(RENTAL_ITEM_STATUS_META, r.selectedItem.status).color}
            />
          </Space>
        ) : (
          <Typography.Text type="secondary">미선택</Typography.Text>
        ),
    },
    {
      title: '작업',
      width: 220,
      render: (_, r) => (
        <Space wrap>
          <Button
            size="small"
            disabled={!editable}
            loading={saveLineMut.isPending && saveLineMut.variables === r.orderItemComponentId}
            onClick={() => saveLineMut.mutate(r.orderItemComponentId)}
          >
            저장
          </Button>
          <Tooltip title={hasPeriod ? '' : '대여 기간을 먼저 정해 주세요.'}>
            <Button
              size="small"
              icon={<SearchOutlined />}
              disabled={!editable || !hasPeriod}
              onClick={() => setCandidateFor(r.orderItemComponentId)}
            >
              후보 조회
            </Button>
          </Tooltip>
          {r.selectedItem && (
            <Button
              size="small"
              danger
              disabled={!editable}
              onClick={() =>
                selectItemMut.mutate({ componentId: r.orderItemComponentId, inventoryItemId: null })
              }
            >
              해제
            </Button>
          )}
        </Space>
      ),
    },
  ];

  // C5: 확정 후 [배정으로] — 선택된 실물·구성품을 배정 화면으로 프리필 전달(자동 생성 아님, 날짜는 배정 모달에서 입력).
  const allocationPrefill: RentalAllocatePrefill = {
    items: detail.components
      .filter((c) => c.selectedItem)
      .map((c) => ({
        componentId: c.orderItemComponentId,
        orderNo: detail.orderNo,
        customerName: detail.customerName,
        item: {
          id: c.selectedItem!.id,
          managementCode: c.selectedItem!.managementCode,
          componentType: c.componentType,
          design: c.selectedItem!.design,
          color: c.selectedItem!.color,
          size: c.selectedItem!.size,
        },
      })),
  };
  const canAllocate = detail.status === 'CONFIRMED' && allocationPrefill.items.length > 0;

  const candidateColumns: ColumnsType<RentalCandidate> = [
    { title: '관리 ID', dataIndex: 'managementCode', width: 170 },
    { title: '디자인', dataIndex: 'design', width: 110 },
    { title: '컬러', dataIndex: 'color', width: 90 },
    { title: '사이즈', dataIndex: 'size', width: 80 },
    {
      title: '선택',
      width: 90,
      render: (_, r) => (
        <Button
          type="primary"
          size="small"
          icon={<CheckOutlined />}
          loading={selectItemMut.isPending}
          onClick={() =>
            candidateFor &&
            selectItemMut.mutate({ componentId: candidateFor, inventoryItemId: r.id })
          }
        >
          선택
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            렌탈 스타일 선택
          </Typography.Title>
          <Space>
            <StatusBadge
              label={metaOf(RENTAL_SELECTION_STATUS_META, detail.status).label}
              color={metaOf(RENTAL_SELECTION_STATUS_META, detail.status).color}
            />
            <Button icon={<FileTextOutlined />} onClick={() => setReviewOpen(true)}>
              확인서
            </Button>
            {canAllocate && (
              <Button
                icon={<SwapOutlined />}
                onClick={() =>
                  navigate('/rentals/allocate', { state: { rentalAllocatePrefill: allocationPrefill } })
                }
              >
                배정으로
              </Button>
            )}
            <Button
              type="primary"
              icon={<CheckOutlined />}
              disabled={!editable || !hasPeriod}
              loading={confirmMut.isPending}
              onClick={() => confirmMut.mutate()}
            >
              확정
            </Button>
          </Space>
        </Space>
        <Descriptions size="small" bordered column={3} style={{ marginTop: 16 }}>
          <Descriptions.Item label="고객">{detail.customerName}</Descriptions.Item>
          <Descriptions.Item label="주문번호">{detail.orderNo}</Descriptions.Item>
          <Descriptions.Item label="품목">{detail.displayName}</Descriptions.Item>
          <Descriptions.Item label="대여 기간" span={3}>
            <Space wrap>
              <DatePicker.RangePicker
                value={period}
                disabled={!editable || periodMut.isPending}
                allowClear={false}
                onChange={(range) => {
                  if (range?.[0] && range[1]) periodMut.mutate([range[0], range[1]]);
                }}
              />
              {!hasPeriod && (
                <Typography.Text type="danger">
                  대여일·반납일을 먼저 정해야 후보 실물을 찾을 수 있습니다.
                </Typography.Text>
              )}
            </Space>
          </Descriptions.Item>
        </Descriptions>
        {!editable && (
          <Alert
            style={{ marginTop: 12 }}
            type="success"
            showIcon
            message="확정된 렌탈 선택입니다. 내용은 확인서로 열람할 수 있습니다."
          />
        )}
      </Card>

      <Card title="구성품별 컬러·사이즈·후보 실물">
        <Table<RentalSelectionComponent>
          rowKey="orderItemComponentId"
          size="middle"
          scroll={{ x: 'max-content' }}
          dataSource={detail.components}
          columns={columns}
          pagination={false}
          locale={{ emptyText: '이 품목에 등록된 구성품이 없습니다.' }}
        />
      </Card>

      <Modal
        open={!!candidateFor}
        title="후보 실물 (대여 가능 재고)"
        onCancel={() => setCandidateFor(null)}
        footer={<Button onClick={() => setCandidateFor(null)}>닫기</Button>}
        width={720}
      >
        {candidatesQuery.data && (
          <Typography.Paragraph type="secondary">
            {RENTAL_COMPONENT_TYPE_LABELS[candidatesQuery.data.componentType] ??
              candidatesQuery.data.componentType}
            {candidatesQuery.data.colorCode ? ` · 컬러 ${candidatesQuery.data.colorCode}` : ''}
            {candidatesQuery.data.sizeCode ? ` · 사이즈 ${candidatesQuery.data.sizeCode}` : ''}
          </Typography.Paragraph>
        )}
        <Table<RentalCandidate>
          rowKey="id"
          size="small"
          loading={candidatesQuery.isLoading}
          dataSource={candidatesQuery.data?.candidates ?? []}
          columns={candidateColumns}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: '조건에 맞는 대여 가능 실물이 없습니다.' }}
        />
      </Modal>

      <Drawer
        open={reviewOpen}
        title="렌탈 선택 확인서"
        width={640}
        onClose={() => setReviewOpen(false)}
      >
        {reviewQuery.isLoading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin />
          </div>
        ) : reviewQuery.data ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="고객">{reviewQuery.data.customerName}</Descriptions.Item>
              <Descriptions.Item label="주문번호">{reviewQuery.data.orderNo}</Descriptions.Item>
              <Descriptions.Item label="품목">{reviewQuery.data.displayName}</Descriptions.Item>
              <Descriptions.Item label="상태">
                <StatusBadge
                  label={metaOf(RENTAL_SELECTION_STATUS_META, reviewQuery.data.status).label}
                  color={metaOf(RENTAL_SELECTION_STATUS_META, reviewQuery.data.status).color}
                />
              </Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="orderItemComponentId"
              size="small"
              pagination={false}
              scroll={{ x: 'max-content' }}
              dataSource={reviewQuery.data.components}
              columns={[
                {
                  title: '부위',
                  dataIndex: 'componentType',
                  render: (c: RentalComponentType) => RENTAL_COMPONENT_TYPE_LABELS[c] ?? c,
                },
                { title: '컬러', dataIndex: 'colorName', render: (v: string | null) => v ?? '-' },
                { title: '사이즈', dataIndex: 'sizeName', render: (v: string | null) => v ?? '-' },
                {
                  title: '실물',
                  render: (_, r) => r.selectedItem?.managementCode ?? '미선택',
                },
                { title: '비고', dataIndex: 'notes', render: (v: string | null) => v ?? '-' },
              ]}
            />
          </Space>
        ) : (
          <Empty description="확인서를 불러올 수 없습니다." image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Drawer>
    </Space>
  );
}
