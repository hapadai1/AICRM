import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Radio, Space, Table, Tag, Typography } from 'antd';
import type { RadioChangeEvent } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  deleteStageMessage,
  fetchJourneyStages,
  trackTypeLabel,
  TRACK_TYPES,
  type JourneyStage,
  type StageMessage,
  type TrackType,
} from '../../api/journeys';
import {
  AUTO_VARIABLES,
  NOTIFICATION_CHANNEL_META,
  TEMPLATE_STATUS_META,
  extractTemplateVariables,
} from '../../api/notifications';
import { useAuthStore } from '../../app/auth-store';
import { PageCard } from '../../shared/PageShell';
import { metaOf } from '../../shared/status-meta';
import { COL } from '../../shared/table-width';

/**
 * 연락 문구 — 연락 시점(진행 단계)마다 고객에게 보낼 문구 하나 (개발설계서 05 G-06).
 *
 * **문구는 시점 하나에만 붙는다**(2026-07-29). 그래서 이 화면에 "문구 목록"도, 시점에 붙일
 * 문구를 고르는 드롭다운도 없다 — 행이 곧 문구이고, 그 자리에서 쓰고 고치고 지운다.
 * 같은 내용을 두 시점에서 쓰려면 시점마다 따로 쓴다(공유하면 한쪽 수정이 다른 시점까지 바꾼다).
 *
 * 문구가 없는 시점에는 확인창이 뜨지 않는다. 자동 발송 설정은 없다 — 발송은 항상 확인창을 거친다.
 * 그때그때 다른 안내는 문구를 등록하지 않고 `고객 연락`에서 본문을 직접 써서 보낸다(설계서 05 §4.1).
 */

interface Props {
  /** [문구 작성]/[수정] — 페이지가 편집 모달을 연다 */
  onEdit: (stage: { id: string; name: string; message: StageMessage | null }) => void;
}

type Row = {
  id: string;
  name: string;
  when: string;
  message: StageMessage | null;
};

