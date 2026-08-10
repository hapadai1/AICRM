/**
 * ADMIN 연락 문구 관리 (개발설계서 05 G-06 / §4.1)
 *
 * 각 연락 시점(진행 단계)마다 고객에게 보낼 문구 하나를 관리하는 화면이다(`StageContactCard`).
 * 문구는 시점 하나에만 붙으므로 문구 목록·매핑 드롭다운이 없고, 코드·이름도 서버가 단계에서
 * 만든다 — 담당자가 정할 값이 아니다. 이 페이지는 그 표가 여는 편집 모달만 맡는다.
 *
 * 담당자 화면(`고객 연락`)은 발송·이력 전용이다. 여기 설정은 전부 ADMIN_MASTER_EDIT 권한이다.
 *
 * 승인 상태는 이 화면의 값이 곧 발송 채널을 결정한다 —
 * 승인 문구를 그대로 보낼 때만 알림톡으로 나가고, 그 외에는 SMS다(설계서 05 §4.1).
 * 실제 승인은 알림톡 벤더 콘솔에서 이뤄지므로 여기의 `승인`은 그 결과를 기록하는 값이다.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Col, Form, Input, Modal, Row, Select, Typography } from 'antd';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { putStageMessage, type StageMessage } from '../../api/journeys';
import {
  AUTO_VARIABLES,
  TEMPLATE_STATUS_META,
  extractTemplateVariables,
} from '../../api/notifications';
import type { NotificationChannel, TemplateStatus } from '../../api/notifications';
import { PageShell } from '../../shared/PageShell';
import { metaOf } from '../../shared/status-meta';
import { StageContactCard } from './StageContactCard';

interface FormValues {
  channel: NotificationChannel;
  status: TemplateStatus;
  content: string;
}

/** 편집 대상 = 연락 시점 하나. message가 없으면 새로 쓰는 것이다. */
interface EditTarget {
  id: string;
  name: string;
  message: StageMessage | null;
}

export function AdminNotificationTemplatesPage() {
  const [target, setTarget] = useState<EditTarget | null>(null);
  const [form] = Form.useForm<FormValues>();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();

  const close = () => setTarget(null);

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) =>
      putStageMessage(target!.id, {
        body: values.content,
        channel: values.channel,
        approvalStatus: values.status,
      }),
    onSuccess: () => {
      message.success(target?.message ? '문구를 저장했습니다.' : '문구를 작성했습니다.');
      close();
      void queryClient.invalidateQueries({ queryKey: ['journey-stages'] });
      // 발송 화면의 문구 목록도 같은 문구를 쓴다.
      void queryClient.invalidateQueries({ queryKey: ['notification-templates'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.'),
  });

  const startEdit = (stage: EditTarget) => {
    setTarget(stage);
    form.setFieldsValue({
      channel: stage.message?.channel ?? 'ALIMTALK',
      status: stage.message?.approvalStatus ?? 'PENDING',
      content: stage.message?.body ?? '',
    });
  };

  const submit = () =>
    void form.validateFields().then((values) => {
      // 승인 표시는 곧 알림톡 발송 허용이다. 벤더 승인 없이 올리면 반려 대상이므로 한 번 묻는다.
      if (values.status === 'APPROVED' && target?.message?.approvalStatus !== 'APPROVED') {
        modal.confirm({
          title: '승인 문구로 표시할까요?',
          content:
            '알림톡 벤더에서 이 문구가 실제로 승인된 경우에만 선택하세요. 승인 표시된 문구는 고치지 않고 보낼 때 알림톡으로 발송됩니다.',
          okText: '승인으로 표시',
          cancelText: '취소',
          onOk: () => saveMutation.mutate(values),
        });
        return;
      }
      saveMutation.mutate(values);
    });

  return (
    <PageShell>
      {/* 연락 시점마다 문구 하나 — 쓰기·고치기·지우기를 그 줄에서 */}
      <StageContactCard onEdit={startEdit} />

      <Modal
        title={
          target?.message ? `문구 수정 — ${target.name}` : `문구 작성 — ${target?.name ?? ''}`
        }
        open={!!target}
        onCancel={close}
        okText="저장"
        cancelText="취소"
        width={640}
        confirmLoading={saveMutation.isPending}
        onOk={submit}
        destroyOnHidden
      >
        <Form<FormValues> form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="채널" name="channel">
                <Select
                  options={[
                    { value: 'ALIMTALK', label: '알림톡' },
                    { value: 'SMS', label: 'SMS' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="승인 상태" name="status" extra="승인된 문구만 알림톡으로 나갑니다.">
                <Select
                  options={(['APPROVED', 'PENDING', 'REJECTED'] as TemplateStatus[]).map((s) => ({
                    value: s,
                    label: metaOf(TEMPLATE_STATUS_META, s).label,
                  }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            label="문구"
            name="content"
            rules={[{ required: true, message: '문구를 입력해 주세요.' }]}
            extra={`자동으로 채워지는 변수: ${AUTO_VARIABLES.map((v) => `#{${v}}`).join(' · ')}`}
          >
            <Input.TextArea
              rows={10}
              showCount
              placeholder="예: 안녕하세요, #{고객명} 고객님. 주문하신 #{품목}이 입고되었습니다."
            />
          </Form.Item>
          {/* 오타로 자동 치환에서 빠지는 변수를 저장 전에 눈으로 잡는다. */}
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.content !== next.content}>
            {({ getFieldValue }) => {
              const used = extractTemplateVariables(getFieldValue('content') ?? '');
              const unknown = used.filter((v) => !AUTO_VARIABLES.includes(v));
              if (unknown.length === 0) return null;
              return (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  {unknown.map((v) => `#{${v}}`).join(', ')} 은(는) 자동으로 채워지지 않습니다.
                  발송 화면에서 담당자가 직접 값을 넣어야 합니다.
                </Typography.Text>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>
    </PageShell>
  );
}
