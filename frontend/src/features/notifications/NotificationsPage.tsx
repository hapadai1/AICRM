/**
 * MSG-001 고객 연락 · 발송 이력
 * - 두 개의 탭으로 나뉜다.
 *   · 발송 이력: 고객을 고르지 않아도 **전체 발송 이력**이 기본으로 보인다(고객명·전화번호 검색·상태 필터).
 *     진행 단계·수선에서 확인창으로 보낸 연락도 모두 여기 이력으로 남아 함께 보인다.
 *   · 직접 발송: 고객을 골라 문구를 작성·수정해 보낸다. 여기서 보낸 것도 발송 이력에 그대로 쌓인다.
 * - 템플릿 없이 문구만 써서 보낼 수도 있다. 단, 알림톡은 승인 문구 그대로일 때만 나가고
 *   직접 쓰거나 고친 문구는 SMS로 발송된다(백엔드 `notifications.service.send`).
 * - 문구 원문·단계별 매핑 설정은 `관리자 > 연락 문구`에 있다.
 */
import { SendOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  NOTIFICATION_CHANNEL_META,
  NOTIFICATION_STATUS_META,
  TEMPLATE_STATUS_META,
  fetchNotifications,
  fetchNotificationTemplates,
  previewNotification,
  retryNotification,
  searchCustomers,
  sendNotification,
} from '../../api/notifications';
import type { NotificationRecord, NotificationStatus } from '../../api/notifications';
import { Can } from '../../shared/Can';
import { formatPhone } from '../../shared/phone';
import { COL } from '../../shared/table-width';
import { metaOf } from '../../shared/status-meta';
import { DataTable } from '../../shared/DataTable';
import { PageCard, PageShell } from '../../shared/PageShell';

