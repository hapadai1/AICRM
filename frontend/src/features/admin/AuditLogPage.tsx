/**
 * AUDIT-001 감사로그 조회
 * - 기간(기본 최근 7일)/사용자/기능(액션)/대상 검색
 * - 상세 드로어: 변경 전/후 JSON 비교(변경 필드 강조), IP·요청 ID·사유
 */
import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { fetchAuditLog, fetchUsers, searchAuditLogs } from '../../api/admin';
import type { AuditLogItem } from '../../api/admin';

const ACTION_META: Record<string, { label: string; color: string }> = {
  CREATE: { label: '생성', color: 'blue' },
  UPDATE: { label: '수정', color: 'gold' },
  DELETE: { label: '삭제', color: 'red' },
  CONFIRM: { label: '확정', color: 'green' },
  CANCEL: { label: '취소', color: 'volcano' },
  STATUS_CHANGE: { label: '상태 변경', color: 'purple' },
  EXPORT: { label: '출력', color: 'geekblue' },
  SEND: { label: '발송', color: 'cyan' },
  ACTIVATE: { label: '활성화', color: 'green' },
};

function actionTag(action: string) {
  const meta = ACTION_META[action];
  return <Tag color={meta?.color ?? 'default'}>{meta?.label ?? action} ({action})</Tag>;
}

