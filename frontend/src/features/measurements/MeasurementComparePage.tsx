/** MEAS-003 채촌 버전 비교 — 항목/이전/현재/차이 표 (±값 색 강조, 문자 사이즈는 변경 여부만) */
import { SwapOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Row, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { MeasurementCompareRow, MeasurementCompareVersionMeta } from '../../api/measurements';
import {
  MEASUREMENT_GROUP_LABELS,
  MEASUREMENT_TYPE_LABELS,
  fetchMeasurementCompare,
  fetchMeasurements,
} from '../../api/measurements';
import { MEASUREMENT_TYPE_META } from './meas-meta';
import { StatusBadge } from '../../shared/StatusBadge';
import { labelOf, metaOf } from '../../shared/status-meta';

function versionLabel(meta: MeasurementCompareVersionMeta): string {
  return `V${meta.versionNo} · ${meta.measurementDate} · ${labelOf(MEASUREMENT_TYPE_LABELS, meta.measurementType)}`;
}

function renderValue(row: MeasurementCompareRow, value: number | string | null) {
  if (value === null || value === '') return <Typography.Text type="secondary">-</Typography.Text>;
  return (
    <Typography.Text style={{ fontSize: 16 }}>
      {value}
      {row.kind === 'number' ? ' cm' : ''}
    </Typography.Text>
  );
}

export function MeasurementComparePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const leftId = searchParams.get('left');
  const rightId = searchParams.get('right');

  const compareQuery = useQuery({
    queryKey: ['measurements', 'compare', leftId, rightId],
    queryFn: () => fetchMeasurementCompare(leftId ?? '', rightId ?? ''),
    enabled: !!leftId && !!rightId,
  });
  const data = compareQuery.data;

  // 버전 교체용 동일 고객 버전 목록
  const listQuery = useQuery({
    queryKey: ['measurements', 'list', data?.customerId],
    queryFn: () => fetchMeasurements(data?.customerId ?? ''),
    enabled: !!data?.customerId,
  });

  if (!leftId || !rightId) {
    return (
      <Alert
        type="warning"
        showIcon
        message="비교할 두 버전을 선택해 주세요."
        action={
          <Button size="large" onClick={() => navigate('/measurements')}>
            채촌 목록으로
          </Button>
        }
      />
    );
  }
  if (compareQuery.isLoading) return <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />;
  if (compareQuery.error || !data) {
    return (
      <Alert type="error" showIcon message="채촌 비교 데이터를 불러오지 못했습니다." description={(compareQuery.error as Error | null)?.message} />
    );
  }

  const versionOptions = (excludeId: string) =>
    (listQuery.data ?? [])
      .filter((m) => m.id !== excludeId)
      .map((m) => ({
        value: m.id,
        label: `V${m.versionNo} · ${m.measurementDate} · ${labelOf(MEASUREMENT_TYPE_LABELS, m.measurementType)}`,
      }));

  const columns: ColumnsType<MeasurementCompareRow> = [
    {
      title: '부위',
      dataIndex: 'group',
      key: 'group',
      width: 80,
      render: (g: MeasurementCompareRow['group']) => labelOf(MEASUREMENT_GROUP_LABELS, g),
      onCell: (_, index) => {
        // 같은 그룹 행 병합
        const rows = data.rows;
        const i = index ?? 0;
        const row = rows[i];
        if (!row) return {};
        if (i > 0 && rows[i - 1]?.group === row.group) return { rowSpan: 0 };
        return { rowSpan: rows.filter((r) => r.group === row.group).length };
      },
    },
    { title: '항목', dataIndex: 'label', key: 'label', render: (label: string) => <Typography.Text strong>{label}</Typography.Text> },
    {
      title: `이전 (${versionLabel(data.left)})`,
      key: 'left',
      render: (_, row) => renderValue(row, row.leftValue),
    },
    {
      title: `현재 (${versionLabel(data.right)})`,
      key: 'right',
      render: (_, row) => renderValue(row, row.rightValue),
    },
    {
      title: '차이',
      key: 'diff',
      width: 140,
      render: (_, row) => {
        if (row.kind === 'text') {
          // 문자형 사이즈는 차이값을 계산하지 않고 변경 여부만 표시 (§7.7)
          return row.changed ? <Tag color="orange">변경</Tag> : <Typography.Text type="secondary">동일</Typography.Text>;
        }
        if (row.diff === null) return <Typography.Text type="secondary">-</Typography.Text>;
        if (row.diff === 0) return <Typography.Text type="secondary">0</Typography.Text>;
        const positive = row.diff > 0;
        return (
          <Typography.Text strong style={{ color: positive ? '#cf1322' : '#1668dc', fontSize: 16 }}>
            {positive ? '+' : ''}
            {row.diff} cm
          </Typography.Text>
        );
      },
    },
  ];

  const changedKeys = new Set(
    data.rows.filter((r) => (r.kind === 'number' ? r.diff !== null && r.diff !== 0 : r.changed)).map((r) => r.key),
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              채촌 비교 — {data.customerName || '고객'}
            </Typography.Title>
            <Typography.Text type="secondary">
              같은 고객의 채촌 기록끼리 비교합니다. 위 셀렉트에서 대상을 바꿀 수 있습니다.
            </Typography.Text>
          </div>
          <Space wrap size="middle">
            <Space direction="vertical" size={4}>
              <Typography.Text type="secondary">이전 버전</Typography.Text>
              <Select
                size="large"
                style={{ minWidth: 260, height: 48 }}
                value={leftId}
                options={versionOptions(rightId)}
                onChange={(v: string) => setSearchParams({ left: v, right: rightId })}
              />
            </Space>
            <Button
              size="large"
              style={{ height: 48, marginTop: 24 }}
              icon={<SwapOutlined />}
              onClick={() => setSearchParams({ left: rightId, right: leftId })}
            >
              좌우 교체
            </Button>
            <Space direction="vertical" size={4}>
              <Typography.Text type="secondary">현재 버전</Typography.Text>
              <Select
                size="large"
                style={{ minWidth: 260, height: 48 }}
                value={rightId}
                options={versionOptions(leftId)}
                onChange={(v: string) => setSearchParams({ left: leftId, right: v })}
              />
            </Space>
            <Space style={{ marginTop: 24 }}>
              <StatusBadge
                label={metaOf(MEASUREMENT_TYPE_META, data.left.measurementType).label}
                color={metaOf(MEASUREMENT_TYPE_META, data.left.measurementType).color}
              />
              <Typography.Text type="secondary">→</Typography.Text>
              <StatusBadge
                label={metaOf(MEASUREMENT_TYPE_META, data.right.measurementType).label}
                color={metaOf(MEASUREMENT_TYPE_META, data.right.measurementType).color}
              />
            </Space>
          </Space>
        </Space>
      </Card>

      <Card>
        <Table<MeasurementCompareRow>
          rowKey="key"
          dataSource={data.rows}
          columns={columns}
          pagination={false}
          size="middle"
          rowClassName={(row) => (changedKeys.has(row.key) ? 'meas-compare-changed' : '')}
        />
        <style>{`.meas-compare-changed td { background: #fffbe6 !important; }`}</style>
      </Card>

      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Card title={`체형 특이사항 — 이전 (V${data.left.versionNo})`} size="small">
            <Space direction="vertical" size={4}>
              <Typography.Text>{data.left.bodyNotes ?? '기록 없음'}</Typography.Text>
              {data.left.fitPreference && <Typography.Text type="secondary">선호핏: {data.left.fitPreference}</Typography.Text>}
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title={`체형 특이사항 — 현재 (V${data.right.versionNo})`} size="small">
            <Space direction="vertical" size={4}>
              <Typography.Text>{data.right.bodyNotes ?? '기록 없음'}</Typography.Text>
              {data.right.fitPreference && <Typography.Text type="secondary">선호핏: {data.right.fitPreference}</Typography.Text>}
            </Space>
          </Card>
        </Col>
      </Row>

      <Button size="large" style={{ height: 48, alignSelf: 'flex-start' }} onClick={() => navigate(`/measurements?customerId=${data.customerId}`)}>
        채촌 목록으로
      </Button>
    </Space>
  );
}
