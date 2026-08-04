/**
 * FIT-001 가봉·피팅 기록.
 *
 * 관리하는 것은 셋뿐이다 — **가봉일 · 엑셀 · 메모** (2026-08-04 현업 확정).
 * 예전에는 구성품별 보정 지시(부위·지시)를 줄 단위로 받았는데, 실제로는 공장이 쓰는 양식
 * 엑셀을 그대로 주고받으므로 화면에서 다시 옮겨 적을 이유가 없었다(입력칸 네 개가
 * 모달 폭을 넘기기도 했다). 기존 기록의 보정 내용은 이력에서 그대로 볼 수 있다.
 */
import {
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileExcelOutlined,
  PaperClipOutlined,
  SendOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { RcFile } from 'antd/es/upload';
import dayjs, { type Dayjs } from 'dayjs';
import { ApiError } from '../../api/client';
import {
  createFitting,
  deleteFittingFile,
  downloadFittingFile,
  downloadFittingSheet,
  fetchFittingFiles,
  fetchFittings,
  uploadFittingFile,
  type ProductionItem,
} from '../../api/production';
import { downloadWorkOrderVersionFile } from '../../api/workorders';
import { Can } from '../../shared/Can';

interface FittingFormValues {
  fittingDate: Dayjs;
  notes?: string;
}

interface FittingModalProps {
  item: ProductionItem;
  open: boolean;
  onClose: () => void;
  /** [완성복 발주] — 가봉 피팅 단계를 이 품목에 대해 끝낸다. 잠겨 있으면 사유가 온다 */
  onRequestFinal?: () => void;
  requestFinalBlocked?: string | null;
  /** [보기] — 작업지시서 양식 미리보기 */
  onPreviewForm?: () => void;
}

/** 백엔드 `FilesService.ALLOWED_EXTENSIONS`와 같은 목록 (공장 발송본은 엑셀·스캔본이 대부분) */
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
        <PaperClipOutlined /> 엑셀·첨부
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
            엑셀 업로드
          </Button>
        </Upload>
      </Can>
    </Space>
  );
}

export function FittingModal({
  item,
  open,
  onClose,
  onRequestFinal,
  requestFinalBlocked,
  onPreviewForm,
}: FittingModalProps) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FittingFormValues>();

  const fittingsQuery = useQuery({
    queryKey: ['production', item.orderItemId, 'fittings'],
    queryFn: () => fetchFittings(item.orderItemId),
    enabled: open,
  });
  const fittings = fittingsQuery.data ?? [];
  // 첨부·수정지시서는 저장된 기록에 붙는다 — 가장 최근 기록이 그 대상이다.
  const latest = fittings[0] ?? null;

  const saveMutation = useMutation({
    mutationFn: (values: FittingFormValues) =>
      createFitting(item.orderItemId, {
        fittingDate: values.fittingDate.format('YYYY-MM-DD'),
        // 보정 지시는 더 이상 화면에서 받지 않는다 — 공장 양식 엑셀을 그대로 주고받는다.
        adjustments: [],
        notes: values.notes?.trim() || undefined,
      }),
    onSuccess: () => {
      message.success('가봉 기록이 저장되었습니다.');
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['production'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '가봉 기록 저장에 실패했습니다.'),
  });

  const wo = item.workOrder;

  return (
    <Modal
      title={`가봉·피팅 — ${item.customerName} · ${item.displayName}`}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="기록 저장"
      cancelText="닫기"
      confirmLoading={saveMutation.isPending}
      width={640}
      destroyOnClose
    >
      {/* 가봉이 끝난 품목을 완성복 제작으로 넘기고, 공장에 보낼 서류를 여기서 함께 처리한다. */}
      <Space size={6} wrap style={{ marginBottom: 12 }}>
        <Can permission="JOURNEY_EDIT">
          <Tooltip title={requestFinalBlocked ?? '가봉이 끝난 이 품목을 완성복 제작으로 넘깁니다.'}>
            <Button
              type="primary"
              ghost
              icon={<SendOutlined />}
              disabled={!!requestFinalBlocked || !onRequestFinal}
              onClick={() => {
                onRequestFinal?.();
                onClose();
              }}
            >
              완성복 발주
            </Button>
          </Tooltip>
        </Can>
        <Tooltip title={latest ? '' : '가봉 기록을 저장하면 만들 수 있습니다.'}>
          <Button
            icon={<FileExcelOutlined />}
            disabled={!latest}
            onClick={() => latest && void downloadFittingSheet(latest.id)}
          >
            가봉 작업지시서
          </Button>
        </Tooltip>
        <Button icon={<EyeOutlined />} disabled={!wo.canIssue} onClick={() => onPreviewForm?.()}>
          보기
        </Button>
        <Tooltip title={wo.currentVersionId ? `최신 출력본 V${wo.currentVersionNo}` : '출력본이 없습니다.'}>
          <Button
            icon={<DownloadOutlined />}
            disabled={!wo.currentVersionId || !wo.currentFileName}
            onClick={() =>
              void downloadWorkOrderVersionFile(
                wo.currentVersionId as string,
                wo.currentFileName as string,
              )
            }
          >
            엑셀 다운로드
          </Button>
        </Tooltip>
      </Space>

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
        <Form.Item name="notes" label="메모">
          <Input.TextArea rows={2} placeholder="실루엣·균형·여유분 등 전반 메모" />
        </Form.Item>
      </Form>

      {!latest && (
        <Alert
          type="info"
          showIcon
          message="엑셀은 가봉일을 저장한 뒤 그 기록에 첨부합니다."
          style={{ marginBottom: 8 }}
        />
      )}

      <Typography.Title level={5} style={{ marginTop: 8 }}>
        가봉 이력
      </Typography.Title>
      {fittings.length > 0 ? (
        <List
          size="small"
          loading={fittingsQuery.isLoading}
          dataSource={fittings}
          renderItem={(f) => (
            <List.Item>
              <List.Item.Meta
                title={f.fittingDate}
                description={
                  <>
                    {f.notes && <div>{f.notes}</div>}
                    {/* 예전 기록의 보정 지시 — 지금은 입력하지 않지만 남아 있으면 보여 준다. */}
                    {f.adjustments.length > 0 && (
                      <Typography.Text type="secondary">
                        보정 {f.adjustments.length}건
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
