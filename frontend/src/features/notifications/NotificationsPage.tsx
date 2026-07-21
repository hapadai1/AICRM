/**
 * MSG-001 고객 연락·발송 이력
 * - 고객 검색 → 템플릿 선택(승인 상태 표시) → 변수 입력 → 미리보기 → 발송
 * - 알림톡 실패 시 SMS 대체 발송, 발송 이력(채널/상태/실패사유/재발송)
 */
import { SendOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  Row,
  Select,
  Space,
  Switch,
  Table,
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
import { metaOf } from '../../shared/status-meta';
import { StageTemplateMappingCard } from './StageTemplateMappingCard';

export function NotificationsPage() {
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [fallbackSms, setFallbackSms] = useState(true);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
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

  // 템플릿 변경 시 미리보기 초기화
  useEffect(() => {
    setPreviewContent(null);
  }, [templateId]);

  const onApiError = (e: unknown) =>
    message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');

  const previewMutation = useMutation({
    mutationFn: () => previewNotification({ templateId: templateId!, variables }),
    onSuccess: (r) => setPreviewContent(r.content),
    onError: onApiError,
  });

  const sendMutation = useMutation({
    mutationFn: () =>
      sendNotification({
        customerId: customerId!,
        phone,
        templateId: templateId!,
        variables,
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

  const canSend =
    !!customerId && !!templateId && selectedTemplate?.status === 'APPROVED' && !!phone.trim();

  const historyColumns: ColumnsType<NotificationRecord> = [
    {
      // 미발송(요청·실패) 건은 sentAt이 null이므로 이력 생성 시각으로 대체한다.
      title: '발송일시',
      key: 'sentAt',
      width: 140,
      render: (_, record) => record.sentAt ?? record.createdAt ?? '-',
    },
    {
      title: '채널',
      dataIndex: 'channel',
      width: 90,
      render: (c: NotificationRecord['channel']) => {
        const meta = metaOf(NOTIFICATION_CHANNEL_META, c);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    { title: '템플릿', dataIndex: 'templateName', width: 160, ellipsis: true },
    {
      title: '내용',
      dataIndex: 'content',
      ellipsis: true,
      render: (v: string) => (
        <Typography.Text style={{ maxWidth: 360 }} ellipsis={{ tooltip: v }}>
          {v || '-'}
        </Typography.Text>
      ),
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: 100,
      render: (s: NotificationRecord['status']) => {
        const meta = metaOf(NOTIFICATION_STATUS_META, s);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '실패 사유',
      dataIndex: 'failReason',
      width: 200,
      render: (v?: string) => v ?? '-',
    },
    {
      title: '작업',
      key: 'action',
      width: 100,
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
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 어느 시점에 어떤 문구를 제안할지 (개발설계서 05 G-06) */}
      <StageTemplateMappingCard />

      <Card size="small" title="고객에게 직접 보내기">
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
      </Card>

      {!customerId ? (
        <Card>
          <Empty description="메시지를 발송할 고객을 선택해 주세요." />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={10}>
            <Card size="small" title="템플릿 발송">
              <Form layout="vertical">
                <Form.Item label="수신 전화번호" required>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
                </Form.Item>
                <Form.Item
                  label="템플릿"
                  required
                  help={
                    selectedTemplate && selectedTemplate.status !== 'APPROVED'
                      ? '승인된 템플릿만 발송할 수 있습니다.'
                      : undefined
                  }
                  validateStatus={
                    selectedTemplate && selectedTemplate.status !== 'APPROVED' ? 'warning' : undefined
                  }
                >
                  <Select
                    placeholder="템플릿 선택"
                    loading={templatesQuery.isLoading}
                    value={templateId ?? undefined}
                    onChange={(v: string) => setTemplateId(v)}
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
                    <Typography.Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap' }}>
                      {selectedTemplate.content}
                    </Typography.Paragraph>
                    {/* 템플릿에 변수 목록 컬럼이 없어 본문 `#{이름}` 자리에서 추출한다. */}
                    {selectedTemplate.variables.map((name) => (
                      <Form.Item key={name} label={`변수: ${name}`} required>
                        <Input
                          value={variables[name] ?? ''}
                          onChange={(e) =>
                            setVariables((prev) => ({ ...prev, [name]: e.target.value }))
                          }
                          placeholder={`#{${name}} 값 입력`}
                        />
                      </Form.Item>
                    ))}
                  </>
                )}

                <Form.Item label="알림톡 실패 시 SMS 대체 발송">
                  <Switch checked={fallbackSms} onChange={setFallbackSms} />
                </Form.Item>

                <Space>
                  <Button
                    disabled={!templateId}
                    loading={previewMutation.isPending}
                    onClick={() => previewMutation.mutate()}
                  >
                    미리보기
                  </Button>
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
                </Space>

                {previewContent && (
                  <Card size="small" style={{ marginTop: 12, background: '#fffbe6' }}>
                    <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>
                      {previewContent}
                    </Typography.Text>
                  </Card>
                )}
              </Form>
            </Card>
          </Col>

          <Col xs={24} lg={14}>
            <Card size="small" title={`발송 이력${selectedCustomer ? ` — ${selectedCustomer.name}` : ''}`}>
              <Table<NotificationRecord>
                rowKey="id"
                size="small"
                loading={historyQuery.isLoading}
                dataSource={historyQuery.data ?? []}
                columns={historyColumns}
                pagination={{ pageSize: 10, showSizeChanger: false }}
                locale={{ emptyText: '발송 이력이 없습니다.' }}
                scroll={{ x: 900 }}
              />
            </Card>
          </Col>
        </Row>
      )}
    </Space>
  );
}
