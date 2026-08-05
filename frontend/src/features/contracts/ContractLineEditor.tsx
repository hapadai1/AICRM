import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Flex, Input, InputNumber, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ProductCategory, TransactionType } from '../../api/contracts';
import { PRODUCT_CATEGORY_LABEL, TRANSACTION_TYPE_LABEL } from './labels';

/** 계약서 작성·변경 계약에서 함께 쓰는 품목 라인 편집 표 */

export interface EditableLine {
  key: string;
  id?: string;
  transactionType: TransactionType;
  productCategory: ProductCategory;
  quantity: number;
  unitPrice: number;
  /** 라인 금액 — 수량 × 단가 (직접 수정도 허용) */
  amount: number;
  note?: string;
  /**
   * 스타일 컨설팅 옵션 추가금액을 합산한 시스템 라인. **읽기 전용**이다 —
   * 백엔드가 소유·재생성하므로 편집·삭제하지 않고 저장 본문에도 싣지 않는다.
   * 표에서는 항상 맨 아래에 '옵션(추가금액)' 한 줄로 보인다.
   */
  isOptionRollup?: boolean;
}

let lineKeySeq = 0;

export function createLine(partial: Partial<EditableLine> = {}): EditableLine {
  return {
    key: `line-${++lineKeySeq}`,
    transactionType: 'CUSTOM',
    productCategory: 'SUIT',
    quantity: 1,
    unitPrice: 0,
    amount: 0,
    ...partial,
  };
}

export function linesTotal(lines: EditableLine[]): number {
  return lines.reduce((sum, l) => sum + (l.amount || 0), 0);
}

