import {
  CheckOutlined,
  DeleteOutlined,
  DiffOutlined,
  EditOutlined,
  FileExcelOutlined,
  HighlightOutlined,
  SkinOutlined,
  StopOutlined,
  ToolOutlined,
} from '@ant-design/icons';
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
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useModeStore } from '../../app/mode-store';
import {
  cancelContract,
  confirmContractRevision,
  createContractRevision,
  deleteContract,
  downloadContractExcel,
  fetchContract,
  fetchContractVersions,
  getSignature,
  saveSignature,
  type ContractVersion,
  type ProductCategory,
  type RevisionConfirmResult,
  type TransactionType,
} from '../../api/contracts';
import { BackButton } from '../../shared/BackButton';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { ContractDocumentView } from './ContractDocumentView';
import {
  ContractLineEditor,
  createLine,
  linesTotal,
  THOUSANDS,
  type EditableLine,
} from './ContractLineEditor';
import { ContractSignPad } from './ContractSignPad';
import {
  CONTRACT_STATUS_META,
  CONTRACT_VERSION_STATUS_META,
  formatKrw,
  metaOf,
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

/** 비교에 필요한 최소 형태 — 저장된 버전 라인(ContractLine)과 편집 중 라인(EditableLine) 모두 만족한다. */
interface ComparableLine {
  transactionType: TransactionType;
  productCategory: ProductCategory;
  quantity: number;
  amount: number;
}

function aggregate(lines: ComparableLine[]) {
  const map = new Map<string, { qty: number; amount: number }>();
  for (const l of lines) {
    const key = `${l.transactionType}|${l.productCategory}`;
    const cur = map.get(key) ?? { qty: 0, amount: 0 };
    map.set(key, { qty: cur.qty + l.quantity, amount: cur.amount + l.amount });
  }
  return map;
}

function buildCompareRows(before: ComparableLine[], after: ComparableLine[]): CompareRow[] {
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

  // 고객모드에서 들어온 계약 상세에는 버전 이력을 노출하지 않는다 (고객 화면은 최종 계약서만).
  const customerMode = useModeStore((s) => s.mode) === 'CUSTOMER';

  // 버전 상태 필드는 versionStatus 다 (status 아님).
  // 변경 초안 편집기는 '변경할 수 있는 계약'에만 띄운다. 작성 중(DRAFT)·취소된 계약에도 v1이
  // DRAFT로 남아 있는데, 이걸 변경 초안으로 취급하면 계약서 + 편집기로 화면이 쪼개진다.
  const revisable = detail?.status === 'CONFIRMED' || detail?.status === 'CHANGED';
  const draftRevision = revisable ? versions?.find((v) => v.versionStatus === 'DRAFT') : undefined;
  const baseline = versions?.find(
    (v) => v.versionNo === detail?.currentVersionNo && v.versionStatus === 'CONFIRMED',
  );

  // 버전 목록에서 고른 버전 — 목록 하단에 그 버전의 변경 전후를 편다.
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  // 변경 초안 품목 편집 상태
  const [revLines, setRevLines] = useState<EditableLine[]>([]);
  const [revManualTotal, setRevManualTotal] = useState(false);
  const [revManualAmount, setRevManualAmount] = useState(0);
  const [revDirty, setRevDirty] = useState(false);

  useEffect(() => {
    if (!draftRevision) {
      setRevLines([]);
      setRevDirty(false);
      return;
    }
    const loaded = draftRevision.lines.map((l) =>
      createLine({
        id: l.id,
        transactionType: l.transactionType,
        productCategory: l.productCategory,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        note: l.note,
      }),
    );
    setRevLines(loaded);
    // 저장된 합계가 품목 합계와 다르면(할인 등) 직접 입력 모드로 열어 그 값을 지킨다.
    setRevManualAmount(draftRevision.totalAmount);
    setRevManualTotal(draftRevision.totalAmount > 0 && draftRevision.totalAmount !== linesTotal(loaded));
    setRevDirty(false);
  }, [draftRevision?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useUnsavedWarning(revDirty);

  const compareRows = useMemo(
    () => (draftRevision ? buildCompareRows(baseline?.lines ?? [], revLines) : []),
    [draftRevision, baseline, revLines],
  );
  const createdPreview = compareRows.filter((r) => r.afterQty > r.beforeQty);
  const cancelledPreview = compareRows.filter((r) => r.afterQty < r.beforeQty);
  // 선택 버전 ↔ 직전 버전 비교 (버전 목록 하단)
  const orderedVersions = useMemo(
    () => [...(versions ?? [])].sort((a, b) => a.versionNo - b.versionNo),
    [versions],
  );
  // 한 번이라도 확정된 적이 있는 계약인지 — DRAFT 버전을 '작성중'으로 부를지 가른다.
  const hasConfirmedVersion = orderedVersions.some((v) => v.versionStatus !== 'DRAFT');
  const selectedVersion = orderedVersions.find((v) => v.id === selectedVersionId) ?? null;
  const previousVersion = selectedVersion
    ? ([...orderedVersions].reverse().find((v) => v.versionNo < selectedVersion.versionNo) ?? null)
    : null;
  const versionCompareRows = useMemo(
    () => (selectedVersion ? buildCompareRows(previousVersion?.lines ?? [], selectedVersion.lines) : []),
    [selectedVersion, previousVersion],
  );

  const revLineTotal = linesTotal(revLines);
  // 합계 금액은 품목 합계 자동. [직접 입력]을 켰을 때만 수기 값을 쓴다.
  const revTotal = revManualTotal ? revManualAmount : revLineTotal;
  const revDiff = revTotal - revLineTotal;

  // 변경 사유·취소 사유 입력 모달
  const [revisionModalOpen, setRevisionModalOpen] = useState(false);
  const [revisionReason, setRevisionReason] = useState('');
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [revisionResult, setRevisionResult] = useState<RevisionConfirmResult | null>(null);
  const [signOpen, setSignOpen] = useState(false);

  const onApiError = (e: unknown) => {
    message.error(e instanceof ApiError ? e.message : '처리 중 오류가 발생했습니다.');
  };

  // 변경계약도 서명이 확정 전제조건이다 (설계서 v2 03 §2.5). 변경 초안 버전의 서명 상태를 추적한다.
  const signatureQuery = useQuery({
    queryKey: ['contracts', id, 'signature', draftRevision?.id],
    queryFn: () => getSignature(id, draftRevision!.id),
    enabled: !!draftRevision?.id,
  });
  const revSigned = !!signatureQuery.data?.signed;

  const signMutation = useMutation({
    mutationFn: (input: { imageDataUrl: string; signerName: string }) =>
      saveSignature(id, draftRevision!.id, { ...input, version: detail?.version }),
    onSuccess: () => {
      setSignOpen(false);
      message.success('서명이 저장되었습니다. 변경 확정이 가능합니다.');
      void queryClient.invalidateQueries({ queryKey: ['contracts', id, 'signature'] });
    },
    onError: onApiError,
  });

  const excelMutation = useMutation({
    mutationFn: () => downloadContractExcel(id, detail!.contractNo),
    onError: onApiError,
  });

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
        // 계약금 입력은 없앴다. 기존 버전에 저장된 값을 그대로 이어 보낸다.
        depositAmount: draftRevision?.depositAmount ?? 0,
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

  // 삭제는 임시저장·취소 계약 한정 (진행 이력이 있으면 서버가 막는다).
  const deleteMutation = useMutation({
    mutationFn: () => deleteContract(id),
    onSuccess: (result) => {
      message.success(`계약 ${result.contractNo}을(를) 삭제했습니다.`);
      invalidateAll();
      navigate('/contracts', { replace: true });
    },
    onError: onApiError,
  });

  const handleDelete = () => {
    modal.confirm({
      title: '계약 삭제',
      okText: '삭제',
      okButtonProps: { danger: true },
      cancelText: '닫기',
      content: (
        <Flex vertical gap={8}>
          <Typography.Text>
            계약 {detail?.contractNo}과(와) 그 버전·품목을 완전히 삭제합니다. 되돌릴 수 없습니다.
          </Typography.Text>
          <Typography.Text type="secondary">
            작업지시서·렌탈 배정 등 진행 이력이 남아 있으면 삭제되지 않습니다.
          </Typography.Text>
        </Flex>
      ),
      onOk: async () => {
        await deleteMutation.mutateAsync();
      },
    });
  };

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
    if (!revSigned) {
      message.error('먼저 [서명하기]로 서명을 완료해 주세요. 변경계약도 재서명이 필요합니다.');
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
          {revManualTotal && revDiff !== 0 && (
            <Alert
              type="warning"
              showIcon
              message={`직접 입력한 합계 금액이 품목 합계(${formatKrw(revLineTotal)})와 ${formatKrw(
                Math.abs(revDiff),
              )} 차이납니다.`}
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
  // 삭제는 아직 확정되지 않았거나(임시저장) 이미 취소된 계약만 — 확정 계약은 취소로만 정리한다.
  const canDelete = detail?.status === 'DRAFT' || detail?.status === 'CANCELLED';

  const versionColumns: ColumnsType<ContractVersion> = [
    {
      title: '버전',
      dataIndex: 'versionNo',
      width: 90,
      render: (v: number, record) => (
        <Space size={4}>
          <Typography.Text strong>v{v}</Typography.Text>
          {/* 작업 중 여부는 옆 [상태] 열이 말한다. 여기서는 지금 적용 중인 버전만 표시. */}
          {v === detail?.currentVersionNo && record.versionStatus !== 'DRAFT' && (
            <Tag color="green">현재 적용</Tag>
          )}
        </Space>
      ),
    },
    {
      title: '상태',
      dataIndex: 'versionStatus',
      width: 110,
      render: (v: string) => {
        // 확정된 적이 없는 계약의 DRAFT 버전은 '변경 초안'이 아니라 작성 중인 계약서다.
        if (v === 'DRAFT' && !hasConfirmedVersion) {
          return <StatusBadge label="작성중" color="gold" />;
        }
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
            <Button
              icon={<FileExcelOutlined />}
              loading={excelMutation.isPending}
              disabled={!detail}
              onClick={() => excelMutation.mutate()}
            >
              Excel 출력
            </Button>
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
            {canRevise && (
              <Button
                type="primary"
                icon={<SkinOutlined />}
                onClick={() => navigate(`/contracts/${id}/options`)}
              >
                스타일 컨설팅
              </Button>
            )}
            {canRevise && (
              <Button icon={<ToolOutlined />} onClick={() => navigate(`/contracts/${id}/production`)}>
                제작·입출고
              </Button>
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
            {canDelete && (
              <Can permission="CONTRACT_DELETE">
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  loading={deleteMutation.isPending}
                  onClick={handleDelete}
                >
                  계약 삭제
                </Button>
              </Can>
            )}
          </Space>
        </Flex>

        {/*
          금액(합계·계약금/잔금)은 아래 계약서 카드의 요약에서만 보여준다. 여기서 또 쓰면
          같은 숫자가 두 번 나오고, 3열 표에 빈 칸이 남는다.
          계약 비고 필드는 백엔드 스키마에 없어 표시하지 않는다 (docs/dev/08 §4).
        */}
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} bordered>
          <Descriptions.Item label="고객">{detail?.customerName}</Descriptions.Item>
          <Descriptions.Item label="계약 구분">{detail?.contractTypeName}</Descriptions.Item>
          <Descriptions.Item label="계약일">{detail?.contractedAt ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="완료 예정일">{detail?.completionDueDate ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="촬영일">{detail?.photoDate ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="예식일">{detail?.weddingDate ?? '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      {/* 계약서 웹 표시 — 품목(벌) × 부위 × 유료옵션 계층·서명 상태 (설계서 v2 03 §6) */}
      {id && <ContractDocumentView contractId={id} />}

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
            <Space wrap>
              {revSigned ? (
                <StatusBadge label="서명 완료" color="green" />
              ) : (
                <StatusBadge label="미서명" color="gold" />
              )}
              <Can permission="CONTRACT_SIGN">
                <Button icon={<HighlightOutlined />} onClick={() => setSignOpen(true)}>
                  {revSigned ? '다시 서명' : '서명하기'}
                </Button>
              </Can>
              <Can permission="CONTRACT_REVISE">
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={confirmRevisionMutation.isPending}
                  disabled={!revSigned}
                  onClick={handleConfirmRevision}
                >
                  변경 확정
                </Button>
              </Can>
            </Space>
          }
        >
          <Flex vertical gap={16}>
            <Alert type="info" showIcon message={`변경 사유: ${draftRevision.changeReason ?? '-'}`} />
            {revSigned && revDirty && (
              <Alert
                type="warning"
                showIcon
                message="품목을 변경했습니다. 확정 전 다시 서명하는 것을 권장합니다."
              />
            )}
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
            {/* 합계 금액은 품목 합계 자동. 할인 등으로 조정할 때만 [직접 입력]을 켠다. */}
            <Flex justify="space-between" align="flex-end" wrap gap={16}>
              <Flex vertical gap={4}>
                <Typography.Text type="secondary">합계 금액 (변경 후)</Typography.Text>
                {revManualTotal ? (
                  <InputNumber
                    className="num-input"
                    size="large"
                    min={0}
                    step={100000}
                    style={{ width: 220, fontWeight: 700 }}
                    value={revManualAmount}
                    formatter={THOUSANDS}
                    onChange={(v) => {
                      setRevManualAmount(v ?? 0);
                      setRevDirty(true);
                    }}
                  />
                ) : (
                  <Typography.Title level={3} style={{ margin: 0 }}>
                    {formatKrw(revLineTotal)}
                  </Typography.Title>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {revManualTotal
                    ? `품목 합계 ${formatKrw(revLineTotal)} · 품목을 고쳐도 이 금액은 따라가지 않습니다`
                    : `품목 ${revLines.length}건 자동 합계`}
                </Typography.Text>
              </Flex>
              <Space size={8}>
                <Typography.Text type="secondary">직접 입력</Typography.Text>
                <Switch
                  size="small"
                  checked={revManualTotal}
                  onChange={(on) => {
                    setRevManualTotal(on);
                    if (on) setRevManualAmount(revLineTotal);
                    setRevDirty(true);
                  }}
                />
              </Space>
            </Flex>
            {revManualTotal && revDiff !== 0 && (
              <Alert
                type={revDiff < 0 ? 'info' : 'warning'}
                showIcon
                message={`계약 금액이 품목 합계보다 ${formatKrw(Math.abs(revDiff))} ${
                  revDiff < 0 ? '적습니다 (할인)' : '많습니다 (추가)'
                }`}
                description="의도한 금액이면 그대로 두세요."
                action={
                  <Button
                    size="small"
                    onClick={() => {
                      // 불일치를 한 번에 해소: 품목 합계로 되돌리고 자동 모드로 복귀한다.
                      setRevManualAmount(revLineTotal);
                      setRevManualTotal(false);
                      setRevDirty(true);
                    }}
                  >
                    품목 합계로 맞추기
                  </Button>
                }
              />
            )}

            {/*
              변경 전후 비교·영향 미리보기는 화면에 상시 펴지 않는다.
              전후 내용은 [버전 목록]에서 버전을 눌러 보고, 생성·취소 품목은 확정 직전 확인 창에서 알린다.
            */}
          </Flex>
        </Card>
      )}

      {/*
        계약 상세는 최종 계약 내용만 보여준다(위 계약서 카드).
        품목 표·주문 목록은 각각 계약서 카드와 제작·입출고 화면에서 본다.
        버전 이력은 관리자 화면에서만, 그것도 고른 버전의 전후만 아래에 편다.
      */}
      {!customerMode && (
        <Card title="버전 목록">
          <Flex vertical gap={12}>
            <Typography.Text type="secondary">
              버전을 누르면 그 버전의 변경 전후 내용을 아래에 표시합니다.
            </Typography.Text>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              columns={versionColumns}
              dataSource={orderedVersions}
              scroll={{ x: 'max-content' }}
              onRow={(v) => ({
                onClick: () => setSelectedVersionId((cur) => (cur === v.id ? null : v.id)),
                style: { cursor: 'pointer' },
              })}
              rowClassName={(v) => (v.id === selectedVersionId ? 'ant-table-row-selected' : '')}
            />

            {selectedVersion && (
              <Flex vertical gap={8}>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  {previousVersion
                    ? `변경 전후 (v${previousVersion.versionNo} → v${selectedVersion.versionNo})`
                    : `최초 계약 내용 (v${selectedVersion.versionNo})`}
                </Typography.Title>
                <Typography.Text type="secondary">
                  변경 사유: {selectedVersion.changeReason ?? '-'}
                </Typography.Text>
                <Table
                  rowKey="key"
                  size="small"
                  pagination={false}
                  columns={compareColumns}
                  dataSource={versionCompareRows}
                  scroll={{ x: 'max-content' }}
                  locale={{ emptyText: '품목 내용이 없습니다.' }}
                />
                <Flex justify="flex-end" align="center" gap={12} wrap>
                  <Typography.Text type="secondary">
                    합계 금액 {formatKrw(previousVersion?.totalAmount ?? 0)} →{' '}
                    {formatKrw(selectedVersion.totalAmount)}
                  </Typography.Text>
                  <DiffText
                    diff={selectedVersion.totalAmount - (previousVersion?.totalAmount ?? 0)}
                    formatter={formatKrw}
                  />
                </Flex>
              </Flex>
            )}
          </Flex>
        </Card>
      )}

      {/* 목록·고객 상세·칸반 등 여러 경로로 들어오므로 뒤로가기로 통일 */}
      <Card>
        <BackButton />
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

      {/* 변경계약 서명 캔버스 — 열 때마다 새로 마운트 */}
      <Modal
        open={signOpen}
        title="변경계약 서명"
        footer={null}
        width={680}
        destroyOnClose
        maskClosable={false}
        onCancel={() => setSignOpen(false)}
      >
        {draftRevision && (
          <ContractSignPad
            defaultSignerName={detail?.customerName}
            saving={signMutation.isPending}
            onCancel={() => setSignOpen(false)}
            onSave={(imageDataUrl, signerName) => signMutation.mutate({ imageDataUrl, signerName })}
          />
        )}
      </Modal>
    </Flex>
  );
}
