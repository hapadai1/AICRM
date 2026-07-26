import { DownOutlined, RightOutlined, SkinOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Card, Flex, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  fetchContractDocument,
  type ContractDocumentLine,
  type ContractDocumentOption,
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
 * 계약서 웹 표시 (설계서 v2 03 §6·§7).
 *
 * D7 웹 규칙: 세부 가격을 노출하고 "상세 토글"로 구성품·옵션을 펼친다.
 * - 최초(옵션 미추가): 품목(대분류) · 개수 · **가격(라인금액)** → 상세 토글 = 세부품목(구성품)
 * - 스타일 옵션 추가 후: 옵션명 · **가격(추가금액)** 표
 *
 * (엑셀은 총액만 — 백엔드가 처리. 프런트는 웹에만 세부가격을 노출한다.)
 */
export function ContractDocumentView({ contractId }: { contractId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['contracts', contractId, 'document'],
    queryFn: () => fetchContractDocument(contractId),
    enabled: !!contractId,
  });

  const lineColumns: ColumnsType<ContractDocumentLine> = [
    {
      title: '품목',
      key: 'category',
      render: (_, r) => (
        <Space size={6}>
          <Tag color={TRANSACTION_TYPE_TAG_COLOR[r.transactionType as TransactionType]}>
            {TRANSACTION_TYPE_LABEL[r.transactionType as TransactionType]}
          </Tag>
          <Typography.Text strong>
            {r.categoryLabel || PRODUCT_CATEGORY_LABEL[r.productCategory as ProductCategory]}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '개수', dataIndex: 'quantity', width: 90, align: 'right' },
    {
      title: '가격',
      dataIndex: 'lineAmount',
      width: 140,
      align: 'right',
      render: (v: number) => <Typography.Text strong>{formatKrw(v)}</Typography.Text>,
    },
  ];

  const optionColumns: ColumnsType<ContractDocumentOption> = [
    {
      title: '옵션명',
      dataIndex: 'optionName',
      render: (v: string) => (
        <Space size={6}>
          <SkinOutlined />
          <Typography.Text>{v}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '가격(추가금액)',
      dataIndex: 'extraPrice',
      width: 160,
      align: 'right',
      render: (v: number) => <Typography.Text strong>{formatKrw(v)}</Typography.Text>,
    },
  ];

  const options = data?.options ?? [];
  const lineTotal = (data?.lines ?? []).reduce((s, l) => s + l.lineAmount, 0);
  const optionTotal = options.reduce((s, o) => s + o.extraPrice, 0);

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
      <Flex vertical gap={16}>
        <Typography.Text type="secondary">
          품목별 가격은 상세 토글(▶)로 세부 구성품을 펼쳐 확인할 수 있습니다. 총 계약금액은 아래에 표시됩니다.
        </Typography.Text>

        <Table<ContractDocumentLine>
          rowKey={(r) => `${r.transactionType}|${r.productCategory}|${r.itemDescription ?? ''}`}
          size="small"
          pagination={false}
          columns={lineColumns}
          dataSource={data?.lines ?? []}
          scroll={{ x: 480 }}
          expandable={{
            // 상세 토글 = 세부품목(구성품). 구성품이 없으면 펼치기 불가.
            rowExpandable: (r) => r.components.length > 0,
            expandIcon: ({ expanded, onExpand, record }) =>
              record.components.length > 0 ? (
                <Typography.Link onClick={(e) => onExpand(record, e)}>
                  {expanded ? <DownOutlined /> : <RightOutlined />} 세부품목
                </Typography.Link>
              ) : null,
            expandedRowRender: (r) => (
              <Space size={[8, 8]} wrap>
                {r.components.map((c, i) => (
                  <Tag key={`${c}-${i}`}>{c}</Tag>
                ))}
                {r.notes && <Typography.Text type="secondary">비고: {r.notes}</Typography.Text>}
              </Space>
            ),
          }}
        />

        {options.length > 0 && (
          <div>
            <Typography.Title level={5}>스타일 옵션</Typography.Title>
            <Table<ContractDocumentOption>
              rowKey={(o) => o.optionName}
              size="small"
              pagination={false}
              columns={optionColumns}
              dataSource={options}
              scroll={{ x: 360 }}
            />
          </div>
        )}

        <Flex justify="flex-end" gap={24} wrap>
          <Typography.Text type="secondary">품목 {formatKrw(lineTotal)}</Typography.Text>
          {options.length > 0 && (
            <Typography.Text type="secondary">옵션 추가 {formatKrw(optionTotal)}</Typography.Text>
          )}
          <Typography.Text strong style={{ fontSize: 16 }}>
            총 계약금액 {formatKrw(data?.totalAmount)}
          </Typography.Text>
        </Flex>
      </Flex>
    </Card>
  );
}
