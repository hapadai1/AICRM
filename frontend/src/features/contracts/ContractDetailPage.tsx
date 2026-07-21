import { CheckOutlined, DiffOutlined, EditOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Flex,
  Input,
  InputNumber,
  List,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  cancelContract,
  confirmContractRevision,
  createContractRevision,
  fetchContract,
  fetchContractVersions,
  type ContractLine,
  type ContractVersion,
  type ProductCategory,
  type RevisionConfirmResult,
  type TransactionType,
} from '../../api/contracts';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { ContractLineEditor, createLine, linesTotal, type EditableLine } from './ContractLineEditor';
import {
  CONTRACT_STATUS_META,
  CONTRACT_VERSION_STATUS_META,
  formatKrw,
  metaOf,
  ORDER_STATUS_META,
  PRODUCT_CATEGORY_LABEL,
  TRANSACTION_TYPE_LABEL,
  TRANSACTION_TYPE_TAG_COLOR,
} from './labels';
import { useUnsavedWarning } from './use-unsaved-warning';

/** CONT-003 계약 상세·변경 계약 — 버전 목록, 변경 초안·비교·영향 미리보기·확정, 계약 취소 */

interface CompareRow {
  key: string;
  transactionType: TransactionType;
  productCategory: ProductCategory;
  beforeQty: number;
  afterQty: number;
  beforeAmount: number;
  afterAmount: number;
}

function aggregate(lines: { transactionType: TransactionType; productCategory: ProductCategory; quantity: number; amount: number }[]) {
  const map = new Map<string, { qty: number; amount: number }>();
  for (const l of lines) {
    const key = `${l.transactionType}|${l.productCategory}`;
    const cur = map.get(key) ?? { qty: 0, amount: 0 };
    map.set(key, { qty: cur.qty + l.quantity, amount: cur.amount + l.amount });
  }
  return map;
}

function buildCompareRows(before: ContractLine[], after: EditableLine[]): CompareRow[] {
  const b = aggregate(before);
  const a = aggregate(after);
  const keys = [...new Set([...b.keys(), ...a.keys()])].sort();
  return keys.map((key) => {
    const [transactionType, productCategory] = key.split('|') as [TransactionType, ProductCategory];
    return {
      key,
      transactionType,
      productCategory,
      beforeQty: b.get(key)?.qty ?? 0,
      afterQty: a.get(key)?.qty ?? 0,
      beforeAmount: b.get(key)?.amount ?? 0,
      afterAmount: a.get(key)?.amount ?? 0,
    };
  });
}

function DiffText({ diff, formatter }: { diff: number; formatter?: (v: number) => string }) {
  const fmt = formatter ?? ((v: number) => `${v}`);
  if (diff === 0) return <Typography.Text type="secondary">-</Typography.Text>;
  return (
    <Typography.Text strong type={diff > 0 ? 'success' : 'danger'}>
      {diff > 0 ? '+' : ''}
      {fmt(diff)}
    </Typography.Text>
  );
}

