/**
 * 계약 1:1 스타일 컨설팅 화면 — 계약의 맞춤·렌탈 품목을 부위(상의/하의/베스트) 단위 행으로 펼친다.
 * (설계서 04 §2 맞춤 부위별 원단·컬러·패턴 / §4 렌탈 부위별 컬러·사이즈·비고)
 *
 * - 맞춤 부위 행: 원단·컬러·패턴 수기 입력 → 부위별 attr 저장(작업지시서 엑셀 부위 칸으로 연결)
 * - 렌탈 부위 행: 비고만 수기, 조건(기간·컬러·사이즈)과 재고 선택은 [렌탈 검색] 팝업에서 한다
 * - 옵션 선택·렌탈 검색은 목록을 벗어나지 않도록 둘 다 팝업으로 띄운다.
 *
 * 2026-08-05 분해: 행 모델(consulting-rows) · 열 정의(consulting-columns) · 복사 팝업(CopyOptionsModal).
 */
import { FilePdfOutlined, RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Descriptions, Space, Spin, Table, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchContract, setVestIncluded } from '../../api/contracts';
import type { OptionProgressItem } from '../../api/options';
import { componentGroupLabel, copyOptionSession, fetchOptionProgress, startOptionSession } from '../../api/options';
import type { RentalComponentType } from '../../api/rentals';
import { fetchRentalSelectionProgress, saveRentalLine, startRentalSelection } from '../../api/rentals';
import { RentalCandidateModal } from '../rentals/RentalCandidateModal';
import { useRentalCodeNames } from '../rentals/rental-codes';
import { BackButton } from '../../shared/BackButton';
import { formatPhone } from '../../shared/phone';
import { PdfViewerModal } from '../../shared/PdfViewerModal';
import { StatusBadge } from '../../shared/StatusBadge';
import { buildConsultingColumns } from './consulting-columns';
import { groupByContract } from './OptionProgressListPage';
import {
  AttrDraft,
  buildComponentRows,
  ComponentRow,
  EMPTY_ATTR,
  EMPTY_RENTAL,
  RentalDraft,
} from './consulting-rows';
import { CopyOptionsModal } from './CopyOptionsModal';
import { OptionStageModal } from './OptionStageModal';

/** 원단 가격표(플레이스홀더). 실제 문서 URL로 교체 가능. */
const FABRIC_PRICE_PDF = '/sample-fabric-price.pdf';

