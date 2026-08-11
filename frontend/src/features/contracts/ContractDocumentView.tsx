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
 * 표는 작성중 품목표(ContractLineEditor)와 같은 모양이다 — 품목(벌) 한 줄에
 * 거래방식·품목·수량·단가·금액·비고를 싣고, 유료 옵션이 있으면 그 바로 아래에
 * **옵션(추가금액)** 한 줄을 끼워 넣는다. 옵션 줄의 비고에는 부위별 옵션을
 * `부위: 옵션명, 옵션명` 으로 적고, 금액 칸에는 품목별 옵션 합계를 둔다.
 * (엑셀은 총액만 — 백엔드가 처리. 프런트는 웹에만 세부를 노출한다.)
 */

/** 부위 하나 — 유료 옵션이 붙은 것만 표시 대상 */
interface RowComponent {
  label: string;
  /** 컨설팅에서 뺀 부위(베스트) — 옵션명 대신 "제외"로 적는다 */
  excluded: boolean;
  optionNames: string[];
}

/** 표 한 줄 = 품목 한 벌, 또는 그 아래 옵션(추가금액) 롤업 줄 */
interface DocRow {
  key: string;
  /** 옵션(추가금액) 롤업 줄 — 품목 줄 바로 아래에 끼워 넣는다 (작성중 품목표와 동일) */
  isOptionRollup?: boolean;
  transactionType: TransactionType;
  /** "정장 #1" (주문품목) 또는 "정장 ×2" (주문 생성 전) */
  itemLabel: string;
  orderNo?: string;
  quantity: number;
  /** 단가 — 작성중 품목표와 컬럼을 맞추기 위해 금액과 별도로 싣는다 (벌 단위면 금액과 같다) */
  unitPrice: number;
  amount: number;
  notes?: string;
}

function sumExtra(options: ContractDocumentComponentOption[]): number {
  return options.reduce((s, o) => s + (o.extraPrice || 0), 0);
}

/** 옵션(추가금액) 줄의 비고 — 부위별로 `부위: 옵션명, 옵션명` 을 한 줄씩 적는다. */
function buildOptionNote(components: RowComponent[]): string {
  return components
    .map((c) => `${c.label}: ${c.excluded ? '제외' : c.optionNames.join(', ')}`)
    .join('\n');
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
        const unitPrice =
          line.unitPrice || (line.quantity ? line.lineAmount / line.quantity : 0);
        rows.push({
          key: it.contractItemId,
          transactionType: line.transactionType,
          itemLabel: it.displayName,
          orderNo: it.orderNo ?? undefined,
          quantity: 1,
          unitPrice,
          amount: unitPrice,
          notes: line.notes,
        });

        // 유료 옵션이 붙은 부위 + 컨설팅에서 뺀 베스트("제외"로 남긴다 — 현업 확정 2026-08-01).
        // 계약서가 베스트를 다루지 않게 되면서, 3피스로 계약하고 2피스로 만든다는 사실이
        // 계약서에서 보이는 자리는 여기뿐이다.
        const components: RowComponent[] = it.components
          .filter((c) => c.options.length > 0 || c.excluded)
          .map((c) => ({
            label: c.groupLabel,
            excluded: c.excluded,
            optionNames: c.options.map((o) => o.optionName),
          }));
        const optionTotal = it.components.reduce((s, c) => s + sumExtra(c.options), 0);

        // 옵션이 있으면 작성중 품목표처럼 '옵션(추가금액)' 한 줄을 품목 바로 아래 끼워 넣는다.
        if (components.length > 0 || optionTotal > 0) {
          rows.push({
            key: `${it.contractItemId}-opt`,
            isOptionRollup: true,
            transactionType: line.transactionType,
            itemLabel: '옵션(추가금액)',
            quantity: 0,
            unitPrice: 0,
            amount: optionTotal,
            notes: buildOptionNote(components),
          });
        }
      }
      continue;
    }

    // 계약 확정 전 — 주문품목이 아직 없으므로 계약 라인 한 줄로 보여준다.
    rows.push({
      key: `line-${li}`,
      transactionType: line.transactionType,
      itemLabel: line.quantity > 1 ? `${categoryLabel} ×${line.quantity}` : categoryLabel,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.lineAmount,
      notes: line.notes,
    });
  }
  return rows;
}

export function ContractDocumentView({ contractId }: { contractId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['contracts', contractId, 'document'],
    queryFn: () => fetchContractDocument(contractId),
    enabled: !!contractId,
  });

  const rows = useMemo(() => buildRows(data), [data]);

  // 컬럼은 작성중 품목표(ContractLineEditor)와 동일하게 맞춘다 —
  // 거래 방식·품목·수량·단가·금액·비고. 옵션은 별도 열이 아니라
  // 품목 아래 '옵션(추가금액)' 줄로 buildRows가 이미 끼워 넣었다.
  const columns: ColumnsType<DocRow> = [
    {
      title: '거래 방식',
      key: 'transactionType',
      width: 96,
      render: (_, r) =>
        r.isOptionRollup ? null : (
          <Tag color={TRANSACTION_TYPE_TAG_COLOR[r.transactionType]} style={{ margin: 0 }}>
            {TRANSACTION_TYPE_LABEL[r.transactionType]}
          </Tag>
        ),
    },
    {
      title: '품목',
      key: 'item',
      width: 200,
      render: (_, r) =>
        r.isOptionRollup ? (
          <span style={{ fontWeight: 600 }}>옵션(추가금액)</span>
        ) : (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{r.itemLabel}</Typography.Text>
            {r.orderNo && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.orderNo}
              </Typography.Text>
            )}
          </Space>
        ),
    },
    {
      title: '수량',
      dataIndex: 'quantity',
      width: 70,
      align: 'right',
      render: (v: number, r) => (r.isOptionRollup ? null : v),
    },
    {
      // 작성중 품목표와 컬럼을 맞추기 위해 단가를 별도로 보여준다(벌 단위 행은 금액과 같다).
      title: '단가(원)',
      dataIndex: 'unitPrice',
      width: 130,
      align: 'right',
      render: (v: number, r) => (r.isOptionRollup ? null : formatKrw(v)),
    },
    {
      title: '금액(원)',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => <Typography.Text strong>{formatKrw(v)}</Typography.Text>,
    },
    {
      title: '비고',
      dataIndex: 'notes',
      render: (v: string | undefined, r) => {
        // 옵션 롤업 줄: 부위별 유료 옵션 목록(줄바꿈 유지).
        if (r.isOptionRollup)
          return (
            <Typography.Text type="secondary" style={{ whiteSpace: 'pre-line' }}>
              {v}
            </Typography.Text>
          );
        return v ?? <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
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
          scroll={{ x: 860 }}
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
