/**
 * 계약 1:1 스타일 컨설팅 화면 — 계약의 맞춤·렌탈 품목을 부위(상의/하의/베스트) 단위 행으로 펼친다.
 * (설계서 04 §2 맞춤 부위별 원단·컬러·패턴 / §4 렌탈 부위별 컬러·사이즈·비고)
 *
 * - 맞춤 부위 행: 원단·컬러·패턴 수기 입력 → 부위별 attr 저장(작업지시서 엑셀 부위 칸으로 연결)
 * - 렌탈 부위 행: 비고만 수기, 조건(기간·컬러·사이즈)과 재고 선택은 [렌탈 검색] 팝업에서 한다
 * - 옵션 선택·렌탈 검색은 목록을 벗어나지 않도록 둘 다 팝업으로 띄운다.
 */
import {
  CopyOutlined,
  EyeOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  MoreOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Input,
  Modal,
  Progress,
  Radio,
  Space,
  Spin,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchContract, setVestIncluded } from '../../api/contracts';
import type { OptionProgressItem } from '../../api/options';
import {
  componentGroupLabel,
  copyOptionSession,
  fetchOptionProgress,
  startOptionSession,
} from '../../api/options';
import type { RentalComponentType } from '../../api/rentals';
import {
  fetchRentalSelectionProgress,
  RENTAL_SELECTION_STATUS_META,
  saveRentalLine,
  startRentalSelection,
} from '../../api/rentals';
import { RentalCandidateModal } from '../rentals/RentalCandidateModal';
import { useRentalCodeNames } from '../rentals/rental-codes';
import { BackButton } from '../../shared/BackButton';
import { PdfViewerModal } from '../../shared/PdfViewerModal';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { OptionStageModal } from './OptionStageModal';
import { OPTION_STATUS_META } from './option-meta';

/** 원단 가격표(플레이스홀더). 실제 문서 URL로 교체 가능. */
const FABRIC_PRICE_PDF = '/sample-fabric-price.pdf';

/** 맞춤 부위 행의 수기 입력 초안 (원단·컬러·패턴·비고를 한 벌로 들고 있다) */
interface AttrDraft {
  fabricName: string;
  colorName: string;
  patternName: string;
  notes: string;
}
const EMPTY_ATTR: AttrDraft = { fabricName: '', colorName: '', patternName: '', notes: '' };

/** 렌탈 부위 행의 초안 */
interface RentalDraft {
  colorCode: string | null;
  sizeCode: string | null;
  notes: string;
}
const EMPTY_RENTAL: RentalDraft = { colorCode: null, sizeCode: null, notes: '' };

/** 목록의 한 행 = 품목 × 부위 하나. 품목 정보는 첫 행에만 rowSpan으로 붙인다. */
interface ComponentRow {
  key: string;
  kind: 'CUSTOM' | 'RENTAL';
  contractItemId: string;
  displayName: string;
  status: string;
  /** 품목 셀 rowSpan — 그 품목의 첫 행만 부위 수, 나머지는 0 */
  itemRowSpan: number;
  /** 부위 코드 (맞춤 componentGroup / 렌탈 componentType) */
  group: string;
  /** 베스트 부위가 이 벌에서 빠졌는가 — [베스트 제외] 체크 상태 (현업 확정 2026-08-01) */
  vestExcluded?: boolean;
  /** 제작 진행 중 품목 — 계약이 작성중이어도 편집 잠금 (맞춤 행만 내려온다) */
  inProduction?: boolean;
  // 맞춤
  sessionId?: string | null;
  completedStages?: number;
  totalStages?: number;
  // 렌탈
  contractItemComponentId?: string;
  colorName?: string | null;
  sizeName?: string | null;
  selectedItemCode?: string | null;
  rentalVersion?: number;
}

