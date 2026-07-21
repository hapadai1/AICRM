import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Card, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  fetchJourneyStages,
  trackTypeLabel,
  updateStageTemplate,
  type JourneyStage,
  type TrackType,
} from '../../api/journeys';
import {
  fetchNotificationRules,
  fetchNotificationTemplates,
  updateNotificationRule,
  type NotificationRule,
} from '../../api/notifications';
import { Can } from '../../shared/Can';

/**
 * 단계별 연락 문구 매핑 (개발설계서 05 G-06).
 *
 * 어느 시점에 어떤 문구를 제안할지 관리자가 정한다. 문구를 비우면 그 시점에는
 * 확인창이 뜨지 않는다. 자동 발송 설정은 없다 — 발송은 항상 확인창을 거친다.
 */

type Row =
  | { kind: 'STAGE'; id: string; when: string; templateId: string | null; enabled: true }
  | { kind: 'RULE'; id: string; when: string; templateId: string | null; enabled: boolean };

export function StageTemplateMappingCard() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [trackType, setTrackType] = useState<TrackType | 'REPAIR'>('CUSTOM');

  const templatesQuery = useQuery({ queryKey: ['notification-templates'], queryFn: fetchNotificationTemplates });
  const stagesQuery = useQuery({
    queryKey: ['journey-stages', trackType],
    queryFn: () => fetchJourneyStages(trackType as TrackType),
    enabled: trackType !== 'REPAIR',
  });
  const rulesQuery = useQuery({
    queryKey: ['notification-rules'],
    queryFn: fetchNotificationRules,
    enabled: trackType === 'REPAIR',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['journey-stages'] });
    void queryClient.invalidateQueries({ queryKey: ['notification-rules'] });
  };

  const stageMutation = useMutation({
    mutationFn: (v: { id: string; templateId: string | null }) =>
      updateStageTemplate(v.id, v.templateId),
    onSuccess: () => {
      message.success('문구를 연결했습니다.');
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '변경에 실패했습니다.'),
  });

  const ruleMutation = useMutation({
    mutationFn: (v: { id: string; templateId?: string; active?: boolean }) =>
      updateNotificationRule(v.id, { templateId: v.templateId, active: v.active }),
    onSuccess: () => {
      message.success('변경했습니다.');
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '변경에 실패했습니다.'),
  });

  const templateOptions = (templatesQuery.data ?? []).map((t) => ({
    value: t.id,
    label: t.name,
  }));

  const REPAIR_TRIGGER_LABELS: Record<string, string> = {
    'REPAIR:RECEIVED': '수선 접수',
    'REPAIR:CUSTOMER_NOTIFIED': '수선 완료',
  };

  const rows: Row[] =
    trackType === 'REPAIR'
      ? (rulesQuery.data ?? [])
          .filter((r: NotificationRule) => r.triggerType.startsWith('REPAIR:'))
          .map((r) => ({
            kind: 'RULE' as const,
            id: r.id,
            when: REPAIR_TRIGGER_LABELS[r.triggerType] ?? r.triggerType,
            templateId: r.templateId,
            enabled: r.active,
          }))
      : (stagesQuery.data ?? []).map((s: JourneyStage) => ({
          kind: 'STAGE' as const,
          id: s.id,
          when: `${s.sequenceNo}. ${s.name}`,
          templateId: s.templateId,
          enabled: true as const,
        }));

  const columns: ColumnsType<Row> = [
    {
      title: '연락 시점',
      dataIndex: 'when',
      width: 200,
      render: (v: string, r) => (
        <Space>
          {v}
          {r.templateId ? <Tag color="blue">연락</Tag> : <Tag>없음</Tag>}
        </Space>
      ),
    },
    {
      title: '보낼 문구',
      dataIndex: 'templateId',
      render: (v: string | null, r) => (
        <Can permission="ADMIN_MASTER_EDIT">
          <Select
            style={{ minWidth: 260 }}
            allowClear={r.kind === 'STAGE'}
            placeholder="연락하지 않음"
            value={v ?? undefined}
            options={templateOptions}
            loading={templatesQuery.isLoading}
            onChange={(next?: string) => {
              if (r.kind === 'STAGE') {
                stageMutation.mutate({ id: r.id, templateId: next ?? null });
              } else if (next) {
                ruleMutation.mutate({ id: r.id, templateId: next });
              }
            }}
          />
        </Can>
      ),
    },
    ...(trackType === 'REPAIR'
      ? [
          {
            title: '사용',
            dataIndex: 'enabled',
            width: 80,
            render: (v: boolean, r: Row) => (
              <Can permission="ADMIN_MASTER_EDIT">
                <Switch
                  checked={v}
                  onChange={(checked) => ruleMutation.mutate({ id: r.id, active: checked })}
                />
              </Can>
            ),
          } as ColumnsType<Row>[number],
        ]
      : []),
  ];

  return (
    <Card
      size="small"
      title="단계별 연락 문구"
      extra={
        <Segmented
          size="small"
          value={trackType}
          onChange={(v) => setTrackType(v as TrackType | 'REPAIR')}
          options={[
            { label: trackTypeLabel('CUSTOM'), value: 'CUSTOM' },
            { label: trackTypeLabel('RENTAL'), value: 'RENTAL' },
            { label: '수선', value: 'REPAIR' },
          ]}
        />
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        담당자가 이 시점으로 상태를 바꾸면 문구를 확인하는 창이 뜹니다. 자동으로 발송되지
        않습니다.
      </Typography.Paragraph>
      <Table<Row>
        rowKey="id"
        size="small"
        pagination={false}
        loading={stagesQuery.isLoading || rulesQuery.isLoading}
        dataSource={rows}
        columns={columns}
      />
    </Card>
  );
}
