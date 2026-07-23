/** OPT-003 옵션 확인서 — 전체 단계 카드 검토 후 최종 저장(확정) */
import { CheckCircleFilled, ExclamationCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Image, Modal, Row, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchFileObjectUrl } from '../../api/client';
import type { OptionReviewStage, OptionSurcharge } from '../../api/options';
import {
  applyOptionSurcharge,
  confirmOptionSession,
  fetchOptionReview,
  fetchOptionSessionByItem,
} from '../../api/options';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { choiceColor, OPTION_STATUS_META, PHOTO_MAT_PX, photoMatStyle } from './option-meta';

/** 선택지 사진이 세로로 긴 원본이라 확인서 카드도 세로로 넉넉히 잡는다. */
const MEDIA_HEIGHT = 260;
/** 카드가 작아 흰 여백은 선택 화면보다 좁게 두른다. */
const MAT_SCALE = 0.6;
/** 여백(위아래)과 테두리를 뺀 실제 사진 높이 */
const PHOTO_HEIGHT = MEDIA_HEIGHT - 2 * Math.round(PHOTO_MAT_PX * MAT_SCALE) - 2;

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
      <div style={{ ...photoMatStyle(MAT_SCALE), height: MEDIA_HEIGHT }}>
        {/* 카드 전체가 '눌러 재선택' 대상이므로 preview는 끄고 클릭이 카드로 전파되게 둔다. */}
        <Image
          src={src}
          alt={st.choiceName ?? st.name}
          width="100%"
          height={PHOTO_HEIGHT}
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
 * 옵션 추가금액과 계약금액 차액 안내.
 * 금액은 여기서 자동으로 바뀌지 않는다 — '계약금액에 반영'을 눌러야 반영된다.
 */
function SurchargePanel({
  surcharge,
  onApply,
  applying,
}: {
  surcharge: OptionSurcharge;
  onApply: () => void;
  applying: boolean;
}) {
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
              </Typography.Text>
            }
            action={
              surcharge.appliable ? (
                <Button type="primary" loading={applying} onClick={onApply}>
                  계약금액에 반영
                </Button>
              ) : (
                <Tooltip title="옵션을 확정한 뒤 반영할 수 있습니다.">
                  <Button disabled>계약금액에 반영</Button>
                </Tooltip>
              )
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

  const applyMutation = useMutation({
    mutationFn: () => applyOptionSurcharge(sessionId ?? ''),
    onSuccess: (result) => {
      message.success(`계약금액에 반영되었습니다. 계약금액 ${won(result.contract?.totalAmount ?? 0)}`);
      void queryClient.invalidateQueries({ queryKey: ['options'] });
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
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
          <Button size="large" onClick={() => navigate('/options')}>
            목록으로
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

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {modalContextHolder}
      <Card>
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <div>
            {/* 고객명·주문번호·옵션세트명은 백엔드 확인서 응답에 없다 (docs/dev/08 §4) */}
            <Typography.Title level={4} style={{ margin: 0 }}>
              옵션 확인서 — {session?.displayName ?? '맞춤 품목'}
            </Typography.Title>
            <Typography.Text type="secondary">
              원단: {review.fabric ?? '미입력'} · 옵션 세트 V{session?.optionSetVersionNo ?? '-'}
            </Typography.Text>
          </div>
          <Space>
            <StatusBadge
              label={metaOf(OPTION_STATUS_META, review.status).label}
              color={metaOf(OPTION_STATUS_META, review.status).color}
            />
            {isConfirmed && <CheckCircleFilled style={{ color: '#52c41a', fontSize: 24 }} />}
          </Space>
        </Space>
        {review.missingCount > 0 && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message={`선택하지 않은 단계가 ${review.missingCount}개 있습니다. 카드를 눌러 해당 단계를 선택해 주세요.`}
          />
        )}
        {isConfirmed && (
          <Alert
            style={{ marginTop: 12 }}
            type="success"
            showIcon
            message="확정된 옵션입니다. 카드를 눌러 열람할 수 있습니다."
          />
        )}
      </Card>

      <SurchargePanel
        surcharge={review.surcharge}
        applying={applyMutation.isPending}
        onApply={() => openApplyDialog(review.surcharge)}
      />

      <Row gutter={16}>{review.stages.map(renderStageCard)}</Row>

      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Button size="large" style={{ height: 56, minWidth: 140, fontSize: 18 }} onClick={() => navigate('/options')}>
            목록으로
          </Button>
          {!isConfirmed && (
            <Tooltip title={review.missingCount > 0 ? '모든 단계를 선택해야 확정할 수 있습니다.' : ''}>
              <Button
                type="primary"
                size="large"
                style={{ height: 56, minWidth: 220, fontSize: 18 }}
                disabled={review.missingCount > 0}
                loading={confirmMutation.isPending}
                onClick={openConfirmDialog}
              >
                최종 저장(확정)
              </Button>
            </Tooltip>
          )}
        </Space>
      </Card>
    </Space>
  );
}
