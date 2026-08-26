import {
  CheckOutlined,
  ColumnHeightOutlined,
  DeleteOutlined,
  DiffOutlined,
  FileExcelOutlined,
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
  Modal,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useModeStore } from '../../app/mode-store';
import {
  cancelContract,
  createContractRevision,
  deleteContract,
  downloadContractExcel,
  fetchContract,
  completeContract,
  fetchContractFlow,
  fetchContractVersions,
  removeSignature,
  type ContractVersion,
  type ProductCategory,
  type TransactionType,
} from '../../api/contracts';
import { BackButton } from '../../shared/BackButton';
import { formatPhone } from '../../shared/phone';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { ContractDocumentView } from './ContractDocumentView';
import {
  CONTRACT_STATUS_META,
  CONTRACT_VERSION_STATUS_META,
  formatKrw,
  metaOf,
  PRODUCT_CATEGORY_LABEL,
  TRANSACTION_TYPE_LABEL,
  TRANSACTION_TYPE_TAG_COLOR,
} from './labels';
import { usePageTitle } from '../../shared/page-title-store';

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
    // 컨설팅 옵션 반영 후 상세 재진입 시 항상 최신값을 다시 불러온다 (전역 staleTime 30초 우회).
    refetchOnMount: 'always',
  });

  const { data: versions } = useQuery({
    queryKey: ['contracts', id, 'versions'],
    queryFn: () => fetchContractVersions(id),
    enabled: !!id,
  });

  // 고객모드에서 들어온 계약 상세에는 버전 이력을 노출하지 않는다 (고객 화면은 최종 계약서만).
  const customerMode = useModeStore((s) => s.mode) === 'CUSTOMER';

  // 버전 목록에서 고른 버전 — 목록 하단에 그 버전의 변경 전후를 편다.
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

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

  // 변경 사유·취소 사유 입력 모달
  const [revisionModalOpen, setRevisionModalOpen] = useState(false);
  const [revisionReason, setRevisionReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const onApiError = (e: unknown) => {
    message.error(e instanceof ApiError ? e.message : '처리 중 오류가 발생했습니다.');
  };

  /**
   * 계약 흐름 게이팅 (현업 확정 2026-07-30).
   * 작성중(수정·컨설팅·서명) → 서명완료 → 계약완료 → 수정하기(버전업) → 작성중 …
   * 서명은 작성 화면에서 받으므로 이 화면에는 [계약완료]·[수정하기]만 있다.
   */
  const flowQuery = useQuery({
    queryKey: ['contracts', id, 'flow'],
    queryFn: () => fetchContractFlow(id),
    enabled: !!id,
  });
  const flow = flowQuery.data;
  const invalidateFlow = () => {
    void queryClient.invalidateQueries({ queryKey: ['contracts', id, 'flow'] });
  };

  const completeMutation = useMutation({
    mutationFn: () => completeContract(id, { version: detail?.version }),
    onSuccess: (result) => {
      message.success(
        `계약이 완료되었습니다. 계약서 v${result.versionNo} 보관 · 주문 ${result.orders.length}건 생성.`,
      );
      invalidateFlow();
      invalidateAll();
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

  /**
   * 수정하기(버전업) — 계약서를 새 버전으로 복사하고 작성중으로 되돌린다.
   * 품목·컨설팅·주문·작업지시서·입출고는 그대로 이어지고, 곧바로 작성 화면으로 넘어간다.
   */
  const createRevisionMutation = useMutation({
    mutationFn: (reason: string) => createContractRevision(id, { changeReason: reason }),
    onSuccess: (revision) => {
      message.success(`v${revision.versionNo} 계약서를 만들었습니다. 수정 후 다시 서명해 주세요.`);
      setRevisionModalOpen(false);
      setRevisionReason('');
      invalidateAll();
      navigate(`/contracts/new?contractId=${id}`);
    },
    onError: onApiError,
  });

  /**
   * 수정하기(서명 해제) — 서명완료를 버전업 없이 작성중으로 되돌린다 (현업 확정 2026-07-31).
   * 계약완료의 수정하기(버전업)와 같은 라벨·위치로, 사용자는 두 기능을 구분하지 않는다.
   */
  const reopenMutation = useMutation({
    mutationFn: () => removeSignature(id, flowQuery.data!.currentVersionId!),
    onSuccess: () => {
      message.success('서명을 해제했습니다. 수정 후 다시 서명해 주세요.');
      invalidateFlow();
      invalidateAll();
      navigate(`/contracts/new?contractId=${id}`);
    },
    onError: onApiError,
  });

  const handleReopen = () => {
    modal.confirm({
      title: '계약서 수정하기',
      content: '서명을 해제하고 작성중으로 되돌립니다. 수정 후 다시 서명해야 합니다.',
      okText: '수정 시작',
      cancelText: '취소',
      onOk: () => reopenMutation.mutateAsync(),
    });
  };

  // 계약 취소 — 주문이 생기기 전(작성중·서명완료)에만. 취소는 종결 상태다.
  const cancelMutation = useMutation({
    mutationFn: () =>
      cancelContract(id, { reason: cancelReason.trim(), version: detail?.version ?? 1 }),
    onSuccess: () => {
      setCancelOpen(false);
      setCancelReason('');
      message.success('계약을 취소했습니다.');
      invalidateFlow();
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

  usePageTitle(detail?.contractNo ? `계약 ${detail.contractNo}` : null);

  /**
   * 작성중(DRAFT) 계약은 상세를 보여 주지 않는다 — 아직 작성 중인 계약서이므로
   * 곧바로 수정(작성) 화면으로 보낸다. 목록에서도 같은 곳으로 이동하지만,
   * 링크·뒤로가기 등 다른 경로로 들어온 경우를 여기서 받는다.
   * 고객모드는 예외 — 고객 화면에서 작성 폼을 열지는 않는다.
   */
  useEffect(() => {
    if (detail?.status === 'DRAFT' && !customerMode) {
      navigate(`/contracts/new?contractId=${detail.id}`, { replace: true });
    }
  }, [detail?.status, detail?.id, customerMode, navigate]);

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
  /** 완료된 계약만 제작·입출고로 이어진다 — 주문이 계약완료 시점에 생기기 때문. */
  const physicalized = detail?.status === 'COMPLETED';

  const handleComplete = () => {
    modal.confirm({
      title: '계약 완료',
      okText: '계약 완료',
      cancelText: '취소',
      width: 480,
      content: (
        <Flex vertical gap={8}>
          <Typography.Text>
            서명까지 끝난 계약서를 확정합니다. 완료 시점의 계약서 엑셀이 그대로 보관되며, 이후
            내려받는 계약서는 이 보관본입니다.
          </Typography.Text>
          {flow?.signerName && (
            <Typography.Text type="secondary">
              서명자: {flow.signerName}
              {flow.signedAt ? ` · ${flow.signedAt.slice(0, 16).replace('T', ' ')}` : ''}
            </Typography.Text>
          )}
        </Flex>
      ),
      onOk: async () => {
        await completeMutation.mutateAsync();
      },
    });
  };
  // 삭제는 취소된 계약만 — 오작성 정리용이다. 취소는 작성중 화면에서 한다.
  const canDelete = detail?.status === 'CANCELLED';

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
          <Flex vertical>
            <Space size={12} align="center">
              <Typography.Title level={4} style={{ margin: 0 }}>
                {detail?.customerName ?? '-'}
              </Typography.Title>
              <StatusBadge label={statusMeta.label} color={statusMeta.color} />
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatPhone(detail?.customerPhone)}
            </Typography.Text>
          </Flex>
          <Space wrap>
            <Button
              icon={<FileExcelOutlined />}
              loading={excelMutation.isPending}
              disabled={!detail}
              onClick={() => excelMutation.mutate()}
            >
              계약서 출력
            </Button>
            {/*
              헤더 우상단은 기능 버튼만 (현업 확정 2026-07-31).
              서명완료 → [계약완료]·[수정하기(서명 해제)]·[계약 취소(주문 없을 때)],
              계약완료 → [수정하기(버전업)]. 두 수정하기는 같은 라벨·위치 — 버전업 여부는 시스템만 안다.
              스타일 컨설팅·제작·입출고 이동은 화면 하단.
            */}
            {flow?.canComplete && (
              <Can permission="CONTRACT_CONFIRM">
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={completeMutation.isPending}
                  onClick={handleComplete}
                >
                  계약완료
                </Button>
              </Can>
            )}
            {flow?.canReopen && (
              <Can permission="CONTRACT_SIGN">
                <Tooltip title="서명을 해제하고 작성중으로 되돌립니다. 수정 후 다시 서명해야 합니다.">
                  <Button
                    type="primary"
                    icon={<DiffOutlined />}
                    loading={reopenMutation.isPending}
                    onClick={handleReopen}
                  >
                    수정하기
                  </Button>
                </Tooltip>
              </Can>
            )}
            {flow?.canCancel && (
              <Can permission="CONTRACT_CANCEL">
                <Button danger icon={<StopOutlined />} onClick={() => setCancelOpen(true)}>
                  계약 취소
                </Button>
              </Can>
            )}
            {flow?.canRevise && (
              <Can permission="CONTRACT_REVISE">
                <Tooltip title="계약서를 새 버전으로 복사해 다시 작성합니다. 컨설팅·제작 진행은 그대로 이어집니다.">
                  <Button
                    type="primary"
                    icon={<DiffOutlined />}
                    loading={createRevisionMutation.isPending}
                    onClick={() => setRevisionModalOpen(true)}
                  >
                    수정하기
                  </Button>
                </Tooltip>
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
          금액(품목 합계·총 계약금액)은 아래 계약서 카드의 요약에서만 보여준다. 여기서 또 쓰면
          같은 숫자가 두 번 나오고, 3열 표에 빈 칸이 남는다.
          계약 비고 필드는 백엔드 스키마에 없어 표시하지 않는다 (docs/dev/08 §4).
        */}
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} bordered>
          <Descriptions.Item label="계약 번호">{detail?.contractNo ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="계약 구분">{detail?.contractTypeName}</Descriptions.Item>
          <Descriptions.Item label="계약일">{detail?.contractedAt ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="촬영일">{detail?.photoDate ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="예식일">{detail?.weddingDate ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="완료 예정일">{detail?.completionDueDate ?? '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      {/* 계약서 웹 표시 — 품목(벌) × 부위 × 유료옵션 계층·서명 상태 (설계서 v2 03 §6) */}
      {id && <ContractDocumentView contractId={id} />}

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

      {/* 화면 하단은 이동 전용 — 기능 버튼은 헤더 우상단에 둔다 */}
      <Card>
        <Flex justify="space-between" align="center" wrap gap={12}>
          <BackButton />
          <Space wrap>
            <Button icon={<SkinOutlined />} onClick={() => navigate(`/contracts/${id}/options`)}>
              스타일 컨설팅으로 이동
            </Button>
            {/* 채촌·제작 모두 계약완료 후 이어진다 → 완료 계약에서만 해당 고객 채촌 화면으로 보낸다. */}
            {physicalized && detail?.customerId && (
              <Button
                type="primary"
                icon={<ColumnHeightOutlined />}
                onClick={() => navigate(`/measurements?customerId=${detail.customerId}`)}
              >
                채촌으로 이동
              </Button>
            )}
            {/* 주문은 계약완료 시점에 생긴다 → 그 전에는 제작·입출고로 갈 것이 없다. */}
            {physicalized && (
              <Button
                type="primary"
                icon={<ToolOutlined />}
                onClick={() => navigate(`/contracts/${id}/production`)}
              >
                제작·입출고로 이동
              </Button>
            )}
          </Space>
        </Flex>
      </Card>

      {/* 수정하기(버전업) — 사유 필수 */}
      <Modal
        title="계약서 수정하기"
        open={revisionModalOpen}
        okText="수정 시작"
        cancelText="취소"
        okButtonProps={{ disabled: !revisionReason.trim() }}
        confirmLoading={createRevisionMutation.isPending}
        onOk={() => createRevisionMutation.mutate(revisionReason.trim())}
        onCancel={() => setRevisionModalOpen(false)}
      >
        <Flex vertical gap={8}>
          <Typography.Text>
            현재 계약서(v{detail?.currentVersionNo})를 v{(detail?.currentVersionNo ?? 1) + 1}로 복사해 작성중
            상태로 되돌립니다. 컨설팅 선택·제작·입출고는 그대로 이어지고, 수량을 늘리면 늘어난 품목만 새로
            컨설팅합니다. 수정 후 다시 서명해야 합니다.
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

      {/* 계약 취소 — 주문이 생기기 전(작성중·서명완료)에만, 사유 필수. 취소는 종결 상태. */}
      <Modal
        open={cancelOpen}
        title="계약 취소"
        okText="계약 취소"
        okButtonProps={{ danger: true, disabled: !cancelReason.trim() }}
        cancelText="닫기"
        confirmLoading={cancelMutation.isPending}
        onOk={() => cancelMutation.mutate()}
        onCancel={() => setCancelOpen(false)}
      >
        <Flex vertical gap={12}>
          <Typography.Text>
            계약을 취소합니다. 취소한 계약은 되돌릴 수 없습니다. 취소 사유를 남겨 주세요.
          </Typography.Text>
          <Input.TextArea
            rows={3}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="예: 고객 요청으로 계약 진행 중단"
          />
        </Flex>
      </Modal>

    </Flex>
  );
}
