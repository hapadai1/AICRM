import {
  DeleteOutlined,
  DownloadOutlined,
  MinusCircleOutlined,
  PaperClipOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  DatePicker,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { RcFile } from 'antd/es/upload';
import dayjs, { type Dayjs } from 'dayjs';
import { ApiError } from '../../api/client';
import {
  COMPONENT_TYPE_LABELS,
  FITTING_AREA_CODES,
  FITTING_AREA_LABELS,
  FITTING_STANDARD_AREAS,
  createFitting,
  deleteFittingFile,
  downloadFittingFile,
  downloadFittingSheet,
  fetchFittingFiles,
  fetchFittings,
  fittingAreaLabel,
  uploadFittingFile,
  type FittingAreaCode,
  type ProductionItem,
} from '../../api/production';
import { Can } from '../../shared/Can';
import { labelOf } from '../../shared/status-meta';

/** 백엔드 CreateFittingDto와 같은 모양 — 보정은 구성품별 {부위, 지시} 배열이다. */
interface AdjustmentRow {
  componentId?: string;
  /** 표준 확인 항목 (개발설계서 05 G-04) */
  areaCode?: FittingAreaCode;
  area: string;
  instruction: string;
}

interface FittingFormValues {
  fittingDate: Dayjs;
  adjustments: AdjustmentRow[];
  notes?: string;
  nextAppointmentDate?: Dayjs;
}

interface FittingModalProps {
  item: ProductionItem;
  open: boolean;
  onClose: () => void;
}

/** 백엔드 `FilesService.ALLOWED_EXTENSIONS`와 같은 목록 (공장 회신은 스캔본·엑셀이 대부분) */
const FITTING_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'xlsx'];
const FITTING_FILE_ACCEPT = FITTING_FILE_EXTENSIONS.map((e) => `.${e}`).join(',');

/**
 * 가봉 세션 첨부 (설계서 v2 06 §5.4) — 공장이 회신한 지시서·마킹본을 세션에 붙여 둔다.
 * 내려받기 지시서(`GET /fittings/:id/sheet`)와는 별개 파일이라 별도 줄로 낸다.
 */