export function ContractOptionsPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const { data: contract } = useQuery({
    queryKey: ['contracts', id],
    queryFn: () => fetchContract(id),
    enabled: !!id,
  });

  const customQuery = useQuery({
    queryKey: ['options', 'progress', id],
    queryFn: () => fetchOptionProgress(id),
    enabled: !!id,
  });

  const rentalQuery = useQuery({
    queryKey: ['rental-selection', 'progress', id],
    queryFn: () => fetchRentalSelectionProgress(id),
    enabled: !!id,
  });

  // 렌탈 행에 저장된 코드(BLACK/46)를 표시명으로 바꾼다. 조건 선택은 [렌탈 검색] 팝업이 맡고,
  // 목록은 이미 정해진 조건을 읽기만 한다.
  const rentalCodes = useRentalCodeNames();

  // 부위별 입력 초안 — 키는 `${contractItemId}:${부위}`
  const [attrDrafts, setAttrDrafts] = useState<Record<string, AttrDraft>>({});
  const [rentalDrafts, setRentalDrafts] = useState<Record<string, RentalDraft>>({});

  const [pdfOpen, setPdfOpen] = useState(false);
  const [copySource, setCopySource] = useState<OptionProgressItem | null>(null);
  const [copyTargetId, setCopyTargetId] = useState<string | null>(null);
  const [optionTarget, setOptionTarget] = useState<ComponentRow | null>(null);
  const [rentalTarget, setRentalTarget] = useState<ComponentRow | null>(null);

  const customItems = useMemo(() => customQuery.data ?? [], [customQuery.data]);
  const rentalItems = useMemo(() => rentalQuery.data ?? [], [rentalQuery.data]);

  // 서버 값이 들어오면 아직 손대지 않은 칸만 채운다(편집 중 값 덮어쓰기 방지).
  useEffect(() => {
    setAttrDrafts((prev) => {
      const next = { ...prev };
      for (const item of customItems)
        for (const c of item.components) {
          const key = `${item.contractItemId}:${c.componentGroup}`;
          if (!(key in next))
            next[key] = {
              fabricName: c.fabricName ?? '',
              colorName: c.colorName ?? '',
              patternName: c.patternName ?? '',
              notes: c.notes ?? '',
            };
        }
      return next;
    });
  }, [customItems]);

  // 렌탈은 컬러·사이즈가 읽기 전용이라(팝업에서만 바뀐다) 서버 값으로 항상 맞춘다 —
  // 비고만 이 화면에서 치므로 입력 중 덮어쓰지 않게 처음 한 번만 채운다.
  useEffect(() => {
    setRentalDrafts((prev) => {
      const next = { ...prev };
      for (const item of rentalItems)
        for (const c of item.components) {
          const key = `${item.contractItemId}:${c.contractItemComponentId}`;
          next[key] = {
            colorCode: c.colorCode,
            sizeCode: c.sizeCode,
            notes: key in next ? next[key].notes : (c.notes ?? ''),
          };
        }
      return next;
    });
  }, [rentalItems]);

  /**
   * 맞춤 부위 저장 — 세션 시작 API에 componentAttrs를 실어 보낸다.
   * 세션이 없으면 만들고, 있으면 그 부위만 upsert한다(한 번의 호출로 두 경우 모두 처리).
   * 서버는 부위 행 전체를 덮어쓰므로 초안 4개 필드를 함께 보낸다.
   */
  const attrMutation = useMutation({
    mutationFn: ({
      contractItemId,
      group,
      draft,
    }: {
      contractItemId: string;
      group: string;
      draft: AttrDraft;
      label: string;
    }) =>
      startOptionSession(contractItemId, undefined, [
        {
          componentGroup: group,
          fabricName: draft.fabricName.trim() || undefined,
          colorName: draft.colorName.trim() || undefined,
          patternName: draft.patternName.trim() || undefined,
          notes: draft.notes.trim() || undefined,
        },
      ]),
    onSuccess: (_res, vars) => {
      message.success(`${vars.label} 저장했습니다.`);
      void queryClient.invalidateQueries({ queryKey: ['options'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  /**
   * 렌탈 부위 저장 — 세션이 없으면 먼저 시작한 뒤 라인을 upsert한다.
   * 목록 인라인 편집은 낙관적 잠금 버전을 보내지 않는다(칸마다 저장돼 버전이 금방 낡는다).
   * 버전 검증이 필요한 확정 흐름은 렌탈 선택 화면에서 처리한다.
   */
  const rentalMutation = useMutation({
    mutationFn: async ({
      row,
      draft,
    }: {
      row: ComponentRow;
      draft: RentalDraft;
      label: string;
    }) => {
      let sessionId = row.sessionId ?? null;
      if (!sessionId) sessionId = (await startRentalSelection(row.contractItemId)).sessionId;
      return saveRentalLine(sessionId, row.contractItemComponentId!, {
        colorCode: draft.colorCode ?? undefined,
        sizeCode: draft.sizeCode ?? undefined,
        notes: draft.notes.trim() || undefined,
      });
    },
    onSuccess: (_res, vars) => {
      message.success(`${vars.label} 저장했습니다.`);
      void queryClient.invalidateQueries({ queryKey: ['rental-selection'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  /**
   * [베스트 제외] 체크박스 (현업 확정 2026-08-01) — 계약서가 아니라 여기서 벌마다 정한다.
   * 체크하면 그 벌의 베스트 부위가 빠지고(고른 베스트 옵션도 정리) 옵션·렌탈 버튼이 잠긴다.
   * 금액은 건드리지 않는다 — 베스트 값이 그때그때 달라 계약서에서 수기로 조정한다.
   */
  const vestMutation = useMutation({
    mutationFn: ({ contractItemId, included }: { contractItemId: string; included: boolean }) =>
      setVestIncluded(contractItemId, included),
    onSuccess: (res) => {
      message.success(
        res.vestIncluded
          ? `${res.displayName} 베스트를 다시 포함했습니다.`
          : `${res.displayName} 베스트를 제외했습니다. 계약 금액은 계약서에서 조정해 주세요.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['options'] });
      void queryClient.invalidateQueries({ queryKey: ['rental-selection'] });
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const copyMutation = useMutation({
    mutationFn: ({ sessionId, targetId }: { sessionId: string; targetId: string }) =>
      copyOptionSession(sessionId, targetId),
    onSuccess: () => {
      message.success('동일 옵션을 적용했습니다. 대상 품목에서 개별 수정이 가능합니다.');
      setCopySource(null);
      setCopyTargetId(null);
      void queryClient.invalidateQueries({ queryKey: ['options'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const copyTargets = (source: OptionProgressItem | null): OptionProgressItem[] =>
    customItems.filter(
      (row) =>
        source &&
        row.contractItemId !== source.contractItemId &&
        row.productCategory === source.productCategory &&
        row.status !== 'CONFIRMED' &&
        !row.inProduction,
    );

  // 맞춤 → 렌탈 순서로 품목을 이어 붙이고, 품목마다 부위 행으로 펼친다.
  const rows: ComponentRow[] = useMemo(
    () => buildComponentRows(customItems, rentalItems),
    [customItems, rentalItems],
  );

  // 헤더 상태 배지 — 리스트의 '스타일 컨설팅 상태'와 같은 판정을 쓰려고 groupByContract를
  // 그대로 재사용한다(단일 소스). 이 화면은 계약 1건이라 첫 행만 본다.
  const consulting = useMemo(
    () => groupByContract(customItems, rentalItems)[0] ?? null,
    [customItems, rentalItems],
  );

  const itemOf = (row: ComponentRow) =>
    customItems.find((i) => i.contractItemId === row.contractItemId) ?? null;

  const patchAttr = (key: string, field: keyof AttrDraft, value: string) =>
    setAttrDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_ATTR), [field]: value } }));

  const saveAttr = (row: ComponentRow) => {
    const draft = attrDrafts[row.key] ?? EMPTY_ATTR;
    const item = itemOf(row);
    const saved = item?.components.find((c) => c.componentGroup === row.group);
    const unchanged =
      draft.fabricName.trim() === (saved?.fabricName ?? '') &&
      draft.colorName.trim() === (saved?.colorName ?? '') &&
      draft.patternName.trim() === (saved?.patternName ?? '') &&
      draft.notes.trim() === (saved?.notes ?? '');
    if (unchanged) return;
    attrMutation.mutate({
      contractItemId: row.contractItemId,
      group: row.group,
      draft,
      label: `${row.displayName} ${componentGroupLabel(row.group)}`,
    });
  };

  const saveRental = (row: ComponentRow, draft: RentalDraft) =>
    rentalMutation.mutate({
      row,
      draft,
      label: `${row.displayName} ${componentGroupLabel(row.group)}`,
    });

  /**
   * 컨설팅 편집 가능 = 계약 작성중(DRAFT) (현업 확정 2026-07-31).
   * 서명완료·계약완료면 전체 보기 전용 — 수정하려면 계약 상세의 [수정하기]로 되돌린다.
   */
  const contractEditable = !contract || contract.status === 'DRAFT';

  /** 확정 세션·잠긴 계약·제작 진행 중 품목은 열람 전용. */
  const isLocked = (row: ComponentRow) =>
    row.status === 'CONFIRMED' || !contractEditable || row.inProduction === true;

  const columns = buildConsultingColumns({
    attrDrafts,
    rentalDrafts,
    rentalItems,
    rentalCodes,
    contractEditable,
    vestPending: vestMutation.isPending,
    isLocked,
    itemOf,
    copyTargets,
    patchAttr,
    saveAttr,
    patchRentalNotes: (key, value) =>
      setRentalDrafts((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? EMPTY_RENTAL), notes: value },
      })),
    saveRental,
    onVestToggle: (row, included) =>
      vestMutation.mutate({ contractItemId: row.contractItemId, included }),
    onOpenOption: setOptionTarget,
    onOpenRental: setRentalTarget,
    onOpenReview: (contractItemId) => navigate(`/options/${contractItemId}/review`),
    onCopy: setCopySource,
  });

  /** 고정 레이아웃의 표 전체 너비 — 열 정의의 width 합이라 열을 늘리면 같이 늘어난다. */
  const TABLE_WIDTH = columns.reduce((sum, c) => sum + (typeof c.width === 'number' ? c.width : 0), 0);

  const error = customQuery.error ?? rentalQuery.error;
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="스타일 컨설팅 목록을 불러오지 못했습니다."
        description={(error as Error).message}
      />
    );
  }

  const isLoading = customQuery.isLoading || rentalQuery.isLoading;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div>
              {/* 이름 라인: 고객명 + 컨설팅 상태 배지 */}
              <Space size={8} align="center" wrap style={{ marginBottom: 4 }}>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {contract?.customerName ?? ''}
                </Typography.Title>
                {consulting &&
                  (consulting.confirmedCount === consulting.itemCount ? (
                    <StatusBadge label="확정 완료" color="green" />
                  ) : (
                    <StatusBadge label="진행중" color="gold" />
                  ))}
              </Space>
              <div>
                {/* 계약번호는 아래 데이터 테이블에 있으므로 여기선 전화번호만 둔다. */}
                <Typography.Text type="secondary">
                  {contract?.customerPhone ? formatPhone(contract.customerPhone) : ''}
                </Typography.Text>
              </div>
            </div>
            {/* 기능 버튼은 화면 우상단 한 곳에 모은다 — 화면 이동은 하단에 둔다. */}
            <Button icon={<FilePdfOutlined />} onClick={() => setPdfOpen(true)}>
              원단 가격표
            </Button>
          </div>
          {contract && !contractEditable && (
            // 보기 전용은 '이 화면의 모드' 알림이라 이름 라인과 분리해 전폭 띠로 둔다.
            <Alert
              type="info"
              showIcon
              style={{ padding: '4px 12px' }}
              message={
                <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                  <div>서명완료·계약완료 상태라 스타일 컨설팅은 보기 전용입니다.</div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    수정하려면 계약 상세의 [수정하기]로 계약을 작성중으로 되돌린 뒤 진행해 주세요.
                  </Typography.Text>
                </div>
              }
            />
          )}
          {/* 파란 박스 자리 — 계약 요약을 표로 항상 띄운다(계약 상세와 같은 6개 항목). */}
          {contract && (
            <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} bordered>
              <Descriptions.Item label="계약번호">{contract.contractNo || '-'}</Descriptions.Item>
              <Descriptions.Item label="계약 구분">{contract.contractTypeName || '-'}</Descriptions.Item>
              <Descriptions.Item label="계약일">{contract.contractedAt ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="촬영일">{contract.photoDate ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="예식일">{contract.weddingDate ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="완료 예정일">{contract.completionDueDate ?? '-'}</Descriptions.Item>
            </Descriptions>
          )}
          {isLoading ? (
            <Spin style={{ display: 'block', margin: '48px auto' }} />
          ) : (
            <Table<ComponentRow>
              rowKey="key"
              // 열 너비를 칸 내용에 맡기면(x: 'max-content') 원단·비고를 칠 때마다 표가 흔들린다.
              // 지정한 width 합(=TABLE_WIDTH)으로 고정해 입력 중에도 열이 움직이지 않게 한다.
              tableLayout="fixed"
              scroll={{ x: TABLE_WIDTH }}
              dataSource={rows}
              columns={columns}
              pagination={false}
              locale={{ emptyText: '이 계약에는 맞춤·렌탈 품목이 없습니다.' }}
            />
          )}
        </Space>
      </Card>

      {/* 하단은 화면 이동 전용 — 왼쪽은 온 곳으로, 오른쪽은 유상 옵션·합계가 반영된 진행중 계약으로. */}
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <BackButton />
          <Button
            type="primary"
            disabled={!contract}
            onClick={() => navigate(`/contracts/new?contractId=${id}`)}
          >
            진행중 계약으로 <RightOutlined />
          </Button>
        </Space>
      </Card>

      <PdfViewerModal
        open={pdfOpen}
        url={FABRIC_PRICE_PDF}
        title="원단 가격표"
        onClose={() => setPdfOpen(false)}
      />

      {optionTarget && (
        <OptionStageModal
          open
          contractItemId={optionTarget.contractItemId}
          componentGroup={optionTarget.group}
          title={`${optionTarget.displayName} · ${componentGroupLabel(optionTarget.group)} 옵션`}
          onClose={() => setOptionTarget(null)}
        />
      )}

      {rentalTarget && (
        <RentalCandidateModal
          open
          contractItemId={rentalTarget.contractItemId}
          contractItemComponentId={rentalTarget.contractItemComponentId!}
          title={`${rentalTarget.displayName} · ${componentGroupLabel(rentalTarget.group)} 렌탈 검색`}
          componentType={rentalTarget.group as RentalComponentType}
          colorCode={rentalDrafts[rentalTarget.key]?.colorCode ?? null}
          sizeCode={rentalDrafts[rentalTarget.key]?.sizeCode ?? null}
          selectedInventoryItemId={
            rentalItems
              .find((i) => i.contractItemId === rentalTarget.contractItemId)
              ?.components.find(
                (c) => c.contractItemComponentId === rentalTarget.contractItemComponentId,
              )?.selectedInventoryItemId ?? null
          }
          onClose={() => setRentalTarget(null)}
        />
      )}

      <CopyOptionsModal
        source={copySource}
        targets={copyTargets(copySource)}
        targetId={copyTargetId}
        pending={copyMutation.isPending}
        onSelect={setCopyTargetId}
        onCancel={() => {
          setCopySource(null);
          setCopyTargetId(null);
        }}
        onApply={() => {
          if (copySource?.sessionId && copyTargetId)
            copyMutation.mutate({ sessionId: copySource.sessionId, targetId: copyTargetId });
        }}
      />
    </Space>
  );
}
