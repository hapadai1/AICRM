import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, DatePicker, Empty, Form, Input, List, Modal, Select, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { ApiError } from '../../api/client';
import {
  COMPONENT_TYPE_LABELS,
  createFitting,
  fetchFittings,
  type ProductionItem,
} from '../../api/production';
import { labelOf } from '../../shared/status-meta';

interface FittingFormValues {
  fittingDate: Dayjs;
  componentIds: string[];
  correction: string;
  nextVisitDate?: Dayjs;
}

interface FittingModalProps {
  item: ProductionItem;
  open: boolean;
  onClose: () => void;
}

/** FIT-001 가봉·피팅 기록 모달: 가봉일·대상 구성품·보정 내용·다음 방문일 */
export function FittingModal({ item, open, onClose }: FittingModalProps) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FittingFormValues>();

  const fittingsQuery = useQuery({
    queryKey: ['production', item.orderItemId, 'fittings'],
    queryFn: () => fetchFittings(item.orderItemId),
    enabled: open,
  });

  const saveMutation = useMutation({
    mutationFn: (values: FittingFormValues) =>
      createFitting(item.orderItemId, {
        fittingDate: values.fittingDate.format('YYYY-MM-DD'),
        componentIds: values.componentIds,
        correction: values.correction,
        nextVisitDate: values.nextVisitDate?.format('YYYY-MM-DD'),
      }),
    onSuccess: () => {
      message.success('가봉 기록이 저장되었습니다.');
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['production'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '가봉 기록 저장에 실패했습니다.'),
  });

  return (
    <Modal
      title={`가봉·피팅 기록 — ${item.customerName} · ${item.displayName}`}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="기록 저장"
      cancelText="닫기"
      confirmLoading={saveMutation.isPending}
      width={640}
      destroyOnClose
    >
      <Form<FittingFormValues>
        form={form}
        layout="vertical"
        initialValues={{ fittingDate: dayjs() }}
        onFinish={(values) => saveMutation.mutate(values)}
      >
        <Form.Item
          name="fittingDate"
          label="가봉일"
          rules={[{ required: true, message: '가봉일을 선택해 주세요.' }]}
        >
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="componentIds"
          label="대상 구성품"
          rules={[{ required: true, message: '대상 구성품을 선택해 주세요.' }]}
        >
          <Select
            mode="multiple"
            placeholder="가봉 대상 구성품 선택 (복수 가능)"
            options={item.components.map((c) => ({
              value: c.id,
              label: `${labelOf(COMPONENT_TYPE_LABELS, c.componentType)} #${c.sequenceNo}`,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="correction"
          label="보정 내용"
          rules={[{ required: true, message: '보정 내용을 입력해 주세요.' }]}
        >
          <Input.TextArea rows={3} placeholder="실루엣·균형·여유분·길이 등 보정 내용" />
        </Form.Item>
        <Form.Item name="nextVisitDate" label="다음 방문일">
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
      </Form>

      <Typography.Title level={5} style={{ marginTop: 8 }}>
        가봉 이력
      </Typography.Title>
      {fittingsQuery.data && fittingsQuery.data.length > 0 ? (
        <List
          size="small"
          loading={fittingsQuery.isLoading}
          dataSource={fittingsQuery.data}
          renderItem={(f) => (
            // 백엔드는 담당자명·단일 보정문구 없이 adjustments 배열을 내려준다 (docs/dev/08 §4).
            <List.Item>
              <List.Item.Meta
                title={`${f.fittingDate} · 보정 ${f.adjustments.length}건`}
                description={
                  <>
                    {f.adjustments.map((a) => (
                      <div key={a.id}>
                        {a.componentLabel} · {a.area}: {a.instruction}
                      </div>
                    ))}
                    {f.notes && <div>{f.notes}</div>}
                    {f.nextAppointmentDate && (
                      <Typography.Text type="secondary">
                        다음 방문일: {f.nextAppointmentDate}
                      </Typography.Text>
                    )}
                  </>
                }
              />
            </List.Item>
          )}
        />
      ) : (
        <Empty description="가봉 이력이 없습니다." image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </Modal>
  );
}
