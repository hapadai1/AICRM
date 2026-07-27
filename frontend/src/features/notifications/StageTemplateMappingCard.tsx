import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Card, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  fetchJourneyStages,
  trackTypeLabel,
  updateStageTemplate,
  TRACK_TYPES,
  type JourneyStage,
  type TrackType,
} from '../../api/journeys';
import { fetchNotificationTemplates } from '../../api/notifications';
import { Can } from '../../shared/Can';

/**
 * 단계별 연락 문구 매핑 (개발설계서 05 G-06).
 *
 * 어느 시점에 어떤 문구를 제안할지 관리자가 정한다. 문구를 비우면 그 시점에는
 * 확인창이 뜨지 않는다. 자동 발송 설정은 없다 — 발송은 항상 확인창을 거친다.
 *
 * 수선(REPAIR)도 v2에서 진행 트랙이 되었으므로 다른 트랙과 같은 journey_stages
 * 경로로 관리한다(설계서 v2 02 §8 연락 경로 일원화). 구 `notification_rules(REPAIR:*)`
 * 경로는 발송에 쓰이지 않으므로 화면에서 다루지 않는다.
 */

type Row = { id: string; when: string; templateId: string | null };

export function StageTemplateMappingCard() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [trackType, setTrackType] = useState<TrackType>('CUSTOM');

  const templatesQuery = useQuery({ queryKey: ['notification-templates'], queryFn: fetchNotificationTemplates });
  const stagesQuery = useQuery({
    queryKey: ['journey-stages', trackType],
    queryFn: () => fetchJourneyStages(trackType),
  });

  const stageMutation = useMutation({
    mutationFn: (v: { id: string; templateId: string | null }) =>
      updateStageTemplate(v.id, v.templateId),
    onSuccess: () => {
      message.success('문구를 연결했습니다.');
      void queryClient.invalidateQueries({ queryKey: ['journey-stages'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '변경에 실패했습니다.'),
  });

  const templateOptions = (templatesQuery.data ?? []).map((t) => ({
    value: t.id,
    label: t.name,
  }));

  /** 이름만 보고 연결하지 않도록 본문을 함께 보여준다. 원문 편집은 관리자 > 연락 문구. */
  const bodyOf = (templateId: string | null) =>
    (templatesQuery.data ?? []).find((t) => t.id === templateId)?.content ?? '';

  const rows: Row[] = (stagesQuery.data ?? []).map((s: JourneyStage) => ({
    id: s.id,
    when: `${s.sequenceNo}. ${s.name}`,
    templateId: s.templateId,
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
            allowClear
            placeholder="연락하지 않음"
            value={v ?? undefined}
            options={templateOptions}
            loading={templatesQuery.isLoading}
            onChange={(next?: string) =>
              stageMutation.mutate({ id: r.id, templateId: next ?? null })
            }
          />
        </Can>
      ),
    },
    {
      title: '문구 내용',
      key: 'body',
      render: (_, r) => {
        const body = bodyOf(r.templateId);
        return body ? (
          <Typography.Text style={{ maxWidth: 420 }} ellipsis={{ tooltip: body }}>
            {body}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        );
      },
    },
  ];

  return (
    <Card
      size="small"
      title="단계별 연락 문구"
      extra={
        <Segmented
          size="small"
          value={trackType}
          onChange={(v) => setTrackType(v as TrackType)}
          options={TRACK_TYPES.map((t) => ({ label: trackTypeLabel(t), value: t }))}
        />
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        담당자가 진행 카드에서 이 단계를 완료하면 문구를 확인하는 창이 뜹니다. 자동으로
        발송되지 않습니다. 문구 원문은 <b>관리자 &gt; 연락 문구</b>에서 고칩니다.
      </Typography.Paragraph>
      <Table<Row>
        rowKey="id"
        scroll={{ x: 'max-content' }}
        size="small"
        pagination={false}
        loading={stagesQuery.isLoading}
        dataSource={rows}
        columns={columns}
      />
    </Card>
  );
}