/** 금액 입력 천단위 구분 표시 */
export const THOUSANDS = (v: string | number | undefined): string =>
  `${v ?? ''}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const TRANSACTION_OPTIONS = (Object.keys(TRANSACTION_TYPE_LABEL) as TransactionType[]).map((v) => ({
  value: v,
  label: TRANSACTION_TYPE_LABEL[v],
}));

const CATEGORY_OPTIONS = (Object.keys(PRODUCT_CATEGORY_LABEL) as ProductCategory[]).map((v) => ({
  value: v,
  label: PRODUCT_CATEGORY_LABEL[v],
}));

/**
 * 계약서 품목표는 베스트를 다루지 않는다 (현업 확정 2026-08-01).
 * 정장은 상의·하의·베스트 세 부위가 한 벌이고, 뺄지 말지는 스타일 컨설팅에서 벌마다 정한다
 * — 계약 시점에는 아직 모르고, 베스트 값도 그때그때 달라 계약 금액은 수기로 조정한다.
 * (품목표에 상의·하의 행이 없는데 베스트만 행을 갖던 것이 이 화면의 어색함이었다.)
 */
interface EditorRow extends EditableLine {
  rowKey: string;
}

interface ContractLineEditorProps {
  value: EditableLine[];
  onChange: (next: EditableLine[]) => void;
  disabled?: boolean;
}

export function ContractLineEditor({ value, onChange, disabled }: ContractLineEditorProps) {
  const update = (key: string, patch: Partial<EditableLine>) => {
    onChange(
      value.map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch };
        // 수량·단가 변경 시 금액 자동 계산 (금액 직접 수정도 허용)
        if (patch.quantity !== undefined || patch.unitPrice !== undefined)
          next.amount = (next.quantity || 0) * (next.unitPrice || 0);
        return next;
      }),
    );
  };

  // 옵션 추가금액 롤업 라인은 컨설팅 결과라 항상 맨 아래에 고정한다 — 새 품목 행을 추가해도 밑에 남는다.
  const rows: EditorRow[] = [...value]
    .sort((a, b) => Number(!!a.isOptionRollup) - Number(!!b.isOptionRollup))
    .map((l) => ({ ...l, rowKey: l.key }));

  const columns: ColumnsType<EditorRow> = [
    {
      title: '거래 방식',
      dataIndex: 'transactionType',
      width: 108,
      render: (_, l) =>
        l.isOptionRollup ? null : (
          <Select
            style={{ width: '100%' }}
            variant="filled"
            value={l.transactionType}
            options={TRANSACTION_OPTIONS}
            disabled={disabled}
            onChange={(v) => update(l.key, { transactionType: v })}
          />
        ),
    },
    {
      title: '품목',
      dataIndex: 'productCategory',
      width: 118,
      render: (_, l) =>
        l.isOptionRollup ? (
          <span style={{ fontWeight: 600 }}>옵션(추가금액)</span>
        ) : (
          <Select
            style={{ width: '100%' }}
            variant="filled"
            value={l.productCategory}
            options={CATEGORY_OPTIONS}
            disabled={disabled}
            onChange={(v) => update(l.key, { productCategory: v })}
          />
        ),
    },
    {
      title: '수량',
      dataIndex: 'quantity',
      width: 84,
      align: 'right',
      render: (_, l) =>
        l.isOptionRollup ? null : (
          <InputNumber
            className="num-input"
            style={{ width: '100%' }}
            variant="filled"
            controls={false}
            min={1}
            value={l.quantity}
            disabled={disabled}
            onChange={(v) => update(l.key, { quantity: v ?? 1 })}
          />
        ),
    },
    {
      title: '단가(원)',
      dataIndex: 'unitPrice',
      width: 132,
      align: 'right',
      render: (_, l) =>
        l.isOptionRollup ? null : (
          <InputNumber
            className="num-input"
            style={{ width: '100%' }}
            variant="filled"
            controls={false}
            min={0}
            step={10000}
            value={l.unitPrice}
            formatter={THOUSANDS}
            disabled={disabled}
            onChange={(v) => update(l.key, { unitPrice: v ?? 0 })}
          />
        ),
    },
    {
      // 금액 = 수량 × 단가 자동 계산. 조정이 필요하면 직접 고칠 수 있다.
      // 옵션 롤업 라인은 컨설팅에서 합산돼 넘어온 값이라 읽기 전용으로만 보여 준다.
      title: '금액(원)',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      render: (_, l) =>
        l.isOptionRollup ? (
          <span style={{ fontWeight: 600 }}>{THOUSANDS(l.amount || 0)}</span>
        ) : (
          <InputNumber
            className="num-input"
            style={{ width: '100%', fontWeight: 600 }}
            variant="filled"
            controls={false}
            min={0}
            step={10000}
            value={l.amount || 0}
            formatter={THOUSANDS}
            disabled={disabled}
            onChange={(v) => update(l.key, { amount: v ?? 0 })}
          />
        ),
    },
    {
      title: '비고',
      dataIndex: 'note',
      render: (_, l) =>
        l.isOptionRollup ? (
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>스타일 컨설팅에서 자동 반영</span>
        ) : (
          <Input
            value={l.note}
            variant="filled"
            placeholder="비고"
            disabled={disabled}
            onChange={(e) => update(l.key, { note: e.target.value })}
          />
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 44,
      align: 'center',
      // 옵션 롤업 라인은 백엔드 소유라 삭제 버튼을 두지 않는다.
      render: (_, l) =>
        l.isOptionRollup ? null : (
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            disabled={disabled}
            aria-label="품목 행 삭제"
            onClick={() => onChange(value.filter((x) => x.key !== l.key))}
          />
        ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      <Table
        rowKey="rowKey"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 860 }}
        locale={{ emptyText: '품목이 없습니다. 계약 구분을 선택하거나 행을 추가해 주세요.' }}
      />
      {/* 합계는 여기서 보여주지 않는다 — 화면 하단 [금액] 카드에서 자동 합산해 표시한다. */}
      <Button
        icon={<PlusOutlined />}
        type="dashed"
        block
        disabled={disabled}
        onClick={() => onChange([...value, createLine()])}
      >
        품목 행 추가
      </Button>
    </Flex>
  );
}
