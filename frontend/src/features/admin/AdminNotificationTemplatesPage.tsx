/**
 * ADMIN 연락 문구 관리 (개발설계서 05 G-06 / §4.1)
 *
 * 고객에게 나갈 문구의 원문을 여기서 보고 고친다. 어느 시점에 어떤 문구를 쓸지는
 * `고객 연락` 화면의 `단계별 연락 문구`에서 연결한다.
 *
 * 승인 상태는 이 화면의 값이 곧 발송 채널을 결정한다 —
 * 승인 문구를 그대로 보낼 때만 알림톡으로 나가고, 그 외에는 SMS다(설계서 05 §4.1).
 * 실제 승인은 알림톡 벤더 콘솔에서 이뤄지므로 여기의 `승인`은 그 결과를 기록하는 값이다.
 */
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  NOTIFICATION_CHANNEL_META,
  TEMPLATE_STATUS_META,
  createNotificationTemplate,
  extractTemplateVariables,
  fetchNotificationTemplates,
  updateNotificationTemplate,
} from '../../api/notifications';
import type {
  NotificationChannel,
  NotificationTemplate,
  TemplateStatus,
} from '../../api/notifications';
import { Can } from '../../shared/Can';
import { metaOf } from '../../shared/status-meta';
import { autoWidth } from '../../shared/table-width';

/** 발송 시 서버가 고객·주문에서 자동으로 채우는 변수 (notification-suggestion.service.ts) */
const AUTO_VARIABLES = ['고객명', '품목', '반납예정일'];

interface FormValues {
  code: string;
  name: string;
  channel: NotificationChannel;
  status: TemplateStatus;
  content: string;
}

export function AdminNotificationTemplatesPage() {
  const [editTarget, setEditTarget] = useState<NotificationTemplate | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();

  const listQuery = useQuery({
    queryKey: ['notification-templates'],
    queryFn: fetchNotificationTemplates,
  });

  const open = !!editTarget || createOpen;
  const close = () => {
    setEditTarget(null);
    setCreateOpen(false);
  };

  const invalidate = () => {
    // 발송 화면·단계 매핑 카드가 같은 목록을 쓴다.
    void queryClient.invalidateQueries({ queryKey: ['notification-templates'] });
  };
  const onApiError = (e: unknown) =>
    message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) =>
      editTarget
        ? updateNotificationTemplate(editTarget.id, values)
        : createNotificationTemplate(values),
    onSuccess: () => {
      message.success(editTarget ? '문구를 저장했습니다.' : '문구를 추가했습니다.');
      close();
      invalidate();
    },
    onError: onApiError,
  });

  const startCreate = () => {
    setEditTarget(null);
    setCreateOpen(true);
    form.setFieldsValue({
      code: '',
      name: '',
      channel: 'ALIMTALK',
      status: 'PENDING',
      content: '',
    });
  };

  const startEdit = (row: NotificationTemplate) => {
    setCreateOpen(false);
    setEditTarget(row);
    form.setFieldsValue({
      code: row.code,
      name: row.name,
      channel: row.channel,
      status: row.status,
      content: row.content,
    });
  };

  const submit = () =>
    void form.validateFields().then((values) => {
      // 승인 표시는 곧 알림톡 발송 허용이다. 벤더 승인 없이 올리면 반려 대상이므로 한 번 묻는다.
      if (values.status === 'APPROVED' && editTarget?.status !== 'APPROVED') {
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

  const columns: ColumnsType<NotificationTemplate> = [
    { title: '코드', dataIndex: 'code', ...autoWidth() },
    { title: '이름', dataIndex: 'name', ...autoWidth() },
    {
      title: '채널',
      dataIndex: 'channel',
      ...autoWidth(),
      render: (c: NotificationChannel) => {
        const meta = metaOf(NOTIFICATION_CHANNEL_META, c);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '승인 상태',
      dataIndex: 'status',
      ...autoWidth(),
      render: (s: TemplateStatus) => {
        const meta = metaOf(TEMPLATE_STATUS_META, s);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '문구',
      dataIndex: 'content',
      // 열 ellipsis 옵션은 표 전체를 고정 레이아웃으로 되돌린다. 셀 안에서 잘라 자동 폭을 유지한다.
      render: (v: string) => (
        <Typography.Text style={{ maxWidth: 460 }} ellipsis={{ tooltip: v }}>
          {v || '-'}
        </Typography.Text>
      ),
    },
    {
      title: '변수',
      dataIndex: 'variables',
      render: (vars: string[]) =>
        vars.length === 0 ? (
          <Typography.Text type="secondary">-</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {vars.map((v) => (
              <Tag key={v} color={AUTO_VARIABLES.includes(v) ? 'blue' : undefined}>
                {v}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '작업',
      key: 'action',
      ...autoWidth(),
      render: (_, row) => (
        <Can permission="ADMIN_MASTER_EDIT">
          <Button size="small" onClick={() => startEdit(row)}>
            수정
          </Button>
        </Can>
      ),
    },
  ];

  return (
    <Card
      title="연락 문구"
      extra={
        <Can permission="ADMIN_MASTER_EDIT">
          <Button type="primary" icon={<PlusOutlined />} onClick={startCreate}>
            문구 추가
          </Button>
        </Can>
      }
    >
      <Typography.Paragraph type="secondary">
        고객에게 나갈 문구의 원문입니다. <Tag color="blue">파란 변수</Tag>는 발송할 때 고객·주문
        정보로 자동으로 채워집니다. 어느 시점에 어떤 문구를 쓸지는 `고객 연락` 화면의 `단계별 연락
        문구`에서 연결합니다.
      </Typography.Paragraph>

      <Table<NotificationTemplate>
        rowKey="id"
        size="small"
        scroll={{ x: 'max-content' }}
        loading={listQuery.isLoading}
        dataSource={listQuery.data ?? []}
        columns={columns}
        pagination={false}
      />

      <Modal
        title={editTarget ? `문구 수정 — ${editTarget.name}` : '문구 추가'}
        open={open}
        onCancel={close}
        okText="저장"
        cancelText="취소"
        width={640}
        confirmLoading={saveMutation.isPending}
        onOk={submit}
        destroyOnClose
      >
        <Form<FormValues> form={form} layout="vertical">
          <Form.Item
            label="코드"
            name="code"
            rules={[{ required: true, message: '코드를 입력해 주세요.' }]}
            extra={
              editTarget
                ? '코드는 단계 매핑·발송 이력이 참조하므로 바꿀 수 없습니다.'
                : '영문 대문자·언더스코어 권장. 생성 후 변경할 수 없습니다.'
            }
          >
            <Input placeholder="예: JOURNEY_PRODUCT_RECEIVED" disabled={!!editTarget} />
          </Form.Item>
          <Form.Item
            label="이름"
            name="name"
            rules={[{ required: true, message: '이름을 입력해 주세요.' }]}
          >
            <Input placeholder="단계 매핑·발송 화면에 표시됩니다." />
          </Form.Item>
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
              <Form.Item
                label="승인 상태"
                name="status"
                extra="승인된 문구만 알림톡으로 나갑니다."
              >
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
            <Input.TextArea rows={7} showCount placeholder="예: #{고객명}님, 주문하신 #{품목}이 입고되었습니다." />
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
    </Card>
  );
}
