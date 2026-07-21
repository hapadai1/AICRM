import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Flex, Input, InputNumber, Select, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ProductCategory, TransactionType } from '../../api/contracts';
import { formatKrw, PRODUCT_CATEGORY_LABEL, TRANSACTION_TYPE_LABEL } from './labels';

/** 계약서 작성·변경 계약에서 함께 쓰는 품목 라인 편집 표 */

export interface EditableLine {
  key: string;
  id?: string;
  transactionType: TransactionType;
  productCategory: ProductCategory;
  quantity: number;
  unitPrice: number;
  amount: number;
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
    ...partial,
  };
}

export function linesTotal(lines: EditableLine[]): number {
  return lines.reduce((sum, l) => sum + (l.amount || 0), 0);
}

const TRANSACTION_OPTIONS = (Object.keys(TRANSACTION_TYPE_LABEL) as TransactionType[]).map((v) => ({
  value: v,
  label: TRANSACTION_TYPE_LABEL[v],
}));

const CATEGORY_OPTIONS = (Object.keys(PRODUCT_CATEGORY_LABEL) as ProductCategory[]).map((v) => ({
  value: v,
  label: PRODUCT_CATEGORY_LABEL[v],
}));

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
        if (patch.quantity !== undefined || patch.unitPrice !== undefined) {
          next.amount = (next.quantity || 0) * (next.unitPrice || 0);
        }
        return next;
      }),
    );
  };

  const columns: ColumnsType<EditableLine> = [
    {
      title: '거래 방식',
      dataIndex: 'transactionType',
      width: 110,
      render: (_, l) => (
        <Select
          style={{ width: '100%' }}
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
      width: 110,
      render: (_, l) => (
        <Select
          style={{ width: '100%' }}
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
      width: 90,
      render: (_, l) => (
        <InputNumber
          style={{ width: '100%' }}
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
      width: 140,
      render: (_, l) => (
        <InputNumber
          style={{ width: '100%' }}
          min={0}
          step={10000}
          value={l.unitPrice}
          formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
          disabled={disabled}
          onChange={(v) => update(l.key, { unitPrice: v ?? 0 })}
        />
      ),
    },
    {
      title: '금액(원)',
      dataIndex: 'amount',
      width: 140,
      render: (_, l) => (
        <InputNumber
          style={{ width: '100%' }}
          min={0}
          step={10000}
          value={l.amount}
          formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
          disabled={disabled}
          onChange={(v) => update(l.key, { amount: v ?? 0 })}
        />
      ),
    },
    {
      title: '비고',
      dataIndex: 'note',
      render: (_, l) => (
        <Input
          value={l.note}
          placeholder="비고"
          disabled={disabled}
          onChange={(e) => update(l.key, { note: e.target.value })}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 48,
      render: (_, l) => (
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
    <Flex vertical gap={8}>
      <Table
        rowKey="key"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={value}
        scroll={{ x: 760 }}
        locale={{ emptyText: '품목이 없습니다. 계약 구분을 선택하거나 행을 추가해 주세요.' }}
      />
      <Flex justify="space-between" align="center" wrap>
        <Button icon={<PlusOutlined />} disabled={disabled} onClick={() => onChange([...value, createLine()])}>
          품목 행 추가
        </Button>
        <Typography.Text strong>품목 합계: {formatKrw(linesTotal(value))}</Typography.Text>
      </Flex>
    </Flex>
  );
}
