/**
 * MEAS-001 채촌 대상 목록 (설계서 09 §4.1) — 계약 단위.
 * 기준은 채촌 기록이 아니라 스타일 컨설팅 대상(맞춤 계약 품목)이라, 아직 채촌하지 않은 계약도 모두 보인다.
 * 행을 고르면 중간 목록 없이 그 계약의 채촌 기록(신체 치수) 화면으로 바로 들어간다.
 */
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Empty, Input, Segmented, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchMeasurementTargets, type MeasurementTargetRow } from '../../api/measurements';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { PRODUCT_CATEGORY_LABEL } from '../contracts/labels';
import { MEASUREMENT_TYPE_META } from './meas-meta';

/** 품목 구성 요약 — "정장 2 · 셔츠 1" */
function itemComposition(counts: MeasurementTargetRow['categoryCounts']): string {
  return (Object.keys(counts) as (keyof MeasurementTargetRow['categoryCounts'])[])
    .map((c) => `${PRODUCT_CATEGORY_LABEL[c] ?? c} ${counts[c]}`)
    .join(' · ');
}

/** 이 계약의 채촌 상태 — 고객의 과거 이력이 아니라 계약에 연결된 채촌만 본다. */
function measurementStateOf(row: MeasurementTargetRow): { label: string; color: string } {
  if (row.measurementCount === 0) return { label: '미채촌', color: 'red' };
  if (row.measurementCompletedCount > 0) return { label: '완료', color: 'green' };
  return { label: '작성중', color: 'gold' };
}

type StateFilter = 'ALL' | 'NONE' | 'DONE';

export function MeasurementListPage() {
  const navigate = useNavigate();
  // 고객 상세·주문 화면에서 ?customerId= 로 넘어오면 그 고객의 계약만 추린다.
  const [searchParams, setSearchParams] = useSearchParams();
  const customerId = searchParams.get('customerId');
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState<StateFilter>('ALL');

  const query = useQuery({
    queryKey: ['measurements', 'targets'],
    queryFn: fetchMeasurementTargets,
  });

  const rows = useMemo(() => {
    let list = query.data ?? [];
    if (customerId) list = list.filter((r) => r.customerId === customerId);
    const q = keyword.trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        [r.customerName, r.customerPhone, r.contractNo].some((v) => v?.toLowerCase().includes(q)),
      );
    }
    if (filter === 'NONE') list = list.filter((r) => r.measurementCompletedCount === 0);
    if (filter === 'DONE') list = list.filter((r) => r.measurementCompletedCount > 0);
    return list;
  }, [query.data, customerId, keyword, filter]);

  const columns: ColumnsType<MeasurementTargetRow> = [
    {
      title: '고객',
      key: 'customer',
      width: 160,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.customerName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.customerPhone || '-'}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '계약번호', dataIndex: 'contractNo', width: 130 },
    {
      title: '품목 구성',
      key: 'composition',
      width: 140,
      render: (_, row) => itemComposition(row.categoryCounts) || '-',
    },
    {
      title: '완성 예정일',
      dataIndex: 'dueDate',
      width: 110,
      render: (v: string | null) => v ?? <Typography.Text type="secondary">미정</Typography.Text>,
    },
    {
      title: '스타일 컨설팅',
      key: 'consulting',
      width: 140,
      render: (_, row) =>
        row.consultingComplete ? (
          <Tag color="green">전체 완료</Tag>
        ) : (
          <Space size={4}>
            <Tag color="orange">미완료</Tag>
            <Typography.Text type="secondary">
              {row.consultingConfirmedCount}/{row.itemCount}
            </Typography.Text>
          </Space>
        ),
    },
    {
      title: '채촌 상태',
      key: 'measurement',
      width: 120,
      render: (_, row) => {
        const state = measurementStateOf(row);
        return <StatusBadge label={state.label} color={state.color} />;
      },
    },
    {
      title: '최근 채촌',
      key: 'lastMeasurement',
      width: 190,
      render: (_, row) =>
        row.lastMeasurementDate ? (
          <Space direction="vertical" size={0}>
            <Space size={4}>
              <Typography.Text strong>{row.lastMeasurementDate}</Typography.Text>
              <Typography.Text type="secondary">V{row.lastVersionNo}</Typography.Text>
            </Space>
            <Space size={4}>
              <StatusBadge
                label={metaOf(MEASUREMENT_TYPE_META, row.lastMeasurementType ?? '').label}
                color={metaOf(MEASUREMENT_TYPE_META, row.lastMeasurementType ?? '').color}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.measurementCount}건
              </Typography.Text>
            </Space>
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: '액션',
      key: 'actions',
      width: 190,
      render: (_, row) => (
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          <Button
            size="small"
            disabled={!row.lastSessionId}
            onClick={() => navigate(`/measurements/${row.lastSessionId}`)}
          >
            기록 보기
          </Button>
          <Can permission="MEASUREMENT_EDIT">
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() =>
                navigate(`/measurements/new?customerId=${row.customerId}&orderId=${row.orderId}`)
              }
            >
              채촌
            </Button>
          </Can>
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <Input.Search
              allowClear
              style={{ width: 280 }}
              placeholder="고객명 · 전화번호 · 계약번호"
              onSearch={setKeyword}
              onChange={(e) => {
                if (!e.target.value) setKeyword('');
              }}
            />
            <Segmented
              value={filter}
              onChange={(v) => setFilter(v as StateFilter)}
              options={[
                { label: '전체', value: 'ALL' },
                { label: '채촌 미완료', value: 'NONE' },
                { label: '채촌 완료', value: 'DONE' },
              ]}
            />
            {customerId && (
              <Tag closable color="blue" onClose={() => setSearchParams({})}>
                고객 지정 조회 중{rows[0]?.customerName ? `: ${rows[0].customerName}` : ''}
              </Tag>
            )}
            <Typography.Text type="secondary">총 {rows.length}건</Typography.Text>
          </Space>
          <Can permission="MEASUREMENT_EDIT">
            <Button icon={<PlusOutlined />} onClick={() => navigate('/measurements/new')}>
              신규 채촌
            </Button>
          </Can>
        </Space>

        <Table<MeasurementTargetRow>
          rowKey="contractId"
          size="small"
          loading={query.isLoading}
          dataSource={rows}
          columns={columns}
          pagination={false}
          scroll={{ x: 1180 }}
          onRow={(row) => ({
            onClick: () => {
              if (row.lastSessionId) navigate(`/measurements/${row.lastSessionId}`);
            },
            style: { cursor: row.lastSessionId ? 'pointer' : 'default' },
          })}
          locale={{
            emptyText: <Empty description="스타일 컨설팅 대상 맞춤 품목이 있는 계약이 없습니다." />,
          }}
        />
      </Space>
    </Card>
  );
}