/** 변경 전/후 JSON을 키 단위로 비교해 변경 행을 강조한다. */
function DiffView({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const keys = Array.from(
    new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  );
  if (keys.length === 0) {
    return <Typography.Text type="secondary">변경값 기록이 없습니다.</Typography.Text>;
  }
  const fmt = (v: unknown) => (v === undefined ? '-' : JSON.stringify(v));
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#fafafa' }}>
            <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #f0f0f0' }}>필드</th>
            <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #f0f0f0' }}>변경 전</th>
            <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #f0f0f0' }}>변경 후</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const b = before?.[key];
            const a = after?.[key];
            const changed = fmt(b) !== fmt(a);
            return (
              <tr key={key} style={{ background: changed ? '#fffbe6' : undefined }}>
                <td style={{ padding: '6px 8px', border: '1px solid #f0f0f0', fontWeight: 600 }}>
                  {key}
                </td>
                <td style={{ padding: '6px 8px', border: '1px solid #f0f0f0', fontFamily: 'monospace' }}>
                  {fmt(b)}
                </td>
                <td style={{ padding: '6px 8px', border: '1px solid #f0f0f0', fontFamily: 'monospace' }}>
                  {changed ? <Typography.Text mark>{fmt(a)}</Typography.Text> : fmt(a)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Filters {
  range: [Dayjs, Dayjs];
  userId?: string;
  action?: string;
  query?: string;
}

export function AuditLogPage() {
  // 입력 중 값과 실제 적용된 검색 조건을 분리한다 (검색 버튼/Enter로 실행).
  const [draft, setDraft] = useState<Filters>({ range: [dayjs().subtract(6, 'day'), dayjs()] });
  const [applied, setApplied] = useState<Filters>(draft);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [detailId, setDetailId] = useState<string | null>(null);

  const usersQuery = useQuery({ queryKey: ['users'], queryFn: fetchUsers });

  const searchParams = useMemo(
    () => ({
      from: applied.range[0].format('YYYY-MM-DD'),
      to: applied.range[1].format('YYYY-MM-DD'),
      userId: applied.userId,
      action: applied.action,
      query: applied.query?.trim() || undefined,
      page,
      size,
    }),
    [applied, page, size],
  );

  const logsQuery = useQuery({
    queryKey: ['audit-logs', searchParams],
    queryFn: () => searchAuditLogs(searchParams),
  });

  const detailQuery = useQuery({
    queryKey: ['audit-logs', 'detail', detailId],
    queryFn: () => fetchAuditLog(detailId!),
    enabled: !!detailId,
  });
  const detail = detailQuery.data;

  const applyFilters = () => {
    setPage(1);
    setApplied(draft);
  };

  const columns: ColumnsType<AuditLogItem> = [
    {
      title: '일시',
      dataIndex: 'occurredAt',
      width: 150,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    { title: '사용자', dataIndex: 'userName', width: 100 },
    { title: '작업', dataIndex: 'action', width: 150, render: actionTag },
    {
      title: '대상',
      key: 'target',
      render: (_, log) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{log.entityLabel ?? log.entityId}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {log.entityType} · {log.entityId}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '사유', dataIndex: 'reason', width: 220, render: (v?: string) => v ?? '-' },
    { title: 'IP', dataIndex: 'ip', width: 130 },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="감사로그 조회">
        <Row gutter={[12, 12]} align="middle">
          <Col>
            <Space size="small">
              <Typography.Text>기간</Typography.Text>
              <DatePicker.RangePicker
                value={draft.range}
                allowClear={false}
                onChange={(range) => {
                  if (range?.[0] && range[1]) {
                    setDraft((prev) => ({ ...prev, range: [range[0]!, range[1]!] }));
                  }
                }}
              />
            </Space>
          </Col>
          <Col>
            <Select
              allowClear
              placeholder="사용자"
              style={{ minWidth: 140 }}
              value={draft.userId}
              onChange={(v: string | undefined) => setDraft((prev) => ({ ...prev, userId: v }))}
              options={(usersQuery.data ?? []).map((u) => ({ value: u.id, label: u.name }))}
            />
          </Col>
          <Col>
            <Select
              allowClear
              placeholder="기능(작업)"
              style={{ minWidth: 150 }}
              value={draft.action}
              onChange={(v: string | undefined) => setDraft((prev) => ({ ...prev, action: v }))}
              options={Object.entries(ACTION_META).map(([value, meta]) => ({
                value,
                label: `${meta.label} (${value})`,
              }))}
            />
          </Col>
          <Col flex="260px">
            <Input
              allowClear
              placeholder="대상 검색 (엔티티·ID·라벨)"
              prefix={<SearchOutlined />}
              value={draft.query}
              onChange={(e) => setDraft((prev) => ({ ...prev, query: e.target.value }))}
              onPressEnter={applyFilters}
            />
          </Col>
          <Col>
            <Space>
              <Typography.Link onClick={applyFilters}>
                <SearchOutlined /> 검색
              </Typography.Link>
            </Space>
          </Col>
        </Row>
      </Card>

      <Card size="small">
        <Table<AuditLogItem>
          rowKey="id"
          size="small"
          loading={logsQuery.isLoading}
          dataSource={logsQuery.data?.data ?? []}
          columns={columns}
          pagination={{
            current: page,
            pageSize: size,
            total: logsQuery.data?.page.totalElements ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [30, 50, 100],
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setSize(nextSize);
            },
            showTotal: (total) => `총 ${total}건`,
          }}
          onRow={(log) => ({
            onClick: () => setDetailId(log.id),
            style: { cursor: 'pointer' },
          })}
          locale={{ emptyText: '조회된 감사로그가 없습니다.' }}
        />
      </Card>

      <Drawer
        title="감사로그 상세"
        width={640}
        open={!!detailId}
        onClose={() => setDetailId(null)}
        loading={detailQuery.isLoading}
      >
        {detail && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions
              size="small"
              column={1}
              bordered
              items={[
                {
                  key: 'when',
                  label: '일시',
                  children: dayjs(detail.occurredAt).format('YYYY-MM-DD HH:mm:ss'),
                },
                { key: 'who', label: '사용자', children: `${detail.userName} (${detail.userId})` },
                { key: 'action', label: '작업', children: actionTag(detail.action) },
                {
                  key: 'target',
                  label: '대상',
                  children: `${detail.entityLabel ?? '-'} — ${detail.entityType} / ${detail.entityId}`,
                },
                { key: 'reason', label: '사유', children: detail.reason ?? '-' },
                { key: 'ip', label: 'IP', children: detail.ip },
                { key: 'req', label: '요청 ID', children: detail.requestId },
                { key: 'ua', label: '단말', children: detail.userAgent ?? '-' },
              ]}
            />
            <div>
              <Typography.Title level={5}>변경 전/후 비교</Typography.Title>
              <DiffView before={detail.before} after={detail.after} />
            </div>
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
