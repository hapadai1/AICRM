/** OPT-002 옵션 단계 선택 — 큰 A/B 카드에서 하나를 고르고 이동 시 임시저장 */
import { CheckCircleFilled, LeftOutlined, PauseOutlined, RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Image, Input, Progress, Row, Space, Spin, Typography, message } from 'antd';
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
import { choiceColor } from './option-meta';

/** 선택지 이미지 영역 — 등록 이미지가 있으면 사진, 없으면 색상 블록으로 폴백한다. */
function ChoiceMedia({ choice }: { choice: OptionChoiceView }) {
  const { data: src } = useQuery({
    queryKey: ['file-object-url', choice.imageUrl],
    queryFn: () => fetchFileObjectUrl(choice.imageUrl!),
    enabled: !!choice.imageUrl,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });

  if (choice.imageUrl && src) {
    return (
      <div style={{ height: 240, borderRadius: 8, overflow: 'hidden' }}>
        {/* 카드 전체가 '눌러 선택' 대상이므로 preview는 끄고 클릭이 카드로 전파되게 둔다. */}
        <Image
          src={src}
          alt={choice.name}
          width="100%"
          height={240}
          style={{ objectFit: 'cover' }}
          preview={false}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        height: 240,
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
              {session?.displayName ?? '맞춤 품목'}의 원단을 먼저 입력해 주세요. 이후 단계별로 두 선택지 중
              하나를 고릅니다.
            </Typography.Text>
          </div>
          <Input
            size="large"
            style={{ height: 56, fontSize: 18 }}
            placeholder="원단명 입력 (예: 캐노니코 네이비 트윌)"
            value={fabricInput}
            onChange={(e) => setFabricInput(e.target.value)}
          />
          <Space>
            <Button size="large" style={{ height: 56, minWidth: 120 }} onClick={() => navigate('/options')}>
              목록으로
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

  const isLast = currentOrder >= session.totalStages;
  const dirty = choiceId !== null && choiceId !== stage.selectedChoiceId;

  const saveIfNeeded = async (): Promise<void> => {
    if (choiceId && dirty) {
      await saveMutation.mutateAsync({ stageId: stage.stageId, choiceId, order: currentOrder });
    }
  };

  const handleNext = async () => {
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
    try {
      await saveIfNeeded();
      setCurrentOrder(Math.max(1, currentOrder - 1));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

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

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
            <div>
              {/* 고객명·주문번호·옵션세트명은 세션 상세 응답에 없어 표시하지 않는다 (docs/dev/08 §4) */}
              <Typography.Title level={4} style={{ margin: 0 }}>
                {session.displayName}
              </Typography.Title>
              <Typography.Text type="secondary">
                원단: {session.fabric ?? '미입력'} · 옵션 세트 V{session.optionSetVersionNo}
              </Typography.Text>
            </div>
            <Button size="large" style={{ height: 48 }} icon={<PauseOutlined />} onClick={handlePause}>
              중단
            </Button>
          </Space>
          <Progress
            percent={Math.round((session.completedStages / session.totalStages) * 100)}
            format={() => `${session.completedStages}/${session.totalStages} 저장`}
          />
          <Typography.Title level={3} style={{ margin: 0 }}>
            {currentOrder}단계 / {session.totalStages}단계 — {stage.name}
          </Typography.Title>
          <Typography.Text type="secondary">두 선택지 중 하나를 눌러 선택하세요.</Typography.Text>
        </Space>
      </Card>

      <Row gutter={16}>
        {stage.choices.map((choice) => {
          const selected = choiceId === choice.choiceId;
          return (
            <Col xs={24} sm={12} key={choice.choiceId}>
              <Card
                hoverable
                onClick={() => setChoiceId(choice.choiceId)}
                style={{
                  border: selected ? '4px solid #1677ff' : '1px solid #d9d9d9',
                  borderRadius: 12,
                  marginBottom: 16,
                }}
                styles={{ body: { padding: 16 } }}
              >
                <ChoiceMedia choice={choice} />
                <Space style={{ marginTop: 12, justifyContent: 'space-between', width: '100%' }}>
                  <Typography.Text strong style={{ fontSize: 18 }}>
                    {choice.code}안 · {choice.name}
                  </Typography.Text>
                  {selected && <CheckCircleFilled style={{ color: '#1677ff', fontSize: 28 }} />}
                </Space>
              </Card>
            </Col>
          );
        })}
      </Row>

      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Button
            size="large"
            style={{ height: 56, minWidth: 140, fontSize: 18 }}
            icon={<LeftOutlined />}
            disabled={currentOrder <= 1 || saveMutation.isPending}
            onClick={handlePrev}
          >
            이전
          </Button>
          <Button
            type="primary"
            size="large"
            style={{ height: 56, minWidth: 200, fontSize: 18 }}
            disabled={!choiceId}
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
