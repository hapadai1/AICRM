import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Checkbox, Flex, Input, InputNumber, Select, Table, Typography } from 'antd';
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
  /** 라인 전체 금액 — 베스트 포함 시 베스트 금액(수량×베스트 단가)까지 더한 값 */
  amount: number;
  /**
   * 베스트(3피스) 포함 — 맞춤 정장 라인 전용 (현업 확정 2026-07-30).
   * [베스트 제외] 체크를 풀면 아래에 베스트 행이 생기고 단가를 수기로 넣는다.
   */
  vestIncluded: boolean;
  /** 베스트 포함 시 벌당 베스트 단가(수기) */
  vestUnitPrice: number;
  note?: string;
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
    vestIncluded: false,
    vestUnitPrice: 0,
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

/** 베스트를 켤 수 있는 라인인가 — 맞춤 정장만 (렌탈·셔츠·구두 제외) */
const isVestCapable = (l: EditableLine): boolean =>
  l.transactionType === 'CUSTOM' && l.productCategory === 'SUIT';

/** 라인의 베스트 금액 (수량 × 베스트 단가). 제외 라인은 0. */
const vestAmountOf = (l: EditableLine): number =>
  l.vestIncluded ? (l.quantity || 0) * (l.vestUnitPrice || 0) : 0;

/**
 * 표의 한 행 — 라인 행 또는 그 라인에서 파생된 베스트 행.
 * 베스트는 품목표에서 자기 행으로 수량·단가·금액을 갖는다 (품목별 가격 관리, 현업 확정 2026-07-30).
 */
interface EditorRow extends EditableLine {
  rowKey: string;
  isVestRow: boolean;
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
        // 거래방식·품목이 맞춤 정장을 벗어나면 베스트는 유지할 수 없다.
        if (!isVestCapable(next)) next.vestIncluded = false;
        // 수량·단가·베스트 변경 시 금액 자동 계산 (금액 직접 수정도 허용)
        if (
          patch.quantity !== undefined ||
          patch.unitPrice !== undefined ||
          patch.vestIncluded !== undefined ||
          patch.vestUnitPrice !== undefined ||
          patch.transactionType !== undefined ||
          patch.productCategory !== undefined
        ) {
          next.amount = (next.quantity || 0) * (next.unitPrice || 0) + vestAmountOf(next);
        }
        return next;
      }),
    );
  };

  // 라인 → 표 행 펼침: 베스트 포함 라인은 바로 아래에 베스트 행이 붙는다.
  const rows: EditorRow[] = value.flatMap((l) => {
    const base: EditorRow = { ...l, rowKey: l.key, isVestRow: false };
    if (!l.vestIncluded) return [base];
    return [base, { ...l, rowKey: `${l.key}:vest`, isVestRow: true }];
  });

  const columns: ColumnsType<EditorRow> = [
    {
      title: '거래 방식',
      dataIndex: 'transactionType',
      width: 108,
      render: (_, l) =>
        l.isVestRow ? null : (
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
        l.isVestRow ? (
          <Typography.Text strong style={{ paddingLeft: 8 }}>
            └ 베스트
          </Typography.Text>
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
        l.isVestRow ? (
          // 베스트 수량은 정장 벌 수를 따라간다 (벌당 1개)
          <Typography.Text>{l.quantity}</Typography.Text>
        ) : (
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
        l.isVestRow ? (
          // 베스트 단가는 수기 입력 — 제외 시 이 금액만큼 자동 차감된다.
          <InputNumber
            className="num-input"
            style={{ width: '100%' }}
            variant="filled"
            controls={false}
            min={0}
            step={10000}
            value={l.vestUnitPrice}
            formatter={THOUSANDS}
            placeholder="베스트 단가"
            disabled={disabled}
            onChange={(v) => update(l.key, { vestUnitPrice: v ?? 0 })}
          />
        ) : (
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
      // 베스트 행 금액은 수량 × 베스트 단가 자동(직접 수정 없음), 정장 행은 베스트 금액을 뺀 몫을 보여준다.
      title: '금액(원)',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      render: (_, l) => {
        if (l.isVestRow)
          return (
            <Typography.Text strong style={{ display: 'block', textAlign: 'right' }}>
              {THOUSANDS(vestAmountOf(l))}
            </Typography.Text>
          );
        const vestAmount = vestAmountOf(l);
        return (
          <InputNumber
            className="num-input"
            style={{ width: '100%', fontWeight: 600 }}
            variant="filled"
            controls={false}
            min={0}
            step={10000}
            value={(l.amount || 0) - vestAmount}
            formatter={THOUSANDS}
            disabled={disabled}
            onChange={(v) => update(l.key, { amount: (v ?? 0) + vestAmount })}
          />
        );
      },
    },
    {
      title: '비고',
      dataIndex: 'note',
      render: (_, l) =>
        l.isVestRow ? null : (
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
      // 정장(맞춤) 행 맨뒤 [베스트 제외] 체크박스 (현업 확정 2026-07-30).
      // 체크를 풀면 아래에 베스트 행이 생기고, 다시 체크하면 행이 빠지며 합계에서 차감된다.
      title: '베스트 제외',
      key: 'vest',
      width: 96,
      align: 'center',
      render: (_, l) =>
        l.isVestRow || !isVestCapable(l) ? null : (
          <Checkbox
            checked={!l.vestIncluded}
            disabled={disabled}
            aria-label="베스트 제외"
            onChange={(e) => update(l.key, { vestIncluded: !e.target.checked })}
          />
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 44,
      align: 'center',
      render: (_, l) => (
        <Button
          type="text"
          danger
          icon={<DeleteOutlined />}
          disabled={disabled}
          aria-label={l.isVestRow ? '베스트 행 삭제' : '품목 행 삭제'}
          onClick={() =>
            l.isVestRow
              ? update(l.key, { vestIncluded: false })
              : onChange(value.filter((x) => x.key !== l.key))
          }
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
