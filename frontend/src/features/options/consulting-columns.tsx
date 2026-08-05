/**
 * 스타일 컨설팅 표의 열 정의 (2026-08-05 ContractOptionsPage에서 분리).
 * 셀 렌더는 화면 상태(초안·잠금·팝업 열기)를 쓰므로, 페이지가 컨텍스트를 넘겨 호출한다.
 * JSX·동작은 페이지에 있던 것을 그대로 옮겼다.
 */
import {
  CopyOutlined,
  EyeOutlined,
  FileTextOutlined,
  MoreOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Button, Checkbox, Dropdown, Input, Progress, Space, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { OptionProgressItem } from '../../api/options';
import { componentGroupLabel } from '../../api/options';
import type { RentalProgressItem } from '../../api/rentals';
import { RENTAL_SELECTION_STATUS_META } from '../../api/rentals';
import type { useRentalCodeNames } from '../rentals/rental-codes';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { OPTION_STATUS_META } from './option-meta';
import {
  AttrDraft,
  ComponentRow,
  EMPTY_ATTR,
  EMPTY_RENTAL,
  isOptionDone,
  RentalDraft,
} from './consulting-rows';

export interface ConsultingColumnsContext {
  attrDrafts: Record<string, AttrDraft>;
  rentalDrafts: Record<string, RentalDraft>;
  rentalItems: RentalProgressItem[];
  rentalCodes: ReturnType<typeof useRentalCodeNames>;
  contractEditable: boolean;
  vestPending: boolean;
  /** 확정 세션·잠긴 계약·제작 진행 중 품목은 열람 전용. */
  isLocked: (row: ComponentRow) => boolean;
  itemOf: (row: ComponentRow) => OptionProgressItem | null;
  copyTargets: (source: OptionProgressItem | null) => OptionProgressItem[];
  patchAttr: (key: string, field: keyof AttrDraft, value: string) => void;
  saveAttr: (row: ComponentRow) => void;
  patchRentalNotes: (key: string, value: string) => void;
  saveRental: (row: ComponentRow, draft: RentalDraft) => void;
  onVestToggle: (row: ComponentRow, included: boolean) => void;
  onOpenOption: (row: ComponentRow) => void;
  onOpenRental: (row: ComponentRow) => void;
  onOpenReview: (contractItemId: string) => void;
  onCopy: (item: OptionProgressItem) => void;
}

export function buildConsultingColumns(ctx: ConsultingColumnsContext): ColumnsType<ComponentRow> {
  const {
    attrDrafts,
    rentalDrafts,
    rentalItems,
    rentalCodes,
    contractEditable,
    vestPending,
    isLocked,
    itemOf,
    copyTargets,
    patchAttr,
    saveAttr,
    patchRentalNotes,
    saveRental,
    onVestToggle,
    onOpenOption,
    onOpenRental,
    onOpenReview,
    onCopy,
  } = ctx;

  const spanCell = (row: ComponentRow) => ({ rowSpan: row.itemRowSpan });

  return [
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
              onChange={(e) => patchRentalNotes(row.key, e.target.value)}
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
                disabled={!contractEditable || row.inProduction === true || vestPending}
                aria-label={`${row.displayName} 베스트 제외`}
                onChange={(e) => onVestToggle(row, !e.target.checked)}
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
                onClick={() => onOpenRental(row)}
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
              onClick={() => onOpenOption(row)}
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
                onClick={() => onOpenReview(item.contractItemId)}
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
                  onClick: () => item && onCopy(item),
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
}