/**
 * 품목의 옵션 선택이 끝났는가 — 확인서 버튼 활성 기준.
 * 백엔드는 모든 활성 단계가 채워지면 세션을 REVIEW(이후 CONFIRMED)로 올리므로
 * 단계 수 비교와 상태 둘 중 하나만 맞아도 완료로 본다.
 */
function isOptionDone(item: OptionProgressItem): boolean {
  if (!item.sessionId) return false;
  if (item.status === 'REVIEW' || item.status === 'CONFIRMED') return true;
  return item.totalStages > 0 && item.completedStages >= item.totalStages;
}

// 렌탈 선택 상태 배지의 정본은 중앙 사전(RENTAL_SELECTION_STATUS_META)이다 — 사본을 걷어냈다.

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
  const rows: ComponentRow[] = useMemo(() => {
    const out: ComponentRow[] = [];
    for (const item of customItems) {
      // 부위 슬롯이 비는 카테고리라도 품목이 목록에서 사라지면 안 된다 — 부위 없는 한 행으로 둔다.
      const groups =
        item.components.length > 0
          ? item.components
          : [
              {
                componentGroup: '',
                fabricName: null,
                colorName: null,
                patternName: null,
                notes: null,
                completedStages: item.completedStages,
                totalStages: item.totalStages,
              },
            ];
      groups.forEach((c, i) => {
        out.push({
          key: `${item.contractItemId}:${c.componentGroup}`,
          kind: 'CUSTOM',
          contractItemId: item.contractItemId,
          displayName: item.displayName,
          status: item.status,
          itemRowSpan: i === 0 ? groups.length : 0,
          group: c.componentGroup,
          vestExcluded: c.excluded,
          inProduction: item.inProduction,
          sessionId: item.sessionId,
          completedStages: c.completedStages,
          totalStages: c.totalStages,
        });
      });
    }
    for (const item of rentalItems) {
      // 구성품이 아직 없는 렌탈 품목도 목록에는 보여야 한다(주문에서 구성품을 추가하면 채워진다).
      if (item.components.length === 0) {
        out.push({
          key: `${item.contractItemId}:none`,
          kind: 'RENTAL',
          contractItemId: item.contractItemId,
          displayName: item.displayName,
          status: item.status,
          itemRowSpan: 1,
          group: '',
          sessionId: item.sessionId,
          rentalVersion: item.version,
        });
        continue;
      }
      item.components.forEach((c, i) => {
        out.push({
          key: `${item.contractItemId}:${c.contractItemComponentId}`,
          kind: 'RENTAL',
          contractItemId: item.contractItemId,
          displayName: item.displayName,
          status: item.status,
          itemRowSpan: i === 0 ? item.components.length : 0,
          group: c.componentType,
          vestExcluded: c.excluded,
          sessionId: item.sessionId,
          contractItemComponentId: c.contractItemComponentId,
          colorName: c.colorName,
          sizeName: c.sizeName,
          selectedItemCode: c.selectedItemCode,
          rentalVersion: item.version,
        });
      });
    }
    return out;
  }, [customItems, rentalItems]);

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

  const spanCell = (row: ComponentRow) => ({ rowSpan: row.itemRowSpan });

  const columns: ColumnsType<ComponentRow> = [
    {
      title: '품목',
      key: 'item',
      width: 220,
      onCell: spanCell,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong style={{ fontSize: 15 }}>
            {row.displayName}
          </Typography.Text>
          <StatusBadge
            label={
              row.kind === 'CUSTOM'
                ? metaOf(OPTION_STATUS_META, row.status).label
                : metaOf(RENTAL_SELECTION_STATUS_META, row.status).label
            }
            color={
              row.kind === 'CUSTOM'
                ? metaOf(OPTION_STATUS_META, row.status).color
                : metaOf(RENTAL_SELECTION_STATUS_META, row.status).color
            }
          />
        </Space>
      ),
    },
    {
      title: '부위',
      key: 'group',
      width: 120,
      render: (_, row) => (
        <Typography.Text strong>{row.group ? componentGroupLabel(row.group) : '-'}</Typography.Text>
      ),
    },
    {
      // 맞춤은 원단(수기), 렌탈은 선택한 물품의 사이즈 — 부위 행의 첫 지정 항목이다.
      title: '원단 · 사이즈 (렌탈)',
      key: 'first',
      width: 240,
      render: (_, row) => {
        // 렌탈은 사이즈를 여기서 고르지 않는다 — [렌탈 검색] 팝업에서 고른 물품의 규격을 읽기만 한다.
        // 셀에서 고르면 고를 때마다 저장돼 토스트가 연달아 떴다 (현업 확정 2026-07-31).
        if (row.kind === 'RENTAL') {
          const draft = rentalDrafts[row.key] ?? EMPTY_RENTAL;
          return draft.sizeCode ? (
            <Typography.Text>{rentalCodes.sizeName(draft.sizeCode)}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">미지정</Typography.Text>
          );
        }
        const draft = attrDrafts[row.key] ?? EMPTY_ATTR;
        if (isLocked(row)) return <Typography.Text>{draft.fabricName || '-'}</Typography.Text>;
        return (
          <Input
            placeholder="원단명 (수기)"
            value={draft.fabricName}
            onChange={(e) => patchAttr(row.key, 'fabricName', e.target.value)}
            onBlur={() => saveAttr(row)}
            onPressEnter={() => saveAttr(row)}
          />
        );
      },
    },
    {
      title: '컬러 (렌탈)',
      key: 'second',
      width: 200,
      render: (_, row) => {
        // 렌탈은 고른 물품의 컬러를 읽기만 한다 — 변경은 [렌탈 검색] 팝업에서만 한다.
        if (row.kind === 'RENTAL') {
          const draft = rentalDrafts[row.key] ?? EMPTY_RENTAL;
          return draft.colorCode ? (
            <Typography.Text>{rentalCodes.colorName(draft.colorCode)}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">미지정</Typography.Text>
          );
        }
        const draft = attrDrafts[row.key] ?? EMPTY_ATTR;
        if (isLocked(row)) return <Typography.Text>{draft.colorName || '-'}</Typography.Text>;
        return (
          <Input
            placeholder="컬러 (수기)"
            value={draft.colorName}
            onChange={(e) => patchAttr(row.key, 'colorName', e.target.value)}
            onBlur={() => saveAttr(row)}
            onPressEnter={() => saveAttr(row)}
          />
        );
      },
    },
    {
      // 렌탈 비고는 수선 명령(수치 등)을 적는 칸이다 (설계서 04 §4.2).
      title: '패턴 · 비고(렌탈)',
      key: 'third',
      width: 220,
      render: (_, row) => {
        if (row.kind === 'RENTAL') {
          const draft = rentalDrafts[row.key] ?? EMPTY_RENTAL;
          const saved = rentalItems
            .find((i) => i.contractItemId === row.contractItemId)
            ?.components.find((c) => c.contractItemComponentId === row.contractItemComponentId);
          if (isLocked(row)) return <Typography.Text>{draft.notes || '-'}</Typography.Text>;
          return (
            <Input
              placeholder="비고 (수선 수치 등)"
              value={draft.notes}
              onChange={(e) =>
                setRentalDrafts((prev) => ({
                  ...prev,
                  [row.key]: { ...(prev[row.key] ?? EMPTY_RENTAL), notes: e.target.value },
                }))
              }
              onBlur={() => {
                if (draft.notes.trim() !== (saved?.notes ?? '')) saveRental(row, draft);
              }}
              onPressEnter={() => saveRental(row, draft)}
            />
          );
        }
        const draft = attrDrafts[row.key] ?? EMPTY_ATTR;
        if (isLocked(row)) return <Typography.Text>{draft.patternName || '-'}</Typography.Text>;
        return (
          <Input
            placeholder="패턴 (수기)"
            value={draft.patternName}
            onChange={(e) => patchAttr(row.key, 'patternName', e.target.value)}
            onBlur={() => saveAttr(row)}
            onPressEnter={() => saveAttr(row)}
          />
        );
      },
    },
    {
      title: '진행 · 선택 실물',
      key: 'progress',
      width: 190,
      render: (_, row) => {
        if (row.kind === 'RENTAL')
          return row.selectedItemCode ? (
            <Typography.Text strong>{row.selectedItemCode}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">미선택</Typography.Text>
          );
        const total = row.totalStages ?? 0;
        const done = row.completedStages ?? 0;
        if (total === 0) return <Typography.Text type="secondary">단계 없음</Typography.Text>;
        return (
          <Space>
            <Progress
              percent={Math.round((done / total) * 100)}
              size="small"
              style={{ width: 80 }}
              showInfo={false}
            />
            <Typography.Text>
              {done}/{total} 단계
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      /*
        베스트 행에만 붙는 [베스트 제외] 체크박스 (현업 확정 2026-08-01).
        계약 시점에는 3피스로 갈지 모르니 계약서는 베스트를 다루지 않고, 옷을 고르면서
        벌마다 여기서 정한다. 체크하면 옆의 옵션·렌탈 버튼이 잠긴다.
      */
      title: '베스트 제외',
      key: 'vest',
      width: 96,
      align: 'center',
      render: (_, row) =>
        row.group !== 'VEST' ? null : (
          <Tooltip title={contractEditable ? '' : '작성중인 계약에서만 바꿀 수 있습니다.'}>
            <span>
              <Checkbox
                checked={!!row.vestExcluded}
                disabled={!contractEditable || row.inProduction === true || vestMutation.isPending}
                aria-label={`${row.displayName} 베스트 제외`}
                onChange={(e) =>
                  vestMutation.mutate({
                    contractItemId: row.contractItemId,
                    included: !e.target.checked,
                  })
                }
              />
            </span>
          </Tooltip>
        ),
    },
    {
      title: '옵션',
      key: 'action',
      width: 150,
      render: (_, row) =>
        // 제외한 베스트는 고를 것이 없다 — 버튼 자리를 비우고 제외 상태만 남긴다.
        row.vestExcluded ? (
          <Typography.Text type="secondary">제외됨</Typography.Text>
        ) : row.kind === 'RENTAL' ? (
          <Tooltip title={contractEditable ? '' : '작성중인 계약에서만 실물을 변경할 수 있습니다.'}>
            <span>
              <Button
                type={row.selectedItemCode ? 'default' : 'primary'}
                icon={<SearchOutlined />}
                disabled={!row.contractItemComponentId || !contractEditable}
                onClick={() => setRentalTarget(row)}
              >
                렌탈 검색
              </Button>
            </span>
          </Tooltip>
        ) : (row.totalStages ?? 0) === 0 ? null : (
          // 잠긴 계약·제작 진행 중·확정 세션은 보기 모드로 연다 (편집은 서버도 막는다).
          <Tooltip title={row.inProduction ? '제작 진행 중인 품목은 옵션을 변경할 수 없습니다.' : ''}>
            <Button
              type={isLocked(row) ? 'default' : 'primary'}
              icon={isLocked(row) ? <EyeOutlined /> : undefined}
              onClick={() => setOptionTarget(row)}
            >
              {isLocked(row) ? '옵션 보기' : '옵션 선택'}
            </Button>
          </Tooltip>
        ),
    },
    {
      // 확인서는 부위가 아니라 품목 단위다 — 품목 첫 행에 rowSpan으로 한 번만 붙인다.
      // 렌탈 품목의 확인서는 렌탈 선택 화면이 담당하므로 여기서는 맞춤만 낸다.
      title: '확인서',
      key: 'review',
      width: 130,
      onCell: spanCell,
      render: (_, row) => {
        if (row.kind === 'RENTAL') return null;
        const item = itemOf(row);
        if (!item) return null;
        const done = isOptionDone(item);
        return (
          // 비활성 버튼은 마우스 이벤트를 삼켜 툴팁이 안 뜬다 — span으로 감싸 안내를 살린다.
          <Tooltip title={done ? '' : '모든 옵션 단계를 선택하면 확인서를 볼 수 있습니다.'}>
            <span>
              <Button
                icon={<FileTextOutlined />}
                disabled={!done}
                onClick={() => navigate(`/options/${item.contractItemId}/review`)}
              >
                확인서 보기
              </Button>
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: '',
      key: 'more',
      width: 56,
      onCell: spanCell,
      render: (_, row) => {
        const item = itemOf(row);
        const canCopy = contractEditable && !!item?.sessionId && copyTargets(item).length > 0;
        return (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'copy',
                  icon: <CopyOutlined />,
                  label: '동일 옵션 적용',
                  disabled: !canCopy,
                  onClick: () => item && setCopySource(item),
                },
              ],
            }}
          >
            <Button type="text" icon={<MoreOutlined />} />
          </Dropdown>
        );
      },
    },
  ];

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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <Typography.Title level={4} style={{ marginBottom: 4 }}>
                스타일 컨설팅 — {contract?.customerName ?? ''}
              </Typography.Title>
              <Typography.Text type="secondary">
                {[contract?.customerPhone, contract?.contractNo].filter(Boolean).join(' · ')}
              </Typography.Text>
            </div>
            {/* 기능 버튼은 화면 우상단 한 곳에 모은다 — 화면 이동은 하단에 둔다. */}
            <Button icon={<FilePdfOutlined />} onClick={() => setPdfOpen(true)}>
              원단 가격표
            </Button>
          </div>
          {contract && !contractEditable && (
            <Alert
              type="info"
              showIcon
              message="서명완료·계약완료 상태라 스타일 컨설팅은 보기 전용입니다."
              description="수정하려면 계약 상세의 [수정하기]로 계약을 작성중으로 되돌린 뒤 진행해 주세요."
            />
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

      {/* 하단은 화면 이동 전용 — 왼쪽은 온 곳으로, 오른쪽은 다음 목적지(이 계약자의 채촌). */}
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <BackButton />
          <Button
            size="large"
            style={{ height: 56, minWidth: 140, fontSize: 18 }}
            disabled={!contract}
            onClick={() => navigate(`/measurements?customerId=${contract?.customerId}`)}
          >
            채촌으로 <RightOutlined />
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

      <Modal
        title={`동일 옵션 적용 — ${copySource?.displayName ?? ''}`}
        open={!!copySource}
        onCancel={() => {
          setCopySource(null);
          setCopyTargetId(null);
        }}
        okText="적용"
        cancelText="취소"
        okButtonProps={{ disabled: !copyTargetId, loading: copyMutation.isPending }}
        onOk={() => {
          if (copySource?.sessionId && copyTargetId)
            copyMutation.mutate({ sessionId: copySource.sessionId, targetId: copyTargetId });
        }}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text>
            선택값을 복사할 동일 대분류 품목을 선택하세요. 적용 후 개별 수정이 가능합니다.
          </Typography.Text>
          <Radio.Group
            value={copyTargetId}
            onChange={(e) => setCopyTargetId(e.target.value as string)}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {copyTargets(copySource).map((t) => (
              <Radio key={t.contractItemId} value={t.contractItemId} style={{ minHeight: 40, alignItems: 'center' }}>
                <Space>
                  <Typography.Text strong>{t.displayName}</Typography.Text>
                  <StatusBadge
                    label={metaOf(OPTION_STATUS_META, t.status).label}
                    color={metaOf(OPTION_STATUS_META, t.status).color}
                  />
                </Space>
              </Radio>
            ))}
          </Radio.Group>
        </Space>
      </Modal>
    </Space>
  );
}