function FittingFiles({ fittingId }: { fittingId: string }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const queryKey = ['production', 'fittings', fittingId, 'files'];

  const filesQuery = useQuery({ queryKey, queryFn: () => fetchFittingFiles(fittingId) });
  const files = filesQuery.data ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadFittingFile(fittingId, file),
    onSuccess: () => {
      message.success('첨부했습니다.');
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '첨부에 실패했습니다.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (fileId: string) => deleteFittingFile(fittingId, fileId),
    onSuccess: () => {
      message.success('첨부를 삭제했습니다.');
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '첨부 삭제에 실패했습니다.'),
  });

  return (
    <Space wrap size={4} style={{ marginTop: 4 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <PaperClipOutlined /> 공장 회신
      </Typography.Text>
      {files.map((f) => (
        <Tag key={f.id} style={{ marginInlineEnd: 0 }}>
          <a onClick={() => void downloadFittingFile(f)}>{f.originalName}</a>
          <Can permission="FITTING_EDIT">
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              loading={deleteMutation.isPending && deleteMutation.variables === f.id}
              onClick={() => deleteMutation.mutate(f.id)}
            />
          </Can>
        </Tag>
      ))}
      {files.length === 0 && !filesQuery.isLoading && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          없음
        </Typography.Text>
      )}
      <Can permission="FITTING_EDIT">
        {/* 자동 업로드를 끄고 직접 올린다(인증 헤더가 필요해 AntD 기본 업로더를 쓸 수 없다). */}
        <Upload
          accept={FITTING_FILE_ACCEPT}
          showUploadList={false}
          beforeUpload={(file: RcFile) => {
            // 백엔드 FilesService와 같은 허용 목록 — 서버 400을 기다리지 않고 여기서 걸러 준다.
            const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
            if (!FITTING_FILE_EXTENSIONS.includes(ext)) {
              message.error(`허용되지 않은 파일 형식입니다. (허용: ${FITTING_FILE_EXTENSIONS.join(', ')})`);
              return Upload.LIST_IGNORE;
            }
            uploadMutation.mutate(file);
            return false;
          }}
        >
          <Button size="small" icon={<UploadOutlined />} loading={uploadMutation.isPending}>
            첨부
          </Button>
        </Upload>
      </Can>
    </Space>
  );
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
        adjustments: (values.adjustments ?? []).map((a) => ({
          componentId: a.componentId,
          areaCode: a.areaCode,
          area: a.area.trim(),
          instruction: a.instruction.trim(),
        })),
        notes: values.notes?.trim() || undefined,
        nextAppointmentDate: values.nextAppointmentDate?.format('YYYY-MM-DD'),
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
        initialValues={{
          fittingDate: dayjs(),
          adjustments: [{ areaCode: 'ETC', area: '', instruction: '' }],
        }}
        onFinish={(values) => saveMutation.mutate(values)}
      >
        <Form.Item
          name="fittingDate"
          label="가봉일"
          rules={[{ required: true, message: '가봉일을 선택해 주세요.' }]}
        >
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="보정 지시" required style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            구성품별로 부위와 지시를 남깁니다. 공장·수선 담당이 그대로 보는 내용입니다.
          </Typography.Text>
        </Form.Item>
        <Form.List name="adjustments">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                  <Form.Item name={[field.name, 'componentId']} style={{ marginBottom: 0, width: 150 }}>
                    <Select
                      allowClear
                      placeholder="구성품(선택)"
                      options={item.components.map((c) => ({
                        value: c.id,
                        label: `${labelOf(COMPONENT_TYPE_LABELS, c.componentType)} #${c.sequenceNo}`,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'areaCode']}
                    style={{ marginBottom: 0, width: 110 }}
                  >
                    <Select
                      placeholder="확인 항목"
                      options={FITTING_AREA_CODES.map((c) => ({
                        value: c,
                        label: FITTING_AREA_LABELS[c],
                      }))}
                    />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'area']}
                    rules={[{ required: true, message: '부위' }]}
                    style={{ marginBottom: 0, width: 130 }}
                  >
                    <Input placeholder="부위 (예: 소매)" />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'instruction']}
                    rules={[{ required: true, message: '지시 내용' }]}
                    style={{ marginBottom: 0, width: 240 }}
                  >
                    <Input placeholder="지시 (예: 1.5cm 줄임)" />
                  </Form.Item>
                  {fields.length > 1 && (
                    <MinusCircleOutlined onClick={() => remove(field.name)} />
                  )}
                </Space>
              ))}
              <Form.Item>
                <Button
                  type="dashed"
                  onClick={() => add({ areaCode: 'ETC', area: '', instruction: '' })}
                  block
                  icon={<PlusOutlined />}
                >
                  보정 항목 추가
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>
        <Form.Item name="notes" label="메모">
          <Input.TextArea rows={2} placeholder="실루엣·균형·여유분 등 전반 메모" />
        </Form.Item>
        <Form.Item name="nextAppointmentDate" label="다음 방문일">
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
                title={
                  <Space wrap>
                    <span>{`${f.fittingDate} · 보정 ${f.adjustments.length}건`}</span>
                    {/* 설계 PDF 1페이지 4대 확인 항목 — 빠진 것만 회색으로 알려준다 */}
                    {FITTING_STANDARD_AREAS.filter((code) => !f.coverage[code]).map((code) => (
                      <Tag key={code}>{FITTING_AREA_LABELS[code]} 미기재</Tag>
                    ))}
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      onClick={() => void downloadFittingSheet(f.id)}
                    >
                      수정지시서
                    </Button>
                  </Space>
                }
                description={
                  <>
                    {f.adjustments.map((a) => (
                      <div key={a.id}>
                        [{fittingAreaLabel(a.areaCode)}] {a.componentLabel} · {a.area}:{' '}
                        {a.instruction}
                      </div>
                    ))}
                    {f.notes && <div>{f.notes}</div>}
                    {f.nextAppointmentDate && (
                      <Typography.Text type="secondary">
                        다음 방문일: {f.nextAppointmentDate}
                      </Typography.Text>
                    )}
                    <FittingFiles fittingId={f.id} />
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
