import { CheckOutlined, PlusOutlined, RollbackOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  cancelJourney,
  changeJourneyStage,
  completeJourney,
  createJourney,
  fetchCustomerJourneys,
  fetchJourney,
  journeyStatusMeta,
  setNotificationOutcome,
  trackTypeLabel,
  TRACK_TYPES,
  type Journey,
  type SuggestedNotification,
  type TrackType,
} from '../../api/journeys';
import { Can } from '../../shared/Can';
import {
  NotificationConfirmModal,
  type SendOutcome,
} from '../../shared/NotificationConfirmModal';

/**
 * 고객 상세 최상단 진행 단계 카드 (개발설계서 05 G-11).
 *
 * 단계 전진은 전적으로 수동이며, 연락 대상 단계로 옮기면 발송 확인창이 뜬다.
 * 제작 상태(order_items.status)와 자동 연동하지 않는다.
 */

interface Props {
  customerId: string;
  customerName: string;
}

export function JourneyCard({ customerId, customerName }: Props) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [startForm] = Form.useForm<{ trackType: TrackType }>();
  const [suggestion, setSuggestion] = useState<SuggestedNotification | null>(null);
  const [suggestionTitle, setSuggestionTitle] = useState('');

  const journeysQuery = useQuery({
    queryKey: ['customer-journeys', customerId],
    queryFn: () => fetchCustomerJourneys(customerId),
  });

  const journeys = journeysQuery.data ?? [];
  // 선택이 없으면 진행 중인 것 우선, 없으면 가장 최근 건을 본다.
  const activeId =
    selectedId && journeys.some((j) => j.id === selectedId)
      ? selectedId
      : (journeys.find((j) => j.status === 'ACTIVE')?.id ?? journeys[0]?.id ?? null);

  const detailQuery = useQuery({
    queryKey: ['journey', activeId],
    queryFn: () => fetchJourney(activeId as string),
    enabled: activeId != null,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['customer-journeys', customerId] });
    void queryClient.invalidateQueries({ queryKey: ['journey', activeId] });
  };

  const startMutation = useMutation({
    mutationFn: (trackType: TrackType) => createJourney(customerId, { trackType }),
    onSuccess: (created) => {
      message.success('진행을 시작했습니다.');
      setSelectedId(created.id);
      setStartOpen(false);
      startForm.resetFields();
      invalidate();
    },
    onError: (error) =>
      message.error(error instanceof ApiError ? error.message : '진행 시작에 실패했습니다.'),
  });

  const stageMutation = useMutation({
    mutationFn: (vars: { toStageCode: string; version: number; reason?: string }) =>
      changeJourneyStage(activeId as string, vars),
    onSuccess: (result) => {
      invalidate();
      if (result.suggestedNotification) {
        setSuggestionTitle(`${result.journey.currentStageName}(으)로 변경했습니다`);
        setSuggestion(result.suggestedNotification);
      } else {
        message.success(`${result.journey.currentStageName}(으)로 변경했습니다.`);
      }
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        message.warning('다른 사용자가 먼저 변경했습니다. 최신 내용을 불러옵니다.');
        invalidate();
        return;
      }
      message.error(error instanceof ApiError ? error.message : '단계 변경에 실패했습니다.');
    },
  });

  const closeMutation = useMutation({
    mutationFn: (vars: { kind: 'COMPLETE' | 'CANCEL'; version: number; reason?: string }) =>
      vars.kind === 'COMPLETE'
        ? completeJourney(activeId as string, vars.version, vars.reason)
        : cancelJourney(activeId as string, vars.version, vars.reason),
    onSuccess: () => {
      message.success('진행을 종료했습니다.');
      invalidate();
    },
    onError: (error) =>
      message.error(error instanceof ApiError ? error.message : '종료에 실패했습니다.'),
  });

  /** 발송 확인창 처리 결과를 이력에 봉합한다. */
  const handleOutcome = async (outcome: SendOutcome, historyId?: string) => {
    const eventId = (suggestion as SuggestedNotification & { eventId: string } | null)?.eventId;
    setSuggestion(null);
    if (!eventId || !activeId) return;
    await setNotificationOutcome(activeId, eventId, {
      outcome,
      notificationHistoryId: historyId,
    });
    invalidate();
  };

  const detail = detailQuery.data;

  const handleAdvance = () => {
    if (!detail) return;
    const currentSeq = detail.currentStageSequenceNo ?? 0;
    const next = detail.stages.find((s) => s.sequenceNo === currentSeq + 1);
    if (!next) {
      message.info('마지막 단계입니다. 완료 처리해 주세요.');
      return;
    }
    modal.confirm({
      title: `${next.name}(으)로 넘어갈까요?`,
      content: next.hasTemplate
        ? '변경 후 고객 연락 문구를 확인하는 창이 열립니다.'
        : undefined,
      okText: '변경',
      cancelText: '취소',
      onOk: () => stageMutation.mutateAsync({ toStageCode: next.code, version: detail.version }),
    });
  };

  const handleJump = (toStageCode: string) => {
    if (!detail || toStageCode === detail.currentStageCode) return;
    const target = detail.stages.find((s) => s.code === toStageCode);
    if (!target) return;
    const backward = target.sequenceNo < (detail.currentStageSequenceNo ?? 0);

    if (!backward) {
      modal.confirm({
        title: `${target.name}(으)로 건너뛸까요?`,
        content: '중간 단계는 기록되지 않습니다.',
        okText: '변경',
        cancelText: '취소',
        onOk: () =>
          stageMutation.mutateAsync({ toStageCode, version: detail.version }),
      });
      return;
    }

    // 되돌리기는 사유가 필수다(백엔드 규칙).
    let reason = '';
    modal.confirm({
      title: `${target.name}(으)로 되돌릴까요?`,
      content: (
        <Input.TextArea
          rows={3}
          placeholder="되돌리는 사유를 적어주세요 (필수)"
          onChange={(e) => {
            reason = e.target.value;
          }}
        />
      ),
      okText: '되돌리기',
      cancelText: '취소',
      onOk: async () => {
        if (!reason.trim()) {
          message.warning('사유를 입력해 주세요.');
          return Promise.reject(new Error('reason required'));
        }
        return stageMutation.mutateAsync({
          toStageCode,
          version: detail.version,
          reason: reason.trim(),
        });
      },
    });
  };

  const handleComplete = () => {
    if (!detail) return;
    modal.confirm({
      title: '이 진행을 완료 처리할까요?',
      content: '완료 후에는 단계를 바꿀 수 없습니다.',
      okText: '완료',
      cancelText: '취소',
      onOk: () => closeMutation.mutateAsync({ kind: 'COMPLETE', version: detail.version }),
    });
  };

  const journeyLabel = (j: Journey) =>
    `${trackTypeLabel(j.trackType)}${j.orderNo ? ` · ${j.orderNo}` : ''}`;

  return (
    <Card
      title="진행 단계"
      extra={
        <Space>
          {journeys.length > 1 && (
            <Segmented
              size="small"
              value={activeId ?? undefined}
              onChange={(v) => setSelectedId(v as string)}
              options={journeys.map((j) => ({ label: journeyLabel(j), value: j.id }))}
            />
          )}
          <Can permission="JOURNEY_EDIT">
            <Button size="small" icon={<PlusOutlined />} onClick={() => setStartOpen(true)}>
              진행 시작
            </Button>
          </Can>
        </Space>
      }
    >
      {journeysQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : !detail ? (
        <Empty
          description={`${customerName}님의 진행이 없습니다`}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Can permission="JOURNEY_EDIT">
            <Button type="primary" onClick={() => setStartOpen(true)}>
              진행 시작
            </Button>
          </Can>
        </Empty>
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Tag color="blue">{trackTypeLabel(detail.trackType)}</Tag>
            <Tag color={journeyStatusMeta(detail.status).color}>
              {journeyStatusMeta(detail.status).label}
            </Tag>
            {detail.orderNo && (
              <Typography.Text type="secondary">{detail.orderNo}</Typography.Text>
            )}
            <Typography.Text type="secondary">
              {detail.currentStageSequenceNo}/{detail.totalStages} 단계
            </Typography.Text>
          </Space>

          <Steps
            size="small"
            direction="vertical"
            current={(detail.currentStageSequenceNo ?? 1) - 1}
            status={detail.status === 'CANCELLED' ? 'error' : 'process'}
            items={detail.stages.map((s) => ({
              title: s.name,
              description: s.hasTemplate ? '고객 연락 단계' : undefined,
              onClick:
                detail.status === 'ACTIVE' ? () => handleJump(s.code) : undefined,
              style: detail.status === 'ACTIVE' ? { cursor: 'pointer' } : undefined,
            }))}
          />

          {detail.status === 'ACTIVE' && (
            <Can permission="JOURNEY_EDIT">
              <Space wrap>
                <Button
                  type="primary"
                  loading={stageMutation.isPending}
                  onClick={handleAdvance}
                >
                  다음 단계로
                </Button>
                <Button
                  icon={<CheckOutlined />}
                  loading={closeMutation.isPending}
                  onClick={handleComplete}
                >
                  완료 처리
                </Button>
              </Space>
            </Can>
          )}

          {detail.events.length > 0 && (
            <div>
              <Typography.Text strong>변경 이력</Typography.Text>
              <div style={{ marginTop: 8 }}>
                {detail.events.slice(0, 5).map((e) => (
                  <div key={e.id} style={{ fontSize: 12, marginBottom: 4 }}>
                    <Typography.Text type="secondary">
                      {e.changedAt.slice(0, 16).replace('T', ' ')}
                    </Typography.Text>{' '}
                    {e.fromStageCode && (
                      <>
                        <RollbackOutlined
                          style={{
                            visibility: e.reason ? 'visible' : 'hidden',
                            marginRight: 4,
                          }}
                        />
                      </>
                    )}
                    <Typography.Text>{e.toStageCode}</Typography.Text>
                    {e.actor && (
                      <Typography.Text type="secondary"> · {e.actor.displayName}</Typography.Text>
                    )}
                    {e.reason && (
                      <Typography.Text type="warning"> · {e.reason}</Typography.Text>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Space>
      )}

      <Modal
        open={startOpen}
        title="진행 시작"
        okText="시작"
        cancelText="취소"
        confirmLoading={startMutation.isPending}
        onCancel={() => setStartOpen(false)}
        onOk={() => {
          void startForm.validateFields().then((v) => startMutation.mutate(v.trackType));
        }}
      >
        <Form form={startForm} layout="vertical" initialValues={{ trackType: 'CUSTOM' }}>
          <Form.Item
            name="trackType"
            label="거래 유형"
            rules={[{ required: true, message: '거래 유형을 선택해 주세요' }]}
          >
            <Select
              options={TRACK_TYPES.map((t) => ({ label: trackTypeLabel(t), value: t }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <NotificationConfirmModal
        open={suggestion != null}
        title={suggestionTitle}
        suggestion={suggestion}
        onDone={handleOutcome}
        onCancel={() => void handleOutcome('DEFERRED')}
      />
    </Card>
  );
}
