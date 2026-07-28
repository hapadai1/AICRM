/** OPT-003 옵션 확인서 — 전체 단계 카드 검토 후 최종 저장(확정) */
import {
  CalculatorOutlined,
  CheckCircleFilled,
  CheckOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Flex, Image, Modal, Row, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import type { CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchFileObjectUrl } from '../../api/client';
import type { OptionComponentAttr, OptionReviewStage, OptionSurcharge } from '../../api/options';
import {
  applyOptionSurcharge,
  componentGroupLabel,
  componentGroupsFor,
  confirmOptionSession,
  fetchOptionReview,
  fetchOptionSessionByItem,
  startOptionSession,
} from '../../api/options';
import { BackButton } from '../../shared/BackButton';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { choiceColor, fabricFieldLabel, OPTION_STATUS_META, photoFrameStyle } from './option-meta';

/** 선택지 사진이 세로로 긴 원본이라 확인서 카드도 세로로 넉넉히 잡는다. */
const MEDIA_HEIGHT = 260;

/** 확인서 카드 이미지 영역 — 선택지에 등록 이미지가 있으면 사진, 없으면 색상 블록으로 폴백한다. */
function StageMedia({ st }: { st: OptionReviewStage }) {
  const { data: src } = useQuery({
    queryKey: ['file-object-url', st.imageUrl],
    queryFn: () => fetchFileObjectUrl(st.imageUrl!),
    enabled: !!st.imageUrl,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });

  if (st.imageUrl && src) {
    return (
      <div style={{ ...photoFrameStyle(), height: MEDIA_HEIGHT }}>
        {/* 카드 전체가 '눌러 재선택' 대상이므로 preview는 끄고 클릭이 카드로 전파되게 둔다. */}
        <Image
          src={src}
          alt={st.choiceName ?? st.name}
          width="100%"
          height={MEDIA_HEIGHT - 2}
          style={{ objectFit: 'contain', display: 'block' }}
          preview={false}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        height: MEDIA_HEIGHT,
        borderRadius: 8,
        background: st.choiceId ? choiceColor(st.choiceId) : '#f5f5f5',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {st.choiceName ? (
        <Typography.Text strong style={{ color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.4)', fontSize: 16 }}>
          {st.choiceName}
        </Typography.Text>
      ) : (
        <Tag color="red">미선택</Tag>
      )}
    </div>
  );
}

const won = (v: number) => `${v.toLocaleString()}원`;

/**
 * 부위 요약 표의 칸 폭 — 값 길이와 무관하게 열이 고정돼야 세 줄이 나란히 읽힌다.
 * 비고만 길어질 수 있어 조금 넓게 잡고, 넘치면 줄바꿈 대신 말줄임 + 툴팁으로 처리한다.
 */
const ATTR_GRID = '104px 1fr 1fr 1fr 1.6fr';
/** 열이 뭉개지지 않는 최소 폭 — 좁은 화면에서는 카드 안에서 가로 스크롤한다. */
const ATTR_MIN_WIDTH = 620;

/** 표 한 칸 — 한 줄 고정, 넘치면 말줄임(전체 값은 title로 확인). */
function AttrCell({ value }: { value: string | null }) {
  return (
    <div
      title={value ?? undefined}
      style={{
        fontSize: 14,
        color: value ? 'rgba(0,0,0,0.88)' : '#bfbfbf',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {value || '-'}
    </div>
  );
}

/**
 * 부위(상의/하의/베스트)별 원단·컬러·패턴·비고 (설계서 04 §2).
 * 부위 하나가 한 줄 — 라벨은 헤더로 한 번만 올리고 값은 고정 폭 열에 맞춰 세운다.
 */
function ComponentAttrsSummary({ components }: { components: OptionComponentAttr[] }) {
  if (components.length === 0) return null;
  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: ATTR_GRID,
    columnGap: 16,
    alignItems: 'center',
    minWidth: ATTR_MIN_WIDTH,
  };
  return (
    <Card size="small" title="부위별 원단·컬러·패턴" styles={{ body: { padding: '0 16px 8px' } }}>
      <div style={{ overflowX: 'auto' }}>
        {/* 헤더 — 라벨을 값 옆에 반복하지 않고 열 제목으로 한 번만 둔다. */}
        <div style={{ ...rowStyle, height: 32, borderBottom: '1px solid #f0f0f0' }}>
          {['부위', '원단', '컬러', '패턴', '비고'].map((label) => (
            <Typography.Text key={label} type="secondary" style={{ fontSize: 12 }}>
              {label}
            </Typography.Text>
          ))}
        </div>
        {components.map((c, i) => (
          <div
            key={c.componentGroup}
            style={{ ...rowStyle, height: 44, borderTop: i > 0 ? '1px solid #fafafa' : undefined }}
          >
            <Tag color="blue" style={{ margin: 0, width: 92, textAlign: 'center' }}>
              {componentGroupLabel(c.componentGroup)}
            </Tag>
            <AttrCell value={c.fabricName} />
            <AttrCell value={c.colorName} />
            <AttrCell value={c.patternName} />
            <AttrCell value={c.notes} />
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * 옵션 추가금액과 계약금액 차액 안내 — 금액 설명만 한다.
 * 실행 버튼([계약금액 반영])은 화면 규칙대로 헤더 우상단 액션바에 있다.
 * 금액은 자동으로 바뀌지 않는다 — 그 버튼을 눌러야 반영된다.
 */
function SurchargePanel({ surcharge }: { surcharge: OptionSurcharge }) {
  const { total, applied, pending, contract } = surcharge;
  if (total === 0 && applied === 0) return null;

  return (
    <Card size="small" title="옵션 추가금액">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size="large" wrap>
          <Typography.Text>
            선택 옵션 추가금액 합계{' '}
            <Typography.Text strong style={{ fontSize: 18 }}>
              {won(total)}
            </Typography.Text>
          </Typography.Text>
          {applied > 0 && (
            <Typography.Text type="secondary">계약금액 반영분 {won(applied)}</Typography.Text>
          )}
        </Space>

        {contract && pending !== 0 && (
          <Alert
            type="warning"
            showIcon
            message={
              <span>
                현재 계약금액 {won(contract.totalAmount)} 대비{' '}
                <Typography.Text strong style={{ color: '#cf1322' }}>
                  {pending > 0 ? '+' : ''}
                  {won(pending)}
                </Typography.Text>{' '}
                차이가 납니다.
              </span>
            }
            description={
              <Typography.Text type="secondary">
                반영하면 계약금액 {won(contract.afterTotalAmount)} · 잔금{' '}
                {won(contract.afterBalanceAmount)}이 됩니다. 계약 버전은 올라가지 않습니다.
                {surcharge.appliable
                  ? ' 위 [계약금액 반영]을 누르면 반영됩니다.'
                  : ' 옵션을 확정하면 위에서 반영할 수 있습니다.'}
              </Typography.Text>
            }
          />
        )}

        {contract && pending === 0 && total > 0 && (
          <Alert
            type="success"
            showIcon
            message={`추가금액 ${won(total)}이 계약금액에 반영되어 있습니다. (현재 계약금액 ${won(contract.totalAmount)})`}
          />
        )}
      </Space>
    </Card>
  );
}

export function OptionReviewPage() {
  const { orderItemId } = useParams<{ orderItemId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [modal, modalContextHolder] = Modal.useModal();

  const sessionQuery = useQuery({
    queryKey: ['options', 'session', orderItemId],
    queryFn: () => fetchOptionSessionByItem(orderItemId ?? ''),
    enabled: !!orderItemId,
    retry: false,
  });
  // 확인서 응답에는 품목명·옵션 버전이 없어 세션 상세에서 가져온다.
  const session = sessionQuery.data ?? null;
  const sessionId = session?.sessionId;

  const reviewQuery = useQuery({
    queryKey: ['options', 'review', sessionId],
    queryFn: () => fetchOptionReview(sessionId ?? ''),
    enabled: !!sessionId,
  });
  const review = reviewQuery.data;

  const confirmMutation = useMutation({
    mutationFn: () => confirmOptionSession(sessionId ?? '', review?.version ?? 0),
    onSuccess: (result) => {
      message.success('옵션이 확정되었습니다. 작업지시서 출력이 가능합니다.');
      void queryClient.invalidateQueries({ queryKey: ['options'] });
      void queryClient.invalidateQueries({ queryKey: ['workorders'] });
      // 반영할 추가금액이 남아 있으면 목록으로 나가지 않고 이 화면에서 안내한다.
      if (result.surcharge?.pending) return;
      navigate('/options');
    },
    onError: (e: Error) => message.error(e.message),
  });

  // 확정 세션 재선택(설계서 §8.5) — 시작 API가 확정본을 복사한 새 선택 버전을 만든다.
  const reopenMutation = useMutation({
    mutationFn: () => startOptionSession(orderItemId ?? '', session?.fabric ?? undefined),
    onSuccess: (created) => {
      queryClient.setQueryData(['options', 'session', orderItemId], created);
      void queryClient.invalidateQueries({ queryKey: ['options'] });
      void queryClient.invalidateQueries({ queryKey: ['workorders'] });
      message.success('새 선택 버전으로 변경을 시작했습니다. 수정 후 다시 확정해 주세요.');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const openReopenDialog = () => {
    modal.confirm({
      title: '확정된 옵션 변경',
      icon: <ExclamationCircleOutlined />,
      content:
        '확정본은 그대로 두고 새 선택 버전에서 이어서 수정합니다. 변경 후에는 다시 확정해야 하며, 작업지시서 재출력 대상이 됩니다. 변경하시겠습니까?',
      okText: '변경 시작',
      cancelText: '취소',
      okButtonProps: { size: 'large' },
      cancelButtonProps: { size: 'large' },
      onOk: () => reopenMutation.mutateAsync(),
    });
  };

  const applyMutation = useMutation({
    mutationFn: () => applyOptionSurcharge(sessionId ?? ''),
    onSuccess: (result) => {
      message.success(`계약금액에 반영되었습니다. 계약금액 ${won(result.contract?.totalAmount ?? 0)}`);
      void queryClient.invalidateQueries({ queryKey: ['options'] });
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const openApplyDialog = (surcharge: OptionSurcharge) => {
    const c = surcharge.contract;
    modal.confirm({
      title: '계약금액에 반영',
      icon: <ExclamationCircleOutlined />,
      content: c
        ? `옵션 추가금액 ${won(surcharge.pending)}을 계약 ${c.contractNo}에 반영합니다. ` +
          `계약금액 ${won(c.totalAmount)} → ${won(c.afterTotalAmount)}, ` +
          `잔금 ${won(c.balanceAmount)} → ${won(c.afterBalanceAmount)}. ` +
          '변경계약(새 버전)은 만들지 않고 현재 버전 금액을 수정합니다. 적용할까요?'
        : '적용할까요?',
      okText: '적용',
      cancelText: '취소',
      okButtonProps: { size: 'large' },
      cancelButtonProps: { size: 'large' },
      onOk: () => applyMutation.mutateAsync(),
    });
  };

  if (sessionQuery.isLoading || reviewQuery.isLoading) {
    return <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />;
  }
  // 세션이 아직 없는 품목은 에러가 아니라 "선택 미시작" 상태다 (백엔드는 session: null로 응답).
  if (sessionQuery.isSuccess && !session) {
    return (
      <Alert
        type="info"
        showIcon
        message="아직 스타일 컨설팅을 시작하지 않은 품목입니다."
        action={
          <Button size="large" onClick={() => navigate(`/options/${orderItemId}`)}>
            선택 시작
          </Button>
        }
      />
    );
  }
  if (sessionQuery.error || reviewQuery.error || !review) {
    return (
      <Alert
        type="error"
        showIcon
        message="옵션 확인서를 불러오지 못했습니다."
        description={((sessionQuery.error ?? reviewQuery.error) as Error | null)?.message}
        action={
          <Button size="large" onClick={() => navigate(-1)}>
            이전화면
          </Button>
        }
      />
    );
  }

  const isConfirmed = review.status === 'CONFIRMED';

  const openConfirmDialog = () => {
    modal.confirm({
      title: '옵션 최종 저장(확정)',
      icon: <ExclamationCircleOutlined />,
      content:
        '선택한 옵션을 확정합니다. 확정 후 옵션을 변경하면 작업지시서 재출력 필요 대상이 됩니다. 확정하시겠습니까?',
      okText: '확정',
      cancelText: '취소',
      okButtonProps: { size: 'large' },
      cancelButtonProps: { size: 'large' },
      onOk: () => confirmMutation.mutateAsync(),
    });
  };

  const renderStageCard = (st: OptionReviewStage) => {
    const missing = !st.choiceId;
    return (
      <Col xs={12} md={8} lg={6} key={st.stageId}>
        <Card
          hoverable
          onClick={() => navigate(`/options/${orderItemId}?stage=${st.order}`)}
          style={{
            marginBottom: 16,
            border: missing ? '2px dashed #ff4d4f' : '1px solid #d9d9d9',
            borderRadius: 12,
          }}
          styles={{ body: { padding: 12 } }}
        >
          <StageMedia st={st} />
          <Space direction="vertical" size={0} style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">{st.order}단계</Typography.Text>
            <Typography.Text strong style={{ fontSize: 15 }}>
              {st.name}
            </Typography.Text>
            <Typography.Text>{st.choiceName ?? '선택 필요'}</Typography.Text>
            {st.extraPrice > 0 && (
              <Typography.Text strong style={{ color: '#cf1322' }}>
                +{won(st.extraPrice)}
              </Typography.Text>
            )}
          </Space>
        </Card>
      </Col>
    );
  };

  /**
   * 단계 카드를 부위(상의/하의/베스트)로 나눈다 — 정장처럼 부위가 여럿인 카테고리만.
   * 확인서 응답에는 단계의 부위가 없어, 같은 세션의 상세(stages[].componentGroup)로 매핑한다.
   * 셔츠·구두처럼 부위가 하나면 빈 배열 → 기존처럼 한 줄로 펼친다.
   */
  const groupOfStage = new Map((session?.stages ?? []).map((s) => [s.stageId, s.componentGroup]));
  const groups = componentGroupsFor(session?.productCategory);
  const stageSections =
    groups.length > 1
      ? groups
          .map((g) => {
            const stages = review.stages.filter((s) => groupOfStage.get(s.stageId) === g);
            return {
              key: g,
              label: componentGroupLabel(g),
              stages,
              missingRequired: stages.filter((s) => s.required && !s.choiceId).length,
            };
          })
          .filter((sec) => sec.stages.length > 0)
      : [];
  // 부위가 지정되지 않은 단계도 빠뜨리지 않는다.
  const ungrouped =
    stageSections.length > 0
      ? review.stages.filter((s) => !groups.includes(groupOfStage.get(s.stageId) ?? ''))
      : [];
  if (ungrouped.length > 0)
    stageSections.push({
      key: '__etc',
      label: '기타',
      stages: ungrouped,
      missingRequired: ungrouped.filter((s) => s.required && !s.choiceId).length,
    });

  return (
    // Space가 아니라 Flex다 — Space는 자식마다 래퍼 div를 만들어 그 안에 갇힌
    // sticky 액션바가 따라오지 못한다(계약서 작성 화면과 동일한 이유로 Flex 사용).
    <Flex vertical gap={16} style={{ width: '100%' }}>
      {modalContextHolder}
      {/*
        작업 표시줄 — 부위별 카드가 길어 스크롤해도 상태·확정·반영 버튼이 따라온다
        (계약서 작성 화면과 동일한 sticky 액션바). 안내 Alert는 아래 카드로 내려
        이 줄이 얇게 유지되도록 한다.
      */}
      <Card
        styles={{ body: { padding: '12px 20px' } }}
        style={{ position: 'sticky', top: 0, zIndex: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
      >
        <Space align="center" wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space size={10} wrap>
            {/* 고객명·주문번호·옵션세트명은 백엔드 확인서 응답에 없다 (docs/dev/08 §4) */}
            <Typography.Title level={5} style={{ margin: 0 }}>
              옵션 확인서 — {session?.displayName ?? '맞춤 품목'}
            </Typography.Title>
            <Typography.Text type="secondary">
              {fabricFieldLabel(session?.productCategory)}: {review.fabric ?? '미입력'} · 옵션 세트 V
              {session?.optionSetVersionNo ?? '-'}
            </Typography.Text>
          </Space>
          {/*
            화면의 기능 버튼은 우상단 한 곳에 모은다 (렌탈 스타일 선택 화면과 동일 규칙).
            확정 → 계약금액 반영이 한 자리에서 이어지도록 반영 버튼도 같은 줄에 둔다.
            하단은 페이지 이동(이전화면) 전용이다.
          */}
          <Space wrap>
            <StatusBadge
              label={metaOf(OPTION_STATUS_META, review.status).label}
              color={metaOf(OPTION_STATUS_META, review.status).color}
            />
            {isConfirmed && <CheckCircleFilled style={{ color: '#52c41a', fontSize: 24 }} />}
            {review.surcharge.pending !== 0 && (
              <Tooltip
                title={
                  review.surcharge.appliable ? '' : '옵션을 확정한 뒤 계약금액에 반영할 수 있습니다.'
                }
              >
                <Button
                  icon={<CalculatorOutlined />}
                  disabled={!review.surcharge.appliable}
                  loading={applyMutation.isPending}
                  onClick={() => openApplyDialog(review.surcharge)}
                >
                  계약금액 반영
                </Button>
              </Tooltip>
            )}
            {isConfirmed ? (
              <Button
                type="primary"
                icon={<EditOutlined />}
                loading={reopenMutation.isPending}
                onClick={openReopenDialog}
              >
                옵션 변경
              </Button>
            ) : (
              <Tooltip
                title={review.missingCount > 0 ? '필수 단계를 모두 선택해야 확정할 수 있습니다.' : ''}
              >
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  disabled={review.missingCount > 0}
                  loading={confirmMutation.isPending}
                  onClick={openConfirmDialog}
                >
                  최종 저장(확정)
                </Button>
              </Tooltip>
            )}
          </Space>
        </Space>
      </Card>

      {review.missingCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`선택하지 않은 필수 단계가 ${review.missingCount}개 있습니다. 카드를 눌러 해당 단계를 선택해 주세요.`}
        />
      )}
      {/* 베스트처럼 선택 단계는 안 골라도 확정된다 — 확정을 막지 않고 안내만 한다. */}
      {review.missingCount === 0 && review.missingOptionalCount > 0 && !isConfirmed && (
        <Alert
          type="info"
          showIcon
          message={`선택하지 않은 선택 단계가 ${review.missingOptionalCount}개 있습니다. 필요 없으면 그대로 확정할 수 있습니다.`}
        />
      )}
      {isConfirmed && (
        <Alert
          type="success"
          showIcon
          message="확정된 옵션입니다. 카드를 눌러 열람하고, 바꾸려면 위 '옵션 변경'을 눌러 새 선택 버전을 시작하세요."
        />
      )}

      <ComponentAttrsSummary components={review.components} />

      <SurchargePanel surcharge={review.surcharge} />

      {stageSections.length > 0 ? (
        stageSections.map((sec) => (
          <Card
            key={sec.key}
            size="small"
            styles={{ body: { paddingBottom: 0 } }}
            title={
              <Space size={10}>
                <Typography.Text strong style={{ fontSize: 15 }}>
                  {sec.label}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
                  {sec.stages.filter((s) => s.choiceId).length}/{sec.stages.length} 선택
                </Typography.Text>
                {sec.missingRequired > 0 && (
                  <Tag color="red" style={{ margin: 0 }}>
                    필수 {sec.missingRequired}개 미선택
                  </Tag>
                )}
              </Space>
            }
          >
            <Row gutter={16}>{sec.stages.map(renderStageCard)}</Row>
          </Card>
        ))
      ) : (
        <Row gutter={16}>{review.stages.map(renderStageCard)}</Row>
      )}

      {/* 하단은 페이지 이동 전용 — 기능 버튼(확정·반영)은 위 헤더 액션바에 있다. */}
      <Card>
        <BackButton />
      </Card>
    </Flex>
  );
}
