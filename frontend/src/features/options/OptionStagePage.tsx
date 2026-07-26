/** OPT-002 옵션 단계 선택 — 큰 A/B 카드에서 하나를 고르고 이동 시 임시저장 */
import { CheckCircleFilled, EditOutlined, LeftOutlined, PauseOutlined, RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Grid, Image, Input, Modal, Progress, Space, Spin, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { fetchFileObjectUrl } from '../../api/client';
import type { OptionChoiceView, OptionSessionDetail, OptionStageView } from '../../api/options';
import {
  fetchOptionSessionByItem,
  pauseOptionSession,
  saveOptionStage,
  startOptionSession,
} from '../../api/options';
import { choiceColor, fabricFieldLabel, fabricFieldPlaceholder, photoFrameStyle } from './option-meta';

/** 선택지 이미지 영역 — 등록 이미지가 있으면 사진, 없으면 색상 블록으로 폴백한다. */
function ChoiceMedia({ choice, maxHeight }: { choice: OptionChoiceView; maxHeight: string }) {
  const { data: src } = useQuery({
    queryKey: ['file-object-url', choice.imageUrl],
    queryFn: () => fetchFileObjectUrl(choice.imageUrl!),
    enabled: !!choice.imageUrl,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });

  if (choice.imageUrl && src) {
    return (
      <div style={photoFrameStyle()}>
        {/* 카드 전체가 '눌러 선택' 대상이므로 preview는 끄고 클릭이 카드로 전파되게 둔다. */}
        {/* 폭을 100%로 늘리지 않고 원본 크기로 둔다 — 늘리면 흐려져서 카라 벌림·커프스 모서리
            같은 미세한 차이가 뭉갠다. 칸이 좁을 때만 줄어들고, 세로로 긴 사진이 화면을
            넘기지 않도록 높이 상한만 둔다. */}
        <Image
          src={src}
          alt={choice.name}
          wrapperStyle={{ display: 'block', textAlign: 'center' }}
          style={{ maxWidth: '100%', maxHeight, height: 'auto', objectFit: 'contain' }}
          preview={false}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        height: 360,
        borderRadius: 8,
        background: choiceColor(choice.choiceId),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Typography.Title
        level={3}
        style={{ color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.4)', margin: 0 }}
      >
        {choice.name}
      </Typography.Title>
    </div>
  );
}

function firstIncompleteOrder(session: OptionSessionDetail): number {
  const incomplete = session.stages.find((st) => !st.selectedChoiceId);
  if (incomplete) return incomplete.order;
  return Math.min(session.lastStageOrder + 1, session.totalStages) || 1;
}

export function OptionStagePage() {
  const { orderItemId } = useParams<{ orderItemId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [currentOrder, setCurrentOrder] = useState<number | null>(null);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [fabricInput, setFabricInput] = useState('');
  const screens = Grid.useBreakpoint();
  const [modal, modalContextHolder] = Modal.useModal();

  const sessionQuery = useQuery({
    queryKey: ['options', 'session', orderItemId],
    queryFn: () => fetchOptionSessionByItem(orderItemId ?? ''),
    enabled: !!orderItemId,
    retry: false,
  });
  // 백엔드는 세션이 없어도 200 + `session: null`로 응답한다 (에러 코드가 아니다).
  const session = sessionQuery.data ?? null;
  const notStarted = sessionQuery.isSuccess && session === null;

  const startMutation = useMutation({
    mutationFn: (fabric: string) => startOptionSession(orderItemId ?? '', fabric),
    onSuccess: (created) => {
      queryClient.setQueryData(['options', 'session', orderItemId], created);
      void queryClient.invalidateQueries({ queryKey: ['options', 'progress'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const saveMutation = useMutation({
    mutationFn: (input: { stageId: string; choiceId: string; order: number }) =>
      saveOptionStage(session?.sessionId ?? '', input.stageId, {
        choiceId: input.choiceId,
        currentStageOrder: input.order,
        version: session?.version ?? 0,
      }),
    // 연속 저장 시 낙관적 잠금 충돌을 막기 위해 응답의 version·선택값을 캐시에 즉시 반영한다.
    onSuccess: (res, input) => {
      queryClient.setQueryData<OptionSessionDetail>(['options', 'session', orderItemId], (prev) =>
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
  // 시작 API가 이 분기를 담당하므로 원단만 그대로 넘기면 된다.
  const reopenMutation = useMutation({
    mutationFn: () => startOptionSession(orderItemId ?? '', session?.fabric ?? undefined),
    onSuccess: (created) => {
      queryClient.setQueryData(['options', 'session', orderItemId], created);
      void queryClient.invalidateQueries({ queryKey: ['options'] });
      void queryClient.invalidateQueries({ queryKey: ['workorders'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const pauseMutation = useMutation({
    mutationFn: (stageId: string) => pauseOptionSession(session?.sessionId ?? '', stageId),
  });

  // 최초 진입 시 시작 단계 결정: ?stage= (확인서 재선택) 또는 미완료 첫 단계
  useEffect(() => {
    if (session && currentOrder === null) {
      const paramStage = Number(searchParams.get('stage'));
      if (paramStage >= 1 && paramStage <= session.totalStages) {
        setCurrentOrder(paramStage);
      } else {
        setCurrentOrder(firstIncompleteOrder(session));
      }
    }
  }, [session, currentOrder, searchParams]);

  const stage: OptionStageView | undefined = session?.stages.find((st) => st.order === currentOrder);

  // 단계 이동 시 기존 선택값 표시
  useEffect(() => {
    setChoiceId(stage?.selectedChoiceId ?? null);
  }, [stage?.stageId, stage?.selectedChoiceId]);

  if (!orderItemId) return <Alert type="error" showIcon message="품목 정보가 없습니다." />;

  if (sessionQuery.isLoading) {
    return <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />;
  }

  // 세션 없음 → 원단 입력 후 선택 시작 (원단은 첫 진입 시 수기 입력)
  if (notStarted || (session && !session.fabric)) {
    return (
      <Card style={{ maxWidth: 640, margin: '0 auto' }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={4}>스타일 컨설팅 시작</Typography.Title>
            <Typography.Text type="secondary">
              {session?.displayName ?? '맞춤 품목'}의 {fabricFieldLabel(session?.productCategory)}을(를) 먼저
              입력해 주세요. 이후 단계별로 두 선택지 중 하나를 고릅니다.
            </Typography.Text>
          </div>
          <Input
            size="large"
            style={{ height: 56, fontSize: 18 }}
            placeholder={fabricFieldPlaceholder(session?.productCategory)}
            value={fabricInput}
            onChange={(e) => setFabricInput(e.target.value)}
          />
          <Space>
            {/* 이 화면에는 목록 말고 계약·품목 상세에서도 들어온다. 온 곳으로 되돌린다. */}
            <Button size="large" style={{ height: 56, minWidth: 120 }} onClick={() => navigate(-1)}>
              이전화면
            </Button>
            <Button
              type="primary"
              size="large"
              style={{ height: 56, minWidth: 200 }}
              disabled={!fabricInput.trim()}
              loading={startMutation.isPending}
              onClick={() => startMutation.mutate(fabricInput.trim())}
            >
              선택 시작
            </Button>
          </Space>
        </Space>
      </Card>
    );
  }

  if (sessionQuery.error) {
    return (
      <Alert
        type="error"
        showIcon
        message="옵션 세션을 불러오지 못했습니다."
        description={(sessionQuery.error as Error).message}
      />
    );
  }

  if (!session || !stage || currentOrder === null) {
    return <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />;
  }

  // 한 줄에 최대 3개까지만 놓는다. 선택지가 5개인 단계는 3+2 두 줄이 되는데,
  // 5개를 한 줄에 밀어 넣으면 사진이 원본보다 작아져 선택지 간 차이가 안 보인다.
  const perRow = Math.min(stage.choices.length, screens.md ? 3 : screens.sm ? 2 : 1);
  const cardPadding = 16;
  // 구두 스타일처럼 한 단계에 선택지가 여럿이면 사진을 줄여 두세 줄이 한 화면에 들어오게 한다.
  // 카라·커프스처럼 몇 개뿐인 단계는 미세한 차이를 봐야 하므로 크게 그대로 둔다.
  const manyChoices = stage.choices.length > 6;
  const photoMaxHeight = manyChoices ? '30vh' : '62vh';

  // 단계가 하나뿐인 품목(구두)은 "1단계 / 1단계" 표기가 군더더기다 — 단계명만 보인다.
  const singleStage = session.totalStages <= 1;
  const isLast = currentOrder >= session.totalStages;
  // 확정 세션은 열람 전용 — 저장·중단이 서버에서 거부되므로 편집 UI를 막고 이동만 허용한다.
  const isConfirmed = session.status === 'CONFIRMED';
  const dirty = choiceId !== null && choiceId !== stage.selectedChoiceId;

  const saveIfNeeded = async (): Promise<void> => {
    if (choiceId && dirty) {
      await saveMutation.mutateAsync({ stageId: stage.stageId, choiceId, order: currentOrder });
    }
  };

  const handleNext = async () => {
    // 확정 세션: 저장 없이 이동만 (마지막 단계에서는 확인서로 복귀)
    if (isConfirmed) {
      if (isLast) navigate(`/options/${orderItemId}/review`);
      else setCurrentOrder(currentOrder + 1);
      return;
    }
    if (!choiceId) return;
    try {
      // 이동 시 임시저장 (§7.3: 각 이동 시 임시저장)
      await saveMutation.mutateAsync({ stageId: stage.stageId, choiceId, order: currentOrder });
      if (isLast) {
        navigate(`/options/${orderItemId}/review`);
      } else {
        setCurrentOrder(currentOrder + 1);
      }
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handlePrev = async () => {
    if (isConfirmed) {
      setCurrentOrder(Math.max(1, currentOrder - 1));
      return;
    }
    try {
      await saveIfNeeded();
      setCurrentOrder(Math.max(1, currentOrder - 1));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // 확정 세션에는 중단(임시저장)이 없다 — 헤더 버튼은 확인서 복귀로 동작한다.
  const handlePause = async () => {
    try {
      await saveIfNeeded();
      await pauseMutation.mutateAsync(stage.stageId);
      message.info('임시저장 후 중단했습니다. 재개 시 이어서 선택할 수 있습니다.');
      navigate('/options');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 확정 세션에서 선택지를 누른 경우 — 확인 후 새 선택 버전을 열고 누른 선택지를 반영한다. */
  const handleConfirmedPick = (pickedChoiceId: string | null) => {
    modal.confirm({
      title: '확정된 옵션 변경',
      content:
        '확정본은 그대로 두고 새 선택 버전에서 이어서 수정합니다. 변경 후에는 다시 확정해야 하며, 작업지시서 재출력 대상이 됩니다. 변경하시겠습니까?',
      okText: '변경 시작',
      cancelText: '취소',
      okButtonProps: { size: 'large' },
      cancelButtonProps: { size: 'large' },
      onOk: async () => {
        await reopenMutation.mutateAsync();
        setChoiceId(pickedChoiceId);
      },
    });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {modalContextHolder}
      <Card>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
            <div>
              {/* 고객명·주문번호·옵션세트명은 세션 상세 응답에 없어 표시하지 않는다 (docs/dev/08 §4) */}
              <Typography.Title level={4} style={{ margin: 0 }}>
                {session.displayName}
              </Typography.Title>
              <Typography.Text type="secondary">
                {fabricFieldLabel(session.productCategory)}: {session.fabric ?? '미입력'} · 옵션 세트 V
                {session.optionSetVersionNo}
              </Typography.Text>
            </div>
            {isConfirmed ? (
              <Space>
                <Button
                  size="large"
                  style={{ height: 48 }}
                  icon={<LeftOutlined />}
                  onClick={() => navigate(`/options/${orderItemId}/review`)}
                >
                  확인서로
                </Button>
                <Button
                  type="primary"
                  size="large"
                  style={{ height: 48 }}
                  icon={<EditOutlined />}
                  loading={reopenMutation.isPending}
                  onClick={() => handleConfirmedPick(stage.selectedChoiceId)}
                >
                  옵션 변경
                </Button>
              </Space>
            ) : (
              <Button size="large" style={{ height: 48 }} icon={<PauseOutlined />} onClick={handlePause}>
                중단
              </Button>
            )}
          </Space>
          {!singleStage && (
            <Progress
              percent={Math.round((session.completedStages / session.totalStages) * 100)}
              format={() => `${session.completedStages}/${session.totalStages} 저장`}
            />
          )}
          <Typography.Title level={3} style={{ margin: 0 }}>
            {singleStage ? stage.name : `${currentOrder}단계 / ${session.totalStages}단계 — ${stage.name}`}
          </Typography.Title>
          <Typography.Text type="secondary">
            {isConfirmed
              ? `확정된 옵션입니다. 선택지를 누르면 새 선택 버전으로 변경을 시작합니다. (${stage.choices.length}개 선택지)`
              : `${stage.choices.length}개 선택지 중 하나를 눌러 선택하세요.`}
          </Typography.Text>
        </Space>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))`, gap: 16 }}>
        {stage.choices.map((choice) => {
          const selected = choiceId === choice.choiceId;
          return (
            <div key={choice.choiceId}>
              <Card
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
                styles={{ body: { padding: cardPadding } }}
              >
                <ChoiceMedia choice={choice} maxHeight={photoMaxHeight} />
                <Space style={{ marginTop: 12, justifyContent: 'space-between', width: '100%' }}>
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong style={{ fontSize: 18 }}>
                      {choice.code}안 · {choice.name}
                    </Typography.Text>
                    {choice.extraPrice > 0 && (
                      <Typography.Text strong style={{ color: '#cf1322', fontSize: 16 }}>
                        (+{choice.extraPrice.toLocaleString()}원)
                      </Typography.Text>
                    )}
                  </Space>
                  {selected && <CheckCircleFilled style={{ color: '#1677ff', fontSize: 28 }} />}
                </Space>
              </Card>
            </div>
          );
        })}
      </div>

      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Button
            size="large"
            style={{ height: 56, minWidth: 180, fontSize: 18 }}
            icon={<LeftOutlined />}
            disabled={currentOrder <= 1 || saveMutation.isPending}
            onClick={handlePrev}
          >
            이전
          </Button>
          <Button
            type="primary"
            size="large"
            style={{ height: 56, minWidth: 180, fontSize: 18 }}
            disabled={!isConfirmed && !choiceId}
            loading={saveMutation.isPending}
            onClick={handleNext}
          >
            {isLast ? '확인서로 이동' : '다음'} <RightOutlined />
          </Button>
        </Space>
      </Card>
    </Space>
  );
}
