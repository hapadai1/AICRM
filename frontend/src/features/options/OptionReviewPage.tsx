/** OPT-003 옵션 확인서 — 전체 단계 카드 검토 후 최종 저장(확정) */
import { CheckCircleFilled, ExclamationCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Image, Modal, Row, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchFileObjectUrl } from '../../api/client';
import type { OptionReviewStage } from '../../api/options';
import { confirmOptionSession, fetchOptionReview, fetchOptionSessionByItem } from '../../api/options';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { choiceColor, OPTION_STATUS_META } from './option-meta';

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
      <div style={{ height: 110, borderRadius: 8, overflow: 'hidden', background: '#f5f5f5' }}>
        {/* 카드 전체가 '눌러 재선택' 대상이므로 preview는 끄고 클릭이 카드로 전파되게 둔다. */}
        <Image src={src} alt={st.choiceName ?? st.name} width="100%" height={110} style={{ objectFit: 'contain' }} preview={false} />
      </div>
    );
  }

  return (
    <div
      style={{
        height: 110,
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
    onSuccess: () => {
      message.success('옵션이 확정되었습니다. 작업지시서 출력이 가능합니다.');
      void queryClient.invalidateQueries({ queryKey: ['options'] });
      void queryClient.invalidateQueries({ queryKey: ['workorders'] });
      navigate('/options');
    },
    onError: (e: Error) => message.error(e.message),
  });

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