/** 이력 탭 상태 필터 옵션 */
const STATUS_FILTER_OPTIONS: { value: NotificationStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: '전체 상태' },
  { value: 'SENT', label: '성공' },
  { value: 'FAILED', label: '실패' },
  { value: 'REQUESTED', label: '발송 요청' },
];

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const onApiError = (e: unknown) =>
    message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');

  const invalidateHistory = () =>
    void queryClient.invalidateQueries({ queryKey: ['notifications', 'list'] });

  // ── 발송 이력 탭 (기본) ────────────────────────────────────────────────
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<NotificationStatus | 'ALL'>('ALL');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);

  const historyQuery = useQuery({
    queryKey: ['notifications', 'list', { keyword, statusFilter, page, size }],
    queryFn: () =>
      fetchNotifications({
        q: keyword || undefined,
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        page,
        size,
      }),
  });

  const retryMutation = useMutation({
    mutationFn: retryNotification,
    onSuccess: () => {
      message.success('재발송되었습니다.');
      invalidateHistory();
    },
    onError: onApiError,
  });

  const historyColumns: ColumnsType<NotificationRecord> = [
    {
      title: '발송일시',
      key: 'sentAt',
      width: COL.datetime,
      // 미발송(요청·실패) 건은 sentAt이 null이므로 이력 생성 시각으로 대체한다.
      render: (_, record) => record.sentAt ?? record.createdAt ?? '-',
    },
    {
      title: '고객',
      key: 'customer',
      width: COL.wide,
      render: (_, record) => (
        <Typography.Text style={{ maxWidth: 180 }} ellipsis={{ tooltip: `${record.customerName ?? ''} ${formatPhone(record.phone)}` }}>
          {record.customerName ?? '-'}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {' '}
            {formatPhone(record.phone)}
          </Typography.Text>
        </Typography.Text>
      ),
    },
    {
      title: '채널',
      dataIndex: 'channel',
      width: COL.status,
      render: (c: NotificationRecord['channel']) => {
        const meta = metaOf(NOTIFICATION_CHANNEL_META, c);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '템플릿',
      dataIndex: 'templateName',
      width: COL.wide,
      render: (v?: string) => (
        <Typography.Text style={{ maxWidth: 160 }} ellipsis={{ tooltip: v }}>
          {v || '-'}
        </Typography.Text>
      ),
    },
    {
      title: '내용',
      dataIndex: 'content',
      width: COL.text,
      render: (v: string) => (
        <Typography.Text style={{ maxWidth: 360 }} ellipsis={{ tooltip: v }}>
          {v || '-'}
        </Typography.Text>
      ),
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: COL.status,
      render: (s: NotificationRecord['status']) => {
        const meta = metaOf(NOTIFICATION_STATUS_META, s);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '실패 사유',
      dataIndex: 'failReason',
      width: COL.text,
      render: (v?: string) => (
        <Typography.Text style={{ maxWidth: 220 }} ellipsis={{ tooltip: v }}>
          {v ?? '-'}
        </Typography.Text>
      ),
    },
    {
      title: '작업',
      key: 'action',
      width: COL.action1,
      render: (_, record) =>
        record.status === 'FAILED' ? (
          <Can permission="NOTIFICATION_SEND">
            <Button
              size="small"
              loading={retryMutation.isPending && retryMutation.variables === record.id}
              onClick={() => retryMutation.mutate(record.id)}
            >
              재발송
            </Button>
          </Can>
        ) : null,
    },
  ];

  const historyTab = (
    <PageCard title="발송 이력">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="고객명·전화번호 검색"
            style={{ width: 260 }}
            defaultValue={keyword}
            onSearch={(v) => {
              setKeyword(v.trim());
              setPage(1);
            }}
          />
          <Select
            style={{ width: 140 }}
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
            options={STATUS_FILTER_OPTIONS}
          />
        </Space>
        <DataTable<NotificationRecord>
          rowKey="id"
          size="small"
          loading={historyQuery.isLoading}
          dataSource={historyQuery.data?.data ?? []}
          columns={historyColumns}
          pagination={{
            current: page,
            pageSize: size,
            total: historyQuery.data?.page.totalElements ?? 0,
            onChange: (nextPage, nextSize) => {
              setPage(nextSize !== size ? 1 : nextPage);
              setSize(nextSize);
            },
          }}
          locale={{ emptyText: '발송 이력이 없습니다.' }}
        />
      </Space>
    </PageCard>
  );

  // ── 직접 발송 탭 ──────────────────────────────────────────────────────
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [fallbackSms, setFallbackSms] = useState(true);
  /** 실제로 나갈 문구. 템플릿을 고르면 치환 결과가 채워지고, 그 위에서 자유롭게 고쳐 쓴다. */
  const [body, setBody] = useState('');

  const customersQuery = useQuery({
    queryKey: ['customers', 'search', customerSearch],
    queryFn: () => searchCustomers(customerSearch),
  });

  const templatesQuery = useQuery({
    queryKey: ['notification-templates'],
    queryFn: fetchNotificationTemplates,
  });

  const selectedCustomer = useMemo(
    () => (customersQuery.data?.data ?? []).find((c) => c.id === customerId),
    [customersQuery.data, customerId],
  );

  const selectedTemplate = useMemo(
    () => (templatesQuery.data ?? []).find((t) => t.id === templateId),
    [templatesQuery.data, templateId],
  );

  // 고객 선택 시 수신번호·고객명 변수 기본값 채우기
  useEffect(() => {
    if (selectedCustomer) {
      setPhone(selectedCustomer.phone);
      setVariables((prev) => ({ ...prev, 고객명: selectedCustomer.name }));
    }
  }, [selectedCustomer]);

  /** 템플릿 문구를 변수까지 치환해 입력란에 채운다(기존 내용은 덮어쓴다). */
  const loadMutation = useMutation({
    mutationFn: () => previewNotification({ templateId: templateId!, variables }),
    onSuccess: (r) => setBody(r.content),
    onError: onApiError,
  });

  // 템플릿을 고르면 그 문구를 입력란에 채워 준다. 이후 편집은 담당자 몫이다.
  useEffect(() => {
    if (templateId) loadMutation.mutate();
    // 변수 편집 중 자동 덮어쓰기를 막기 위해 템플릿 변경에만 반응한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  const sendMutation = useMutation({
    mutationFn: () =>
      sendNotification({
        customerId: customerId!,
        phone,
        templateId: templateId ?? undefined,
        variables,
        body,
        fallbackSms,
      }),
    onSuccess: ({ results }) => {
      const failed = results.find((r) => r.channel === 'ALIMTALK' && r.status === 'FAILED');
      const smsFallback = results.find((r) => r.channel === 'SMS' && r.status === 'SENT');
      if (failed && smsFallback) {
        message.warning('알림톡 발송에 실패해 SMS로 대체 발송되었습니다.');
      } else if (results.every((r) => r.status === 'FAILED')) {
        message.error(`발송에 실패했습니다. (${results[0]?.failReason ?? '사유 미상'})`);
      } else {
        message.success('메시지가 발송되었습니다. 발송 이력 탭에서 확인할 수 있습니다.');
      }
      invalidateHistory();
    },
    onError: onApiError,
  });

  // 템플릿은 선택 사항이다. 보낼 문구와 받는 번호만 있으면 발송할 수 있다.
  const canSend = !!customerId && !!phone.trim() && !!body.trim();
  /** 승인된 템플릿 문구를 그대로 보낼 때만 알림톡이 나간다. */
  const sendChannel =
    selectedTemplate?.status === 'APPROVED' && body === loadMutation.data?.content
      ? selectedTemplate.channel
      : 'SMS';

  const composeTab = (
    <PageCard title="고객에게 직접 보내기">
      <Form layout="vertical" style={{ maxWidth: 560 }}>
        <Form.Item label="고객" required>
          <Select
            showSearch
            allowClear
            placeholder="고객명·전화번호 검색"
            filterOption={false}
            onSearch={setCustomerSearch}
            loading={customersQuery.isLoading}
            value={customerId ?? undefined}
            options={(customersQuery.data?.data ?? []).map((c) => ({
              value: c.id,
              label: `${c.name} · ${formatPhone(c.phone)}${c.customerStatus === 'PROSPECT' ? ' (미계약)' : ''}`,
            }))}
            onChange={(v: string | undefined) => setCustomerId(v ?? null)}
            notFoundContent={customersQuery.isFetching ? '검색 중…' : '검색 결과가 없습니다.'}
          />
        </Form.Item>

        <Form.Item label="수신 전화번호" required>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Form.Item>

        <Form.Item
          label="템플릿 (선택)"
          help="템플릿을 고르면 문구를 채워 줍니다. 고르지 않고 직접 써도 됩니다."
        >
          <Select
            allowClear
            placeholder="템플릿 선택"
            loading={templatesQuery.isLoading}
            value={templateId ?? undefined}
            onChange={(v?: string) => setTemplateId(v ?? null)}
            optionLabelProp="label"
            options={(templatesQuery.data ?? []).map((t) => ({
              value: t.id,
              label: `${t.name} [${metaOf(TEMPLATE_STATUS_META, t.status).label}]`,
              status: t.status,
            }))}
            optionRender={(option) => {
              const meta = metaOf(TEMPLATE_STATUS_META, option.data.status as string);
              const name = String(option.data.label).replace(/ \[.+\]$/, '');
              return (
                <Space>
                  {name}
                  <Tag color={meta.color}>{meta.label}</Tag>
                </Space>
              );
            }}
          />
        </Form.Item>

        {selectedTemplate && (
          <>
            {/* 템플릿에 변수 목록 컬럼이 없어 본문 `#{이름}` 자리에서 추출한다. */}
            {selectedTemplate.variables.map((name) => (
              <Form.Item key={name} label={`변수: ${name}`}>
                <Input
                  value={variables[name] ?? ''}
                  onChange={(e) => setVariables((prev) => ({ ...prev, [name]: e.target.value }))}
                  placeholder={`#{${name}} 값 입력`}
                />
              </Form.Item>
            ))}
            <Form.Item>
              <Button
                size="small"
                loading={loadMutation.isPending}
                onClick={() => loadMutation.mutate()}
              >
                템플릿 문구 다시 불러오기
              </Button>
            </Form.Item>
          </>
        )}

        <Form.Item
          label="보낼 문구"
          required
          help={
            sendChannel === 'SMS' && selectedTemplate?.channel === 'ALIMTALK'
              ? '승인 문구가 아니므로 SMS로 발송됩니다.'
              : `${metaOf(NOTIFICATION_CHANNEL_META, sendChannel).label}으로 발송됩니다.`
          }
        >
          <Input.TextArea
            rows={7}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="고객에게 보낼 내용을 입력하세요."
            showCount
          />
        </Form.Item>

        <Form.Item label="알림톡 실패 시 SMS 대체 발송">
          <Switch
            checked={fallbackSms}
            onChange={setFallbackSms}
            disabled={sendChannel !== 'ALIMTALK'}
          />
        </Form.Item>

        <Can permission="NOTIFICATION_SEND">
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={!canSend}
            loading={sendMutation.isPending}
            onClick={() => sendMutation.mutate()}
          >
            발송
          </Button>
        </Can>
      </Form>
    </PageCard>
  );

  return (
    <PageShell>
      <Tabs
        defaultActiveKey="history"
        items={[
          { key: 'history', label: '발송 이력', children: historyTab },
          { key: 'compose', label: '직접 발송', children: composeTab },
        ]}
      />
    </PageShell>
  );
}
