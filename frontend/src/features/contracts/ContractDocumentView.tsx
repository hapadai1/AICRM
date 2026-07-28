import { useQuery } from '@tanstack/react-query';
import { Card, Divider, Flex, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import {
  fetchContractDocument,
  type ContractDocument,
  type ContractDocumentComponentOption,
  type ProductCategory,
  type TransactionType,
} from '../../api/contracts';
import { StatusBadge } from '../../shared/StatusBadge';
import {
  formatKrw,
  PRODUCT_CATEGORY_LABEL,
  TRANSACTION_TYPE_LABEL,
  TRANSACTION_TYPE_TAG_COLOR,
} from './labels';

/**
 * 계약서 웹 표시 (설계서 v2 03 §6·§7 / v2 계약관리 보강).
 *
 * 표는 **품목(벌) 한 줄**이 기본이다. 옵션은 계약서의 곁가지이고 아예 없는 계약도 많으므로,
 * 부위·옵션마다 줄을 늘리지 않고 한 칸에 접어 넣는다.
 * - 옵션 칸: 유료 옵션이 있는 부위만 `부위 · 옵션명, 옵션명` 으로 나열
 * - 금액: 옵션별 가격은 싣지 않고 품목별 **옵션 합계**만 (총합은 표 아래 요약)
 *
 * (엑셀은 총액만 — 백엔드가 처리. 프런트는 웹에만 세부 금액을 노출한다.)
 */

/** 부위 하나 — 유료 옵션이 붙은 것만 표시 대상 */
interface RowComponent {
  label: string;
  optionNames: string[];
}

/** 표 한 줄 = 품목 한 벌(또는 계약 확정 전 라인 한 줄) */
interface DocRow {
  key: string;
  transactionType: TransactionType;
  /** "정장 #1" (주문품목) 또는 "정장 ×2" (주문 생성 전) */
  itemLabel: string;
  orderNo?: string;
  quantity: number;
  amount: number;
  notes?: string;
  components: RowComponent[];
  optionTotal: number;
}

function sumExtra(options: ContractDocumentComponentOption[]): number {
  return options.reduce((s, o) => s + (o.extraPrice || 0), 0);
}

/** 계약서 응답 → 품목 단위 행 목록 */
function buildRows(data?: ContractDocument): DocRow[] {
  const rows: DocRow[] = [];
  for (const [li, line] of (data?.lines ?? []).entries()) {
    const categoryLabel =
      line.categoryLabel || PRODUCT_CATEGORY_LABEL[line.productCategory as ProductCategory];

    if (line.items.length > 0) {
      // 주문품목이 있으면 벌 단위(정장 #1·#2)로 편다.
      for (const it of line.items) {
        rows.push({
          key: it.orderItemId,
          transactionType: line.transactionType,
          itemLabel: it.displayName,
          orderNo: it.orderNo,
          quantity: 1,
          amount: line.unitPrice || (line.quantity ? line.lineAmount / line.quantity : 0),
          notes: line.notes,
          components: it.components
            .filter((c) => c.options.length > 0)
            .map((c) => ({ label: c.groupLabel, optionNames: c.options.map((o) => o.optionName) })),
          optionTotal: it.components.reduce((s, c) => s + sumExtra(c.options), 0),
        });
      }
      continue;
    }

    // 계약 확정 전 — 주문품목이 아직 없으므로 계약 라인 한 줄로 보여준다.
    rows.push({
      key: `line-${li}`,
      transactionType: line.transactionType,
      itemLabel: line.quantity > 1 ? `${categoryLabel} ×${line.quantity}` : categoryLabel,
      quantity: line.quantity,
      amount: line.lineAmount,
      notes: line.notes,
      components: [],
      optionTotal: 0,
    });
  }
  return rows;
}

/** 옵션 칸 — 유료 옵션이 붙은 부위만 한 줄씩 */
function OptionCell({ row }: { row: DocRow }) {
  if (row.components.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Flex vertical gap={2}>
      {row.components.map((c) => (
        <Space key={c.label} size={6} align="start" wrap>
          <Tag style={{ margin: 0 }}>{c.label}</Tag>
          <Typography.Text style={{ fontSize: 13 }}>{c.optionNames.join(', ')}</Typography.Text>
        </Space>
      ))}
    </Flex>
  );
}

export function ContractDocumentView({ contractId }: { contractId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['contracts', contractId, 'document'],
    queryFn: () => fetchContractDocument(contractId),
    enabled: !!contractId,
  });

  const rows = useMemo(() => buildRows(data), [data]);

  // 유료 옵션이 하나도 없는 계약이 흔하다. 그럴 땐 옵션 두 열을 아예 빼서
  // 품목·개수·금액만 남긴다(빈 칸이 표 폭의 절반을 먹지 않게).
  const hasOptions = rows.some((r) => r.components.length > 0 || r.optionTotal > 0);

  const columns: ColumnsType<DocRow> = [
    {
      title: '품목',
      key: 'item',
      width: 240,
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <Space size={6}>
            <Tag color={TRANSACTION_TYPE_TAG_COLOR[r.transactionType]} style={{ margin: 0 }}>
              {TRANSACTION_TYPE_LABEL[r.transactionType]}
            </Tag>
            <Typography.Text strong>{r.itemLabel}</Typography.Text>
          </Space>
          {r.orderNo && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.orderNo}
            </Typography.Text>
          )}
          {/* 비고는 옵션 열이 없을 때 별도 열로 뺀다(아래) — 중복 표시하지 않는다. */}
          {hasOptions && r.notes && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              비고: {r.notes}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: '개수', dataIndex: 'quantity', width: 80, align: 'right' },
    {
      title: '금액',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      render: (v: number) => <Typography.Text strong>{formatKrw(v)}</Typography.Text>,
    },
    // 옵션 열이 없으면 마지막 자리는 비고가 채운다(남는 폭이 빈 칸으로 남지 않게).
    ...(!hasOptions
      ? ([
          {
            title: '비고',
            dataIndex: 'notes',
            render: (v?: string) => v ?? <Typography.Text type="secondary">—</Typography.Text>,
          },
        ] as ColumnsType<DocRow>)
      : []),
    ...(hasOptions
      ? ([
          { title: '선택 옵션', key: 'options', render: (_, r) => <OptionCell row={r} /> },
          {
            // 옵션별 가격은 싣지 않는다. 품목별 합계만 보여주고 총합은 표 아래 요약에서 본다.
            title: '옵션 합계',
            dataIndex: 'optionTotal',
            width: 120,
            align: 'right',
            render: (v: number) =>
              v > 0 ? (
                <Typography.Text strong>+{formatKrw(v)}</Typography.Text>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
        ] as ColumnsType<DocRow>)
      : []),
  ];

  const lineTotal = (data?.lines ?? []).reduce((s, l) => s + l.lineAmount, 0);
  const optionTotal = (data?.options ?? []).reduce((s, o) => s + o.extraPrice, 0);

  return (
    <Card
      loading={isLoading}
      title="계약서"
      extra={
        data ? (
          data.signature.signed ? (
            <StatusBadge
              label={`서명 완료${data.signature.signerName ? ` · ${data.signature.signerName}` : ''}`}
              color="green"
            />
          ) : (
            <StatusBadge label="미서명" color="gold" />
          )
        ) : null
      }
    >
      <Flex vertical gap={12}>
        <Table<DocRow>
          rowKey="key"
          size="small"
          pagination={false}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 760 }}
          locale={{ emptyText: '품목이 없습니다.' }}
        />

        {/* 금액 요약 — 품목 합계 · 옵션 추가 · 총 계약금액 (거래는 전부 일시불이라 계약금·잔금은 없다) */}
        <Flex justify="flex-end">
          <Flex
            vertical
            gap={6}
            style={{
              minWidth: 300,
              padding: '14px 18px',
              background: '#fafafa',
              border: '1px solid #f0f0f0',
              borderRadius: 8,
            }}
          >
            <Flex justify="space-between" gap={16}>
              <Typography.Text type="secondary">품목 합계</Typography.Text>
              <Typography.Text>{formatKrw(lineTotal)}</Typography.Text>
            </Flex>
            {optionTotal > 0 && (
              <Flex justify="space-between" gap={16}>
                <Typography.Text type="secondary">옵션 추가 합계</Typography.Text>
                <Typography.Text>+{formatKrw(optionTotal)}</Typography.Text>
              </Flex>
            )}
            <Divider style={{ margin: '2px 0' }} />
            <Flex justify="space-between" align="baseline" gap={16}>
              <Typography.Text strong>총 계약금액</Typography.Text>
              <Typography.Text strong style={{ fontSize: 20 }}>
                {formatKrw(data?.totalAmount)}
              </Typography.Text>
            </Flex>
          </Flex>
        </Flex>
      </Flex>
    </Card>
  );
}
