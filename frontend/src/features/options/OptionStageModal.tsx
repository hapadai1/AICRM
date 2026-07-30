/**
 * 부위별 옵션 선택 팝업 — 스타일 컨설팅 목록의 부위 행에서 바로 띄운다.
 * 세션의 전체 단계 중 그 부위(componentGroup)에 속한 단계만 순서대로 보여준다.
 * 단계 이동·완료 시 임시저장하며(설계서 §7.3), 확정 세션은 열람 전용이다.
 */
import { CheckCircleFilled, EditOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Grid, Modal, Progress, Space, Spin, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import type { OptionSessionDetail, OptionStageView } from '../../api/options';
import { fetchOptionSessionByItem, saveOptionStage, startOptionSession } from '../../api/options';
import { ChoiceMedia } from './ChoiceMedia';

interface Props {
  open: boolean;
  contractItemId: string;
  /** 부위 코드. null이면 세션의 모든 단계를 보여준다. */
  componentGroup: string | null;
  /** 팝업 제목에 쓰는 라벨 — "맞춤 정장 #1 · 상의(자켓)" */
  title: string;
  onClose: () => void;
}

export function OptionStageModal({ open, contractItemId, componentGroup, title, onClose }: Props) {
  const queryClient = useQueryClient();
  const screens = Grid.useBreakpoint();
  const [index, setIndex] = useState(0);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [modal, modalContextHolder] = Modal.useModal();

  const sessionQuery = useQuery({
    queryKey: ['options', 'session', contractItemId],
    queryFn: () => fetchOptionSessionByItem(contractItemId),
    enabled: open && !!contractItemId,
    retry: false,
  });
  const session = sessionQuery.data ?? null;

  // 목록에서 바로 띄우므로 원단 입력 화면을 거치지 않는다 — 세션이 없으면 조용히 만든다.
  // 원단·컬러·패턴은 목록의 부위 행에서 따로 입력한다.
  const startMutation = useMutation({
    mutationFn: () => startOptionSession(contractItemId),
    onSuccess: (created) => {
      queryClient.setQueryData(['options', 'session', contractItemId], created);
      void queryClient.invalidateQueries({ queryKey: ['options', 'progress'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  useEffect(() => {
    if (open && sessionQuery.isSuccess && session === null && !startMutation.isPending)
      startMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionQuery.isSuccess, session]);

  const stages: OptionStageView[] = (session?.stages ?? []).filter(
    (s) => !componentGroup || s.componentGroup === componentGroup,
  );

  // 열 때마다 그 부위의 미완료 첫 단계에서 시작한다.
  useEffect(() => {
    if (!open) return;
    const firstIncomplete = stages.findIndex((s) => !s.selectedChoiceId);
    setIndex(firstIncomplete >= 0 ? firstIncomplete : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, componentGroup, session?.sessionId]);

  const stage: OptionStageView | undefined = stages[index];

  useEffect(() => {
    setChoiceId(stage?.selectedChoiceId ?? null);
  }, [stage?.stageId, stage?.selectedChoiceId]);

  const saveMutation = useMutation({
    mutationFn: (input: { stageId: string; choiceId: string; order: number }) =>
      saveOptionStage(session?.sessionId ?? '', input.stageId, {
        choiceId: input.choiceId,
        currentStageOrder: input.order,
        version: session?.version ?? 0,
      }),
    // 연속 저장 시 낙관적 잠금 충돌을 막기 위해 응답의 version·선택값을 캐시에 즉시 반영한다.
    onSuccess: (res, input) => {
      queryClient.setQueryData<OptionSessionDetail>(['options', 'session', contractItemId], (prev) =>
        prev
          ? {
              ...prev,
              version: res.version,
              status: res.status,
              completedStages: res.completedStages,
              stages: prev.stages.map((st) =>
                st.stageId === input.stageId ? { ...st, selectedChoiceId: input.choiceId } : st,
              ),
            }
          : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['options', 'progress'] });
    },
  });

  // 확정 세션 재선택(설계서 §8.5): 확정본은 그대로 두고 선택값을 복사한 새 선택 버전을 만든다.
  const reopenMutation = useMutation({
    mutationFn: () => startOptionSession(contractItemId, session?.fabric ?? undefined),
    onSuccess: (created) => {
      queryClient.setQueryData(['options', 'session', contractItemId], created);
      void queryClient.invalidateQueries({ queryKey: ['options'] });
      void queryClient.invalidateQueries({ queryKey: ['workorders'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const isConfirmed = session?.status === 'CONFIRMED';
  const dirty = !!choiceId && choiceId !== stage?.selectedChoiceId;
  const done = stages.filter((s) => s.selectedChoiceId).length;

  const saveIfNeeded = async () => {
    if (stage && choiceId && dirty && !isConfirmed)
      await saveMutation.mutateAsync({ stageId: stage.stageId, choiceId, order: stage.order });
  };

  const handleMove = async (delta: number) => {
    try {
      await saveIfNeeded();
      setIndex((i) => Math.min(Math.max(i + delta, 0), stages.length - 1));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleFinish = async () => {
    try {
      await saveIfNeeded();
      void queryClient.invalidateQueries({ queryKey: ['options'] });
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleConfirmedPick = (picked: string | null) => {
    modal.confirm({
      title: '확정된 옵션 변경',
      content:
        '확정본은 그대로 두고 새 선택 버전에서 이어서 수정합니다. 변경 후에는 다시 확정해야 하며, 작업지시서 재출력 대상이 됩니다. 변경하시겠습니까?',
      okText: '변경 시작',
      cancelText: '취소',
      onOk: async () => {
        await reopenMutation.mutateAsync();
        setChoiceId(picked);
      },
    });
  };

  const loading = sessionQuery.isLoading || startMutation.isPending;
  // 좁은 팝업이라 한 줄 최대 3개, 사진 높이도 페이지보다 낮춘다.
  const perRow = Math.min(stage?.choices.length ?? 1, screens.lg ? 3 : screens.sm ? 2 : 1);
  const photoMaxHeight = (stage?.choices.length ?? 0) > 6 ? '24vh' : '46vh';
  const isLast = index >= stages.length - 1;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title}
      width={980}
      destroyOnHidden
      footer={null}
      styles={{ body: { paddingTop: 8 } }}
    >
      {modalContextHolder}
      {loading ? (
        <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />
      ) : sessionQuery.error ? (
        <Alert
          type="error"
          showIcon
          message="옵션 세션을 불러오지 못했습니다."
          description={(sessionQuery.error as Error).message}
        />
      ) : stages.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message="이 부위에 등록된 옵션 단계가 없습니다."
          description="관리자 > 옵션세트 관리에서 이 부위의 단계를 추가하면 여기서 선택할 수 있습니다."
        />
      ) : !stage ? (
        <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Progress
              percent={Math.round((done / stages.length) * 100)}
              format={() => `${done}/${stages.length} 저장`}
            />
            <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                {stages.length > 1
                  ? `${index + 1}단계 / ${stages.length}단계 — ${stage.name}`
                  : stage.name}
              </Typography.Title>
              {isConfirmed && (
                <Button
                  type="primary"
                  icon={<EditOutlined />}
                  loading={reopenMutation.isPending}
                  onClick={() => handleConfirmedPick(stage.selectedChoiceId)}
                >
                  옵션 변경
                </Button>
              )}
            </Space>
            <Typography.Text type="secondary">
              {isConfirmed
                ? `확정된 옵션입니다. 선택지를 누르면 새 선택 버전으로 변경을 시작합니다. (${stage.choices.length}개 선택지)`
                : `${stage.choices.length}개 선택지 중 하나를 눌러 선택하세요.`}
            </Typography.Text>
          </Space>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))`,
              gap: 12,
            }}
          >
            {stage.choices.map((choice) => {
              const selected = choiceId === choice.choiceId;
              return (
                <Card
                  key={choice.choiceId}
                  hoverable
                  onClick={
                    isConfirmed
                      ? () => handleConfirmedPick(choice.choiceId)
                      : () => setChoiceId(choice.choiceId)
                  }
                  style={{
                    border: selected ? '4px solid #1677ff' : '1px solid #d9d9d9',
                    borderRadius: 12,
                    height: '100%',
                    cursor: 'pointer',
                  }}
                  styles={{ body: { padding: 12 } }}
                >
                  <ChoiceMedia choice={choice} maxHeight={photoMaxHeight} fallbackHeight={200} />
                  <Space style={{ marginTop: 10, justifyContent: 'space-between', width: '100%' }}>
                    <Space direction="vertical" size={2}>
                      <Typography.Text strong style={{ fontSize: 16 }}>
                        {choice.code}안 · {choice.name}
                      </Typography.Text>
                      {choice.extraPrice > 0 && (
                        <Typography.Text strong style={{ color: '#cf1322' }}>
                          (+{choice.extraPrice.toLocaleString()}원)
                        </Typography.Text>
                      )}
                    </Space>
                    {selected && <CheckCircleFilled style={{ color: '#1677ff', fontSize: 24 }} />}
                  </Space>
                </Card>
              );
            })}
          </div>

          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button
              size="large"
              style={{ height: 48, minWidth: 140 }}
              icon={<LeftOutlined />}
              disabled={index <= 0 || saveMutation.isPending}
              onClick={() => void handleMove(-1)}
            >
              이전
            </Button>
            <Button
              type="primary"
              size="large"
              style={{ height: 48, minWidth: 140 }}
              disabled={!isConfirmed && !choiceId}
              loading={saveMutation.isPending}
              onClick={() => (isLast ? void handleFinish() : void handleMove(1))}
            >
              {isLast ? '완료' : '다음'} {!isLast && <RightOutlined />}
            </Button>
          </Space>
        </Space>
      )}
    </Modal>
  );
}
