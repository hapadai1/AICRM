/**
 * MSG-001 고객 연락·발송 이력
 * - 고객 검색 → (선택) 템플릿으로 문구 불러오기 → 문구 작성·수정 → 발송
 * - 템플릿 없이 문구만 써서 보낼 수도 있다. 단, 알림톡은 승인 문구 그대로일 때만 나가고
 *   직접 쓰거나 고친 문구는 SMS로 발송된다(백엔드 `notifications.service.send`).
 * - 알림톡 실패 시 SMS 대체 발송, 발송 이력(채널/상태/실패사유/재발송)
 */
import { SendOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Col,
  Empty,
  Form,
  Input,
  Row,
  Select,
  Space,
  Switch,
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
  fetchCustomerNotifications,
  fetchNotificationTemplates,
  previewNotification,
  retryNotification,
  searchCustomers,
  sendNotification,
} from '../../api/notifications';
import type { NotificationRecord } from '../../api/notifications';
import { Can } from '../../shared/Can';
import { autoWidth } from '../../shared/table-width';
import { metaOf } from '../../shared/status-meta';
import { DataTable } from '../../shared/DataTable';
import { PageCard, PageShell } from '../../shared/PageShell';
import { StageTemplateMappingCard } from './StageTemplateMappingCard';

export function NotificationsPage() {
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [fallbackSms, setFallbackSms] = useState(true);
  /** 실제로 나갈 문구. 템플릿을 고르면 치환 결과가 채워지고, 그 위에서 자유롭게 고쳐 쓴다. */
  const [body, setBody] = useState('');
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const customersQuery = useQuery({
    queryKey: ['customers', 'search', customerSearch],
    queryFn: () => searchCustomers(customerSearch),
  });

  const templatesQuery = useQuery({
    queryKey: ['notification-templates'],
    queryFn: fetchNotificationTemplates,
  });

  const historyQuery = useQuery({
    queryKey: ['customers', customerId, 'notifications'],
    queryFn: () => fetchCustomerNotifications(customerId!),
    enabled: !!customerId,
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

  const onApiError = (e: unknown) =>
    message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');

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
        message.success('메시지가 발송되었습니다.');
      }
      void queryClient.invalidateQueries({ queryKey: ['customers', customerId, 'notifications'] });
    },
    onError: onApiError,
  });

  const retryMutation = useMutation({
    mutationFn: retryNotification,
    onSuccess: () => {
      message.success('재발송되었습니다.');
      void queryClient.invalidateQueries({ queryKey: ['customers', customerId, 'notifications'] });
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

  const historyColumns: ColumnsType<NotificationRecord> = [
    {
      // 미발송(요청·실패) 건은 sentAt이 null이므로 이력 생성 시각으로 대체한다.
      title: '발송일시',
      key: 'sentAt',
      ...autoWidth(),
      render: (_, record) => record.sentAt ?? record.createdAt ?? '-',
    },
    {
      title: '채널',
      dataIndex: 'channel',
      ...autoWidth(),
      render: (c: NotificationRecord['channel']) => {
        const meta = metaOf(NOTIFICATION_CHANNEL_META, c);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '템플릿',
      dataIndex: 'templateName',
      // 열 ellipsis 옵션은 표 전체를 고정 레이아웃으로 되돌린다. 셀 안에서 잘라 자동 폭을 유지한다.
      render: (v?: string) => (
        <Typography.Text style={{ maxWidth: 200 }} ellipsis={{ tooltip: v }}>
          {v || '-'}
        </Typography.Text>
      ),
    },
    {
      title: '내용',
      dataIndex: 'content',
      render: (v: string) => (
        <Typography.Text style={{ maxWidth: 360 }} ellipsis={{ tooltip: v }}>
          {v || '-'}
        </Typography.Text>
      ),
    },
    {
      title: '상태',
      dataIndex: 'status',
      ...autoWidth(),
      render: (s: NotificationRecord['status']) => {
        const meta = metaOf(NOTIFICATION_STATUS_META, s);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '실패 사유',
      dataIndex: 'failReason',
      render: (v?: string) => (
        <Typography.Text style={{ maxWidth: 240 }} ellipsis={{ tooltip: v }}>
          {v ?? '-'}
        </Typography.Text>
      ),
    },
    {
      title: '작업',
      key: 'action',
      ...autoWidth(),
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

  return (
    <PageShell>
      {/* 어느 시점에 어떤 문구를 제안할지 (개발설계서 05 G-06) */}
      <StageTemplateMappingCard />

      <PageCard title="고객에게 직접 보내기">
        <Space wrap>
          <Typography.Text>고객 선택</Typography.Text>
          <Select
            showSearch
            allowClear
            placeholder="고객명·전화번호 검색"
            style={{ minWidth: 320 }}
            filterOption={false}
            onSearch={setCustomerSearch}
            loading={customersQuery.isLoading}
            value={customerId ?? undefined}
            options={(customersQuery.data?.data ?? []).map((c) => ({
              value: c.id,
              label: `${c.name} · ${c.phone}${c.customerStatus === 'PROSPECT' ? ' (미계약)' : ''}`,
            }))}
            onChange={(v: string | undefined) => setCustomerId(v ?? null)}
            notFoundContent={customersQuery.isFetching ? '검색 중…' : '검색 결과가 없습니다.'}
          />
        </Space>
      </PageCard>

      {!customerId ? (
        <PageCard>
          <Empty description="메시지를 발송할 고객을 선택해 주세요." />
        </PageCard>
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={10}>
            <PageCard title="문구 작성·발송">
              <Form layout="vertical">
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
                          onChange={(e) =>
                            setVariables((prev) => ({ ...prev, [name]: e.target.value }))
                          }
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
          </Col>

          <Col xs={24} lg={14}>
            <PageCard title={`발송 이력${selectedCustomer ? ` — ${selectedCustomer.name}` : ''}`}>
              <DataTable<NotificationRecord>
                rowKey="id"
                size="small"
                loading={historyQuery.isLoading}
                dataSource={historyQuery.data ?? []}
                columns={historyColumns}
                pagination={{ pageSize: 10, showSizeChanger: false }}
                locale={{ emptyText: '발송 이력이 없습니다.' }}
              />
            </PageCard>
          </Col>
        </Row>
      )}
    </PageShell>
  );
}
