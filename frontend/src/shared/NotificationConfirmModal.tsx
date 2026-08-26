import { App, Button, Descriptions, Input, Modal, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { sendNotification } from '../api/notifications';
import { formatPhone } from './phone';

/**
 * 고객 연락 발송 확인창 (개발설계서 05 G-06).
 *
 * 상태를 바꾸면 시스템이 문구를 준비해 이 창을 띄우고, 담당자가 내용을 확인한 뒤
 * [발송]을 누를 때만 실제로 나간다. 자동 발송은 하지 않는다.
 * 진행 단계 변경과 수선 상태 변경이 이 컴포넌트를 공유한다.
 */

export type SendOutcome = 'SENT' | 'DEFERRED' | 'SKIPPED';

export interface NotificationSuggestion {
  templateId: string;
  templateName: string;
  channel: string;
  recipientPhone: string;
  customerId: string;
  orderId?: string | null;
  variables: Record<string, string>;
  renderedBody: string;
  /**
   * 같은 트리거는 한 번만 발송되도록 백엔드가 쓰는 멱등키.
   * 생략하면(수동 재발송) 멱등 차단 없이 매번 나간다.
   */
  triggerKey?: string;
}

interface Props {
  open: boolean;
  /** 창 상단에 보여줄 변경 내용 (예: "완성복 입고으로 변경했습니다") */
  title: string;
  suggestion: NotificationSuggestion | null;
  /**
   * 처리 결과를 이력에 봉합하도록 부모에게 알린다.
   * sentBody는 실제로 나간 문구 — 담당자가 창에서 고쳤을 수 있어 원문과 다를 수 있다.
   */
  onDone: (outcome: SendOutcome, notificationHistoryId?: string, sentBody?: string) => void | Promise<void>;
  onCancel: () => void;
}

export function NotificationConfirmModal({ open, title, suggestion, onDone, onCancel }: Props) {
  const { message } = App.useApp();
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  // 제안이 바뀌면 편집 중이던 본문을 새 문구로 되돌린다.
  useEffect(() => {
    setBody(suggestion?.renderedBody ?? '');
  }, [suggestion]);

  if (!suggestion) return null;

  // 알림톡은 승인된 문구 그대로일 때만 나간다. 고친 문구는 SMS로 발송된다.
  const edited = body !== suggestion.renderedBody;
  const channel = edited ? 'SMS' : suggestion.channel;

  const finish = async (outcome: SendOutcome, historyId?: string) => {
    try {
      await onDone(outcome, historyId, body);
    } catch {
      // 봉합 실패는 발송 자체를 무르지 않는다. 이력에만 남지 않을 뿐이다.
      message.warning('발송은 되었지만 이력 기록에 실패했습니다.');
    }
  };

  const handleSend = async () => {
    setSending(true);
    try {
      const { results, duplicated } = await sendNotification({
        customerId: suggestion.customerId,
        phone: suggestion.recipientPhone,
        templateId: suggestion.templateId,
        variables: suggestion.variables,
        // 담당자가 창에서 고친 문구가 있으면 그대로 나간다(원문 그대로면 템플릿 채널 유지).
        body,
        fallbackSms: true,
        orderId: suggestion.orderId ?? undefined,
        triggerKey: suggestion.triggerKey,
      });
      const sent = results.find((r) => r.status === 'SENT') ?? results[0];
      if (duplicated) {
        // 이 단계에서 이미 나간 연락이다(되돌렸다 다시 전진한 경우 등). 서버가 재발송을
        // 막았으므로 "발송했습니다"라고 알리면 사실과 다르다.
        message.info('이 단계의 연락은 이미 발송되어 다시 보내지 않았습니다.');
      } else if (sent?.status === 'SENT') {
        message.success('발송했습니다.');
      } else {
        message.warning(`발송에 실패했습니다: ${sent?.failReason ?? '알 수 없는 오류'}`);
      }
      await finish('SENT', sent?.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '발송에 실패했습니다.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onCancel}
      confirmLoading={sending}
      maskClosable={false}
      width={560}
      /*
       * 왼쪽은 "이번엔 안 보낸다"는 두 갈래, 오른쪽은 닫기와 발송.
       * 예전에는 <a>와 맨 <button>을 섞어 써서 셋의 크기·정렬이 제각각이었다.
       */
      footer={
        <Space style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Space size={8}>
            <Button onClick={() => void finish('SKIPPED')}>안 보냄</Button>
            <Button onClick={() => void finish('DEFERRED')}>나중에</Button>
          </Space>
          <Space size={8}>
            <Button onClick={onCancel}>닫기</Button>
            <Button type="primary" loading={sending} disabled={!body.trim()} onClick={() => void handleSend()}>
              발송
            </Button>
          </Space>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">고객에게 알림을 보낼까요?</Typography.Text>
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="받는 사람">{formatPhone(suggestion.recipientPhone)}</Descriptions.Item>
          <Descriptions.Item label="채널">
            <Tag color={channel === 'ALIMTALK' ? 'gold' : 'blue'}>
              {channel === 'ALIMTALK' ? '알림톡' : 'SMS'}
            </Tag>
            <Typography.Text type="secondary">{suggestion.templateName}</Typography.Text>
          </Descriptions.Item>
        </Descriptions>
        <Input.TextArea
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="보낼 내용"
        />
        {edited && suggestion.channel === 'ALIMTALK' && (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            문구를 고쳤으므로 알림톡 대신 SMS로 발송됩니다.
          </Typography.Text>
        )}
        {/* 셋의 차이가 안 보이면 아무 버튼이나 누르게 된다 — 무엇이 남는지 적어 둔다. */}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <b>안 보냄</b> 이번엔 연락하지 않기로 함 · <b>나중에</b> 아직 안 보냄(연락 대기로 남음) ·{' '}
          <b>닫기</b> 아무것도 기록하지 않고 닫기
        </Typography.Text>
      </Space>
    </Modal>
  );
}