export function ContractDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();

  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['contracts', id],
    queryFn: () => fetchContract(id),
    enabled: !!id,
  });

  const { data: versions } = useQuery({
    queryKey: ['contracts', id, 'versions'],
    queryFn: () => fetchContractVersions(id),
    enabled: !!id,
  });

  // 버전 상태 필드는 versionStatus 다 (status 아님).
  const draftRevision = versions?.find((v) => v.versionStatus === 'DRAFT');
  const baseline = versions?.find(
    (v) => v.versionNo === detail?.currentVersionNo && v.versionStatus === 'CONFIRMED',
  );

  // 변경 초안 품목 편집 상태
  const [revLines, setRevLines] = useState<EditableLine[]>([]);
  const [revTotal, setRevTotal] = useState(0);
  const [revDeposit, setRevDeposit] = useState(0);
  const [revDirty, setRevDirty] = useState(false);

  useEffect(() => {
    if (!draftRevision) {
      setRevLines([]);
      setRevDirty(false);
      return;
    }
    setRevLines(
      draftRevision.lines.map((l) =>
        createLine({
          id: l.id,
          transactionType: l.transactionType,
          productCategory: l.productCategory,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
          note: l.note,
        }),
      ),
    );
    setRevTotal(draftRevision.totalAmount);
    setRevDeposit(draftRevision.depositAmount);
    setRevDirty(false);
  }, [draftRevision?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useUnsavedWarning(revDirty);

  const compareRows = useMemo(
    () => (draftRevision ? buildCompareRows(baseline?.lines ?? [], revLines) : []),
    [draftRevision, baseline, revLines],
  );
  const createdPreview = compareRows.filter((r) => r.afterQty > r.beforeQty);
  const cancelledPreview = compareRows.filter((r) => r.afterQty < r.beforeQty);
  const revLineTotal = linesTotal(revLines);
  const revMismatch = revLines.length > 0 && revTotal !== revLineTotal;

  // 변경 사유·취소 사유 입력 모달
  const [revisionModalOpen, setRevisionModalOpen] = useState(false);
  const [revisionReason, setRevisionReason] = useState('');
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [revisionResult, setRevisionResult] = useState<RevisionConfirmResult | null>(null);

  const onApiError = (e: unknown) => {
    message.error(e instanceof ApiError ? e.message : '처리 중 오류가 발생했습니다.');
  };

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['contracts'] });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
  };

  const createRevisionMutation = useMutation({
    mutationFn: (reason: string) => createContractRevision(id, { changeReason: reason }),
    onSuccess: () => {
      message.success('변경 초안을 생성했습니다. 품목을 수정한 뒤 변경 확정해 주세요.');
      setRevisionModalOpen(false);
      setRevisionReason('');
      void queryClient.invalidateQueries({ queryKey: ['contracts', id, 'versions'] });
    },
    onError: onApiError,
  });

  const confirmRevisionMutation = useMutation({
    mutationFn: (revision: ContractVersion) =>
      confirmContractRevision(id, revision.id, {
        changeReason: revision.changeReason,
        version: detail?.version ?? 1,
        totalAmount: revTotal,
        depositAmount: revDeposit,
        lines: revLines.map((l) => ({
          id: l.id,
          transactionType: l.transactionType,
          productCategory: l.productCategory,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
          note: l.note?.trim() || undefined,
        })),
      }),
    onSuccess: (result) => {
      setRevDirty(false);
      setRevisionResult(result);
      invalidateAll();
    },
    onError: onApiError,
  });

  const cancelMutation = useMutation({
    mutationFn: (reason: string) => cancelContract(id, { reason, version: detail?.version ?? 1 }),
    onSuccess: () => {
      message.success('계약을 취소했습니다. 미진행 품목이 함께 취소되었습니다.');
      setCancelModalOpen(false);
      setCancelReason('');
      invalidateAll();
    },
    onError: onApiError,
  });

  const handleConfirmRevision = () => {
    if (!draftRevision) return;
    if (revLines.length === 0) {
      message.error('품목을 1개 이상 입력해 주세요.');
      return;
    }
    modal.confirm({
      title: '변경 계약 확정',
      okText: '변경 확정',
      cancelText: '취소',
      width: 520,
      content: (
        <Flex vertical gap={8}>
          <Typography.Text>
            v{draftRevision.versionNo} 버전으로 확정합니다. 수량 증가는 신규 주문 품목을 생성하고, 수량 감소
            대상 품목은 삭제 대신 취소 처리됩니다.
          </Typography.Text>
          {createdPreview.length > 0 && (
            <Typography.Text type="success">
              생성:{' '}
              {createdPreview
                .map(
                  (r) =>
                    `${TRANSACTION_TYPE_LABEL[r.transactionType]} ${PRODUCT_CATEGORY_LABEL[r.productCategory]} +${r.afterQty - r.beforeQty}`,
                )
                .join(', ')}
            </Typography.Text>
          )}
          {cancelledPreview.length > 0 && (
            <Typography.Text type="danger">
              취소:{' '}
              {cancelledPreview
                .map(
                  (r) =>
                    `${TRANSACTION_TYPE_LABEL[r.transactionType]} ${PRODUCT_CATEGORY_LABEL[r.productCategory]} -${r.beforeQty - r.afterQty}`,
                )
                .join(', ')}
            </Typography.Text>
          )}
          {cancelledPreview.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message="작업지시서 출력·렌탈 배정 등 진행 이력이 있는 품목이 취소 대상에 포함될 수 있습니다. 진행이 덜 된 품목부터 취소됩니다."
            />
          )}
          {revMismatch && (
            <Alert
              type="warning"
              showIcon
              message={`합계 금액(${formatKrw(revTotal)})이 품목 합계(${formatKrw(revLineTotal)})와 다릅니다.`}
            />
          )}
        </Flex>
      ),
      onOk: async () => {
        await confirmRevisionMutation.mutateAsync(draftRevision);
      },
    });
  };

  if (error) {
    return (
      <Card>
        <Alert
          type="error"
          showIcon
          message="계약을 찾을 수 없습니다"
          description={error instanceof ApiError ? error.message : undefined}
          action={<Button onClick={() => navigate('/contracts')}>계약 목록으로</Button>}
        />
      </Card>
    );
  }

  const statusMeta = metaOf(CONTRACT_STATUS_META, detail?.status ?? '');
  const canRevise = detail?.status === 'CONFIRMED' || detail?.status === 'CHANGED';
  const canCancel = detail && detail.status !== 'CANCELLED' && detail.status !== 'COMPLETED';

  const lineColumns: ColumnsType<ContractLine> = [
    {
      title: '거래 방식',
      dataIndex: 'transactionType',
      width: 100,
      render: (v: TransactionType) => <Tag color={TRANSACTION_TYPE_TAG_COLOR[v]}>{TRANSACTION_TYPE_LABEL[v]}</Tag>,
    },
    {
      title: '품목',
      dataIndex: 'productCategory',
      width: 100,
      render: (v: ProductCategory) => PRODUCT_CATEGORY_LABEL[v],
    },
    { title: '수량', dataIndex: 'quantity', width: 80, align: 'right' },
    { title: '단가', dataIndex: 'unitPrice', width: 130, align: 'right', render: formatKrw },
    { title: '금액', dataIndex: 'amount', width: 130, align: 'right', render: formatKrw },
    { title: '비고', dataIndex: 'note', render: (v?: string) => v ?? '-' },
  ];

  const versionColumns: ColumnsType<ContractVersion> = [
    {
      title: '버전',
      dataIndex: 'versionNo',
      width: 90,
      render: (v: number) => (
        <Space size={4}>
          <Typography.Text strong>v{v}</Typography.Text>
          {v === detail?.currentVersionNo && <Tag color="green">현재 적용</Tag>}
        </Space>
      ),
    },
    {
      title: '상태',
      dataIndex: 'versionStatus',
      width: 110,
      render: (v: string) => {
        const meta = metaOf(CONTRACT_VERSION_STATUS_META, v);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    { title: '생성일', dataIndex: 'createdAt', width: 110 },
    { title: '합계 금액', dataIndex: 'totalAmount', width: 130, align: 'right', render: formatKrw },
    { title: '변경 사유', dataIndex: 'changeReason', render: (v?: string) => v ?? '-' },
  ];

  const compareColumns: ColumnsType<CompareRow> = [
    {
      title: '품목',
      key: 'label',
      width: 140,
      render: (_, r) => (
        <Space size={4}>
          <Tag color={TRANSACTION_TYPE_TAG_COLOR[r.transactionType]}>{TRANSACTION_TYPE_LABEL[r.transactionType]}</Tag>
          {PRODUCT_CATEGORY_LABEL[r.productCategory]}
        </Space>
      ),
    },
    { title: '변경 전 수량', dataIndex: 'beforeQty', width: 100, align: 'right' },
    { title: '변경 후 수량', dataIndex: 'afterQty', width: 100, align: 'right' },
    {
      title: '수량 차이',
      key: 'qtyDiff',
      width: 100,
      align: 'right',
      render: (_, r) => <DiffText diff={r.afterQty - r.beforeQty} />,
    },
    { title: '변경 전 금액', dataIndex: 'beforeAmount', width: 130, align: 'right', render: formatKrw },
    { title: '변경 후 금액', dataIndex: 'afterAmount', width: 130, align: 'right', render: formatKrw },
    {
      title: '금액 차이',
      key: 'amountDiff',
      width: 130,
      align: 'right',
      render: (_, r) => <DiffText diff={r.afterAmount - r.beforeAmount} formatter={formatKrw} />,
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Card loading={isLoading}>
        <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 16 }}>
          <Space size={12} wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              계약 {detail?.contractNo}
            </Typography.Title>
            <StatusBadge label={statusMeta.label} color={statusMeta.color} />
          </Space>
          <Space wrap>
            {detail?.status === 'DRAFT' && (
              <Can permission="CONTRACT_EDIT">
                <Button
                  icon={<EditOutlined />}
                  onClick={() => navigate(`/contracts/new?contractId=${detail.id}`)}
                >
                  계약서 이어서 작성
                </Button>
              </Can>
            )}
            {canRevise && !draftRevision && (
              <Can permission="CONTRACT_REVISE">
                <Button icon={<DiffOutlined />} onClick={() => setRevisionModalOpen(true)}>
                  변경 초안 생성
                </Button>
              </Can>
            )}
            {canCancel && (
              <Can permission="CONTRACT_CANCEL">
                <Button danger icon={<StopOutlined />} onClick={() => setCancelModalOpen(true)}>
                  계약 취소
                </Button>
              </Can>
            )}
          </Space>
        </Flex>

        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }} bordered>
          <Descriptions.Item label="고객">{detail?.customerName}</Descriptions.Item>
          <Descriptions.Item label="계약 구분">{detail?.contractTypeName}</Descriptions.Item>
          <Descriptions.Item label="계약일">{detail?.contractedAt ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="완료 예정일">{detail?.completionDueDate ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="촬영일">{detail?.photoDate ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="예식일">{detail?.weddingDate ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="합계 금액">{formatKrw(detail?.totalAmount)}</Descriptions.Item>
          <Descriptions.Item label="계약금 / 잔금">
            {formatKrw(detail?.depositAmount)} / {formatKrw(detail?.balanceAmount)}
          </Descriptions.Item>
          {/* 계약 비고 필드는 백엔드 스키마에 없어 표시하지 않는다 (docs/dev/08 §4). */}
        </Descriptions>
      </Card>

      {draftRevision && (
        <Card
          title={
            <Space>
              <DiffOutlined />
              변경 계약 초안 (v{draftRevision.versionNo})
              <Tag color="gold">확정 전</Tag>
            </Space>
          }
          extra={
            <Can permission="CONTRACT_REVISE">
              <Button
                type="primary"
                icon={<CheckOutlined />}
                loading={confirmRevisionMutation.isPending}
                onClick={handleConfirmRevision}
              >
                변경 확정
              </Button>
            </Can>
          }
        >
          <Flex vertical gap={16}>
            <Alert type="info" showIcon message={`변경 사유: ${draftRevision.changeReason ?? '-'}`} />
            <div>
              <Typography.Title level={5}>품목 편집</Typography.Title>
              <ContractLineEditor
                value={revLines}
                onChange={(next) => {
                  setRevLines(next);
                  setRevDirty(true);
                }}
              />
            </div>
            <Space size={24} wrap>
              <Space>
                <Typography.Text>합계 금액(원)</Typography.Text>
                <InputNumber
                  min={0}
                  step={100000}
                  style={{ width: 160 }}
                  value={revTotal}
                  formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                  onChange={(v) => {
                    setRevTotal(v ?? 0);
                    setRevDirty(true);
                  }}
                />
              </Space>
              <Space>
                <Typography.Text>계약금(원)</Typography.Text>
                <InputNumber
                  min={0}
                  step={100000}
                  style={{ width: 160 }}
                  value={revDeposit}
                  formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                  onChange={(v) => {
                    setRevDeposit(v ?? 0);
                    setRevDirty(true);
                  }}
                />
              </Space>
              <Typography.Text type="secondary">잔금 {formatKrw(revTotal - revDeposit)}</Typography.Text>
            </Space>
            {revMismatch && (
              <Alert
                type="warning"
                showIcon
                message={`합계 금액(${formatKrw(revTotal)})이 품목 합계(${formatKrw(revLineTotal)})와 다릅니다.`}
              />
            )}

            <div>
              <Typography.Title level={5}>변경 전후 비교</Typography.Title>
              <Table
                rowKey="key"
                size="small"
                pagination={false}
                columns={compareColumns}
                dataSource={compareRows}
                scroll={{ x: 830 }}
              />
            </div>

            <div>
              <Typography.Title level={5}>영향 미리보기</Typography.Title>
              {createdPreview.length === 0 && cancelledPreview.length === 0 ? (
                <Typography.Text type="secondary">수량 변경이 없어 생성·취소되는 품목이 없습니다.</Typography.Text>
              ) : (
                <Flex vertical gap={8}>
                  {createdPreview.length > 0 && (
                    <Alert
                      type="success"
                      showIcon
                      message="생성될 품목"
                      description={createdPreview
                        .map(
                          (r) =>
                            `${TRANSACTION_TYPE_LABEL[r.transactionType]} ${PRODUCT_CATEGORY_LABEL[r.productCategory]} ${r.afterQty - r.beforeQty}건`,
                        )
                        .join(' · ')}
                    />
                  )}
                  {cancelledPreview.length > 0 && (
                    <Alert
                      type="error"
                      showIcon
                      message="취소될 품목"
                      description={cancelledPreview
                        .map(
                          (r) =>
                            `${TRANSACTION_TYPE_LABEL[r.transactionType]} ${PRODUCT_CATEGORY_LABEL[r.productCategory]} ${r.beforeQty - r.afterQty}건 (진행이 덜 된 품목부터 취소)`,
                        )
                        .join(' · ')}
                    />
                  )}
                </Flex>
              )}
            </div>
          </Flex>
        </Card>
      )}

      <Card title="현재 적용 품목">
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          columns={lineColumns}
          dataSource={detail?.lines ?? []}
          scroll={{ x: 700 }}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={4}>
                <Typography.Text strong>품목 합계</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <Typography.Text strong>
                  {formatKrw((detail?.lines ?? []).reduce((s, l) => s + l.amount, 0))}
                </Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} />
            </Table.Summary.Row>
          )}
        />
      </Card>

      <Card title="주문">
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={detail?.orders ?? []}
          locale={{ emptyText: '계약 확정 시 맞춤·렌탈 주문이 생성됩니다.' }}
          columns={[
            {
              title: '주문번호',
              dataIndex: 'orderNo',
              width: 160,
              render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
            },
            {
              title: '거래 방식',
              dataIndex: 'transactionType',
              width: 100,
              render: (v: TransactionType) => (
                <Tag color={TRANSACTION_TYPE_TAG_COLOR[v]}>{TRANSACTION_TYPE_LABEL[v]}</Tag>
              ),
            },
            {
              title: '상태',
              dataIndex: 'status',
              width: 110,
              render: (v: string) => {
                const meta = metaOf(ORDER_STATUS_META, v);
                return <StatusBadge label={meta.label} color={meta.color} />;
              },
            },
            {
              title: '',
              key: 'actions',
              render: (_, o) => (
                <Button type="link" onClick={() => navigate(`/orders/${o.id}`)}>
                  주문 상세
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card title="버전 목록">
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          columns={versionColumns}
          dataSource={versions ?? []}
          scroll={{ x: 700 }}
          rowClassName={(v) => (v.versionNo === detail?.currentVersionNo ? 'ant-table-row-selected' : '')}
        />
      </Card>

      {/* 변경 초안 생성 — 사유 필수 */}
      <Modal
        title="변경 초안 생성"
        open={revisionModalOpen}
        okText="초안 생성"
        cancelText="취소"
        okButtonProps={{ disabled: !revisionReason.trim() }}
        confirmLoading={createRevisionMutation.isPending}
        onOk={() => createRevisionMutation.mutate(revisionReason.trim())}
        onCancel={() => setRevisionModalOpen(false)}
      >
        <Flex vertical gap={8}>
          <Typography.Text>
            현재 적용 버전(v{detail?.currentVersionNo})을 복사해 변경 초안을 만듭니다. 품목·수량 변경은 변경
            계약에서만 가능합니다.
          </Typography.Text>
          <Typography.Text strong>
            변경 사유 <Typography.Text type="danger">*</Typography.Text>
          </Typography.Text>
          <Input.TextArea
            rows={3}
            value={revisionReason}
            maxLength={200}
            placeholder="예: 셔츠 1벌 추가 요청"
            onChange={(e) => setRevisionReason(e.target.value)}
          />
        </Flex>
      </Modal>

      {/* 계약 취소 — 사유 필수 */}
      <Modal
        title="계약 취소"
        open={cancelModalOpen}
        okText="계약 취소"
        okButtonProps={{ danger: true, disabled: !cancelReason.trim() }}
        cancelText="닫기"
        confirmLoading={cancelMutation.isPending}
        onOk={() => cancelMutation.mutate(cancelReason.trim())}
        onCancel={() => setCancelModalOpen(false)}
      >
        <Flex vertical gap={8}>
          <Alert
            type="warning"
            showIcon
            message="계약과 미진행 품목이 취소됩니다. 진행 이력이 있는 품목은 상태를 유지하며 별도 처리가 필요합니다."
          />
          <Typography.Text strong>
            취소 사유 <Typography.Text type="danger">*</Typography.Text>
          </Typography.Text>
          <Input.TextArea
            rows={3}
            value={cancelReason}
            maxLength={200}
            placeholder="취소 사유를 입력해 주세요."
            onChange={(e) => setCancelReason(e.target.value)}
          />
        </Flex>
      </Modal>

      {/* 변경 확정 결과 */}
      <Modal
        open={!!revisionResult}
        title="변경 계약이 확정되었습니다"
        footer={
          <Button type="primary" onClick={() => setRevisionResult(null)}>
            확인
          </Button>
        }
        onCancel={() => setRevisionResult(null)}
      >
        {/*
          응답에는 생성·취소된 품목 목록이 없다. 백엔드가 주는 값(적용 버전·변경 사유·영향 주문)만 보여준다.
          품목 단위 결과는 아래 주문 상세에서 확인한다 (docs/dev/08 §4).
        */}
        <Flex vertical gap={12}>
          <Typography.Text>
            계약 {revisionResult?.contractNo} · v{revisionResult?.versionNo} 버전이 적용되었습니다.
          </Typography.Text>
          <Typography.Text type="secondary">변경 사유: {revisionResult?.changeReason ?? '-'}</Typography.Text>
          <Typography.Text strong>영향 주문</Typography.Text>
          <List
            size="small"
            bordered
            dataSource={revisionResult?.orders ?? []}
            locale={{ emptyText: '변경된 주문이 없습니다.' }}
            renderItem={(o) => (
              <List.Item
                actions={[
                  <Button key="open" type="link" onClick={() => navigate(`/orders/${o.id}`)}>
                    주문 상세
                  </Button>,
                ]}
              >
                <Space>
                  <Tag color={TRANSACTION_TYPE_TAG_COLOR[o.tradeType]}>{TRANSACTION_TYPE_LABEL[o.tradeType]}</Tag>
                  <Typography.Text strong>{o.orderNo}</Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        </Flex>
      </Modal>
    </Flex>
  );
}