export function StageContactCard({ onEdit }: Props) {
  const { message: toast, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [trackType, setTrackType] = useState<TrackType>('CUSTOM');
  const canEdit = useAuthStore((s) => s.user?.permissions.includes('ADMIN_MASTER_EDIT') ?? false);

  // 트랙 전체를 한 번 받아 화면에서 거른다(트랙을 바꿔도 재요청 없음). 문구 본문도 함께 온다.
  const stagesQuery = useQuery({ queryKey: ['journey-stages'], queryFn: () => fetchJourneyStages() });

  const deleteMutation = useMutation({
    mutationFn: (stageId: string) => deleteStageMessage(stageId),
    onSuccess: () => {
      toast.success('문구를 지웠습니다. 이 시점에는 연락하지 않습니다.');
      void queryClient.invalidateQueries({ queryKey: ['journey-stages'] });
      // 발송 화면의 문구 목록에서도 사라진다.
      void queryClient.invalidateQueries({ queryKey: ['notification-templates'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '삭제에 실패했습니다.'),
  });

  const confirmDelete = (row: Row) =>
    modal.confirm({
      title: `'${row.name}' 문구를 지울까요?`,
      content:
        '이 시점에서는 더 이상 연락 확인창이 뜨지 않습니다. 이미 나간 발송 이력은 그대로 남습니다.',
      okText: '삭제',
      okButtonProps: { danger: true },
      cancelText: '취소',
      onOk: () => deleteMutation.mutateAsync(row.id),
    });

  const rows: Row[] = (stagesQuery.data ?? [])
    .filter((s: JourneyStage) => s.trackType === trackType)
    .map((s: JourneyStage) => ({
      id: s.id,
      name: s.name,
      when: `${s.sequenceNo}. ${s.name}`,
      message: s.template ?? null,
    }));

  const columns: ColumnsType<Row> = [
    { title: '연락 시점', dataIndex: 'when', width: COL.wide },
    {
      title: '채널',
      key: 'channel',
      width: COL.status,
      render: (_, r) => {
        if (!r.message) return <Typography.Text type="secondary">-</Typography.Text>;
        const meta = metaOf(NOTIFICATION_CHANNEL_META, r.message.channel);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '승인 상태',
      key: 'status',
      width: COL.status,
      render: (_, r) => {
        if (!r.message) return <Typography.Text type="secondary">-</Typography.Text>;
        const meta = metaOf(TEMPLATE_STATUS_META, r.message.approvalStatus);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '보낼 문구',
      key: 'body',
      width: COL.text,
      render: (_, r) =>
        r.message ? (
          // 미리보기만 한 줄로 자른다. 전문은 행을 펼치면 라인 하단에 뜬다(아래 expandable).
          // 예전엔 잘린 글자에 마우스를 올리면 툴팁이 떠 아래 행들을 통째로 덮었다.
          <Typography.Text style={{ maxWidth: 460 }} ellipsis>
            {r.message.body}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">이 시점에는 연락하지 않습니다.</Typography.Text>
        ),
    },
    {
      title: '변수',
      key: 'variables',
      width: COL.wide,
      render: (_, r) => {
        const vars = r.message ? extractTemplateVariables(r.message.body) : [];
        if (vars.length === 0) return <Typography.Text type="secondary">-</Typography.Text>;
        return (
          <Space size={4} wrap>
            {vars.map((v) => (
              // 파랑 = 서버가 발송할 때 자동으로 채운다. 그 외는 담당자가 발송 화면에서 넣어야 한다.
              <Tag key={v} color={AUTO_VARIABLES.includes(v) ? 'blue' : 'orange'}>
                {v}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '작업',
      key: 'action',
      width: COL.action2,
      render: (_, r) => {
        if (!canEdit) return null;
        return (
          // 행 클릭이 펼침을 겸하므로(expandRowByClick), 버튼 클릭은 행까지 번지지 않게 막는다.
          <Space size={4} onClick={(e) => e.stopPropagation()}>
            <Button size="small" onClick={() => onEdit({ id: r.id, name: r.name, message: r.message })}>
              {r.message ? '수정' : '문구 작성'}
            </Button>
            {r.message ? (
              <Button
                size="small"
                danger
                loading={deleteMutation.isPending && deleteMutation.variables === r.id}
                onClick={() => confirmDelete(r)}
              >
                삭제
              </Button>
            ) : null}
          </Space>
        );
      },
    },
  ];

  return (
    <PageCard
      title="연락 문구"
      extra={
        /*
          트랙 전환은 매번 쓰는 축이다. Segmented는 배경만 옅게 깔려 어느 것이 눌리는 버튼인지
          구분되지 않았다 — 재고 화면(RentalInventoryPage)과 같이 테두리가 있고 선택 시 꽉 찬
          색으로 바뀌는 Radio 버튼 그룹을 쓴다.
        */
        <Radio.Group
          size="small"
          value={trackType}
          optionType="button"
          buttonStyle="solid"
          onChange={(e: RadioChangeEvent) => setTrackType(e.target.value as TrackType)}
        >
          {TRACK_TYPES.map((t) => (
            <Radio.Button key={t} value={t}>
              {trackTypeLabel(t)}
            </Radio.Button>
          ))}
        </Radio.Group>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        담당자가 진행 카드에서 이 시점을 완료하면 여기 쓴 문구로 확인창이 뜹니다. 자동으로 발송되지
        않습니다. <Tag color="blue">파란 변수</Tag>는 발송할 때 고객·주문 정보로 자동으로 채워지고,{' '}
        <Tag color="orange">주황 변수</Tag>는 담당자가 발송 화면에서 직접 넣어야 합니다.
      </Typography.Paragraph>
      <Table<Row>
        rowKey="id"
        scroll={{ x: 'max-content' }}
        size="small"
        pagination={false}
        loading={stagesQuery.isLoading}
        dataSource={rows}
        columns={columns}
        expandable={{
          // 전문은 툴팁으로 띄우지 않고 행 아래로 펼친다 — 아래 행을 덮지 않고 밀어낸다.
          // +아이콘 없이 행을 클릭하면 열린다(expandRowByClick + showExpandColumn:false).
          expandRowByClick: true,
          showExpandColumn: false,
          rowExpandable: (r) => !!r.message,
          expandedRowRender: (r) =>
            r.message ? (
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {r.message.body}
              </Typography.Paragraph>
            ) : null,
        }}
      />
    </PageCard>
  );
}
