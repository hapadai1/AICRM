/**
 * AUDIT-001 감사로그 조회
 * - 기간(기본 최근 7일)/사용자/기능(액션)/대상 검색
 * - 상세 드로어: 변경 전/후 JSON 비교(변경 필드 강조), IP·요청 ID·사유
 * 표시(문장·라벨·비교표)는 audit-log-format이 담당한다.
 */
import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  Row,
  Select,
  Space,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { fetchAuditLog, fetchUsers, searchAuditLogs } from '../../api/admin';
import type { AuditLogItem } from '../../api/admin';
import { DataTable } from '../../shared/DataTable';
import { PageCard, PageShell } from '../../shared/PageShell';
import {
  ACTION_META,
  actionTag,
  CHANGES_INLINE_LIMIT,
  changeMode,
  changeSentence,
  changedKeys,
  DiffView,
  ENTITY_MENU_LABELS,
  ENTITY_TYPE_LABELS,
  fieldLabel,
  fmtInline,
  nameKeySet,
  SINGLE_COLUMN_TITLE,
  targetFlow,
} from './audit-log-format';

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
    { title: '사용자', dataIndex: 'userName', width: 140 },
    { title: '작업', dataIndex: 'action', width: 150, render: actionTag },
    {
      // 엔티티 코드·UUID는 목록에서 뺐다 — 줄마다 40자를 차지하면서 정작 궁금한
      // "무엇이 어떻게 바뀌었나"를 오른쪽으로 밀어냈다. 전문은 상세 드로어에서 본다.
      // 대신 대상 이름을 "정장 옵션 버전 2 → 삭제됨" 처럼 전/후로 보여준다 —
      // 유형만으로는 어느 화면의 무엇이 어떻게 됐는지 알 수 없다.
      title: '대상',
      key: 'target',
      width: 200,
      render: (_, log) => {
        const type = ENTITY_TYPE_LABELS[log.entityType] ?? log.entityType;
        const flow = targetFlow(log);
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 12 }}>
              {flow.from && (
                <>
                  <Typography.Text strong={flow.removed} style={{ fontSize: 12 }}>
                    {flow.from}
                  </Typography.Text>
                  {' → '}
                </>
              )}
              <Typography.Text
                strong={!flow.removed}
                type={flow.removed ? 'danger' : undefined}
                style={{ fontSize: 12 }}
              >
                {flow.to}
              </Typography.Text>
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {type}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      // 첫 줄은 "뭘 어떻게 했다"는 문장, 아랫줄은 그 근거가 되는 값이다.
      // 대상 칸과 이름이 겹치더라도 목록만 훑어서 무슨 일이 있었는지 알 수 있는 쪽을 택했다.
      title: '변경 내용',
      key: 'changes',
      render: (_, log) => {
        const changed = changedKeys(log.before, log.after);
        const mode = changeMode(log);
        // 이름·버전은 문장에 이미 들어 있다 — 값 줄에서는 나머지만 보여준다.
        const named = nameKeySet(log.entityType);
        const withoutName = changed.filter((key) => !named.has(key));
        const keys = withoutName.length > 0 ? withoutName : changed;
        const shown = keys.slice(0, CHANGES_INLINE_LIMIT);
        const values = shown
          .map((key) => {
            const label = fieldLabel(log.entityType, key);
            if (mode === 'diff') {
              const from = fmtInline(key, log.before?.[key], log.entityType);
              const to = fmtInline(key, log.after?.[key], log.entityType);
              return `${label} ${from} → ${to}`;
            }
            const v = mode === 'before' ? log.before?.[key] : log.after?.[key];
            return `${label} ${fmtInline(key, v, log.entityType)}`;
          })
          .join(' · ');
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text strong style={{ fontSize: 12 }}>
              {changeSentence(log)}
            </Typography.Text>
            {shown.length > 0 && (
              // 값만 나열하면 "지금 이런 상태"로 읽힌다 — 언제 시점의 값인지 먼저 밝힌다.
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {mode === 'diff' ? '' : `${SINGLE_COLUMN_TITLE[mode]} · `}
                {values}
                {keys.length > shown.length && ` · 외 ${keys.length - shown.length}건`}
              </Typography.Text>
            )}
          </Space>
        );
      },
    },
    { title: '사유', dataIndex: 'reason', width: 200, render: (v?: string) => v ?? '-' },
    { title: 'IP', dataIndex: 'ip', width: 130, render: (v?: string) => v ?? '-' },
  ];

  return (
    <PageShell>
      {/* 제목은 헤더가 "감사로그"로 보여 준다 — 카드에서 반복하지 않는다. */}
      <PageCard>
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
            <Button type="primary" icon={<SearchOutlined />} onClick={applyFilters}>
              검색
            </Button>
          </Col>
        </Row>
      </PageCard>

      <PageCard>
        <DataTable<AuditLogItem>
          rowKey="id"
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
      </PageCard>

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
                  key: 'summary',
                  label: '요약',
                  children: (
                    <Typography.Text strong>{`${detail.userName} — ${changeSentence(detail)}`}</Typography.Text>
                  ),
                },
                {
                  key: 'when',
                  label: '일시',
                  children: dayjs(detail.occurredAt).format('YYYY-MM-DD HH:mm:ss'),
                },
                { key: 'who', label: '사용자', children: detail.userName },
                { key: 'action', label: '작업', children: actionTag(detail.action) },
                {
                  key: 'target',
                  label: '대상',
                  children: (() => {
                    const flow = targetFlow(detail);
                    const type = ENTITY_TYPE_LABELS[detail.entityType] ?? detail.entityType;
                    const name = flow.from ? `${flow.from} → ${flow.to}` : flow.to;
                    return name === type ? type : `${name} — ${type}`;
                  })(),
                },
                {
                  key: 'menu',
                  label: '메뉴',
                  children: ENTITY_MENU_LABELS[detail.entityType] ?? '-',
                },
                {
                  // 식별자는 문의·재현 때만 필요하다 — 대상 이름 아래로 내렸다.
                  key: 'identity',
                  label: '식별자',
                  children: `${detail.entityType} / ${detail.entityId}`,
                },
                { key: 'reason', label: '사유', children: detail.reason ?? '-' },
                { key: 'ip', label: 'IP', children: detail.ip ?? '-' },
              ]}
            />
            <div>
              <Typography.Title level={5}>변경 전/후 비교</Typography.Title>
              <DiffView
                before={detail.before}
                after={detail.after}
                entityType={detail.entityType}
              />
            </div>
          </Space>
        )}
      </Drawer>
    </PageShell>
  );
}

