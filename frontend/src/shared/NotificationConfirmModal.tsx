import { App, Descriptions, Input, Modal, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { sendNotification } from '../api/notifications';

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
  /** 같은 트리거는 한 번만 발송되도록 백엔드가 쓰는 멱등키 */
  triggerKey: string;
}

interface Props {
  open: boolean;
  /** 창 상단에 보여줄 변경 내용 (예: "완성복 입고으로 변경했습니다") */
  title: string;
  suggestion: NotificationSuggestion | null;
  /** 처리 결과를 이력에 봉합하도록 부모에게 알린다. */
  onDone: (outcome: SendOutcome, notificationHistoryId?: string) => void | Promise<void>;
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

  const finish = async (outcome: SendOutcome, historyId?: string) => {
    try {
      await onDone(outcome, historyId);
    } catch {
      // 봉합 실패는 발송 자체를 무르지 않는다. 이력에만 남지 않을 뿐이다.
      message.warning('발송은 되었지만 이력 기록에 실패했습니다.');
    }
  };

  const handleSend = async () => {
    setSending(true);
    try {
      const { results } = await sendNotification({
        customerId: suggestion.customerId,
        phone: suggestion.recipientPhone,
        templateId: suggestion.templateId,
        // 담당자가 본문을 고쳤을 수 있으므로 최종 문구를 변수로 덮어 보낸다.
        variables: { ...suggestion.variables, 본문: body },
        fallbackSms: true,
        orderId: suggestion.orderId ?? undefined,
        triggerKey: suggestion.triggerKey,
      });
      const sent = results.find((r) => r.status === 'SENT') ?? results[0];
      if (sent?.status === 'SENT') {
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
      footer={[
        <a
          key="skip"
          style={{ marginRight: 16 }}
          onClick={() => void finish('SKIPPED')}
        >
          안 보냄
        </a>,
        <a key="later" style={{ marginRight: 16 }} onClick={() => void finish('DEFERRED')}>
          나중에
        </a>,
        <button
          key="send"
          className="ant-btn ant-btn-primary"
          disabled={sending || !body.trim()}
          onClick={() => void handleSend()}
        >
          발송
        </button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">고객에게 알림을 보낼까요?</Typography.Text>
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="받는 사람">{suggestion.recipientPhone}</Descriptions.Item>
          <Descriptions.Item label="채널">
            <Tag color={suggestion.channel === 'ALIMTALK' ? 'gold' : 'blue'}>
              {suggestion.channel === 'ALIMTALK' ? '알림톡' : 'SMS'}
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
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          &quot;나중에&quot;를 고르면 대시보드 연락 대기 목록에 남습니다.
        </Typography.Text>
      </Space>
    </Modal>
  );
}
