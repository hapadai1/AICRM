/**
 * 완성복 발주 — 가봉을 확인하고 낸다 (2026-08-05 현업 확정).
 *
 * 제작 발주 창(OrderRequestModal)과 **같은 틀**이다: 위에서 준비된 것을 확인하고, 아래 오른쪽
 * [완성복 발주하기]로 낸다. 두 발주가 같은 일이라 담당자가 창마다 다시 배울 것이 없어야 한다.
 *
 * 가봉에서 관리하는 것은 셋뿐이다 — **가봉일 · 엑셀 · 메모** (2026-08-04 현업 확정).
 * 구성품별 보정 지시를 줄로 받던 것은 걷어냈다. 공장이 쓰는 양식 엑셀을 그대로 주고받으므로
 * 화면에서 다시 옮겨 적을 이유가 없다. 옛 기록의 보정 내용은 이력에 남아 그대로 보인다.
 *
 * 미리보기는 두지 않는다 (현업 확정 2026-08-05) — 가봉 시트는 Excel로만 만든다.
 */
import {
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileExcelOutlined,
  PaperClipOutlined,
  SaveOutlined,
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
import { ApiError, openFileInNewTab } from '../../api/client';
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
import { Can } from '../../shared/Can';
import { PrepRow } from './PrepRow';

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

/**
 * 최종 가봉 지시서 한 줄 — 제작 발주 창의 `최종 작업지시서` 줄과 같은 모양이다 (2026-08-05).
 * 가장 최근에 올린 파일이 최종본이다. 예전 것들은 아래 가봉 이력에 그대로 남는다.
 */
function FinalFittingSheetRow({ fittingId }: { fittingId: string }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const queryKey = ['production', 'fittings', fittingId, 'files'];

  const filesQuery = useQuery({ queryKey, queryFn: () => fetchFittingFiles(fittingId) });
  const latestFile = (filesQuery.data ?? [])[0] ?? null;
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadFittingFile(fittingId, file),
    onSuccess: () => {
      message.success('최종본을 올렸습니다.');
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '업로드에 실패했습니다.'),
  });

  const removeMutation = useMutation({
    mutationFn: (fileId: string) => deleteFittingFile(fittingId, fileId),
    onSuccess: () => {
      message.success('최종본을 내렸습니다.');
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '내리지 못했습니다.'),
  });

  return (
    <>
      <Typography.Text type={latestFile ? undefined : 'secondary'} style={{ flex: 1, minWidth: 0 }}>
        {latestFile?.originalName ?? '올린 파일 없음 — 시스템 지시서가 최종입니다'}
      </Typography.Text>
      <Space size={6} wrap>
        {/* 올린 파일은 우리가 만든 워크북이 아니라 창 안에 그릴 수 없다 — 새 탭에서 연다. */}
        <Button
          icon={<EyeOutlined />}
          disabled={!latestFile}
          onClick={() => latestFile && void openFileInNewTab(`/files/${latestFile.id}`)}
        >
          보기
        </Button>
        <Can permission="FITTING_EDIT">
          <Upload
            accept={FITTING_FILE_ACCEPT}
            showUploadList={false}
            beforeUpload={(file: RcFile) => {
              const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
              if (!FITTING_FILE_EXTENSIONS.includes(ext)) {
                message.error(`허용되지 않은 파일 형식입니다. (허용: ${FITTING_FILE_EXTENSIONS.join(', ')})`);
                return Upload.LIST_IGNORE;
              }
              uploadMutation.mutate(file);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={uploadMutation.isPending}>
              {latestFile ? '교체' : '업로드'}
            </Button>
          </Upload>
        </Can>
        <Button
          icon={<DownloadOutlined />}
          disabled={!latestFile}
          onClick={() => latestFile && void downloadFittingFile(latestFile)}
        >
          다운로드
        </Button>
        <Can permission="FITTING_EDIT">
          <Button
            icon={<DeleteOutlined />}
            disabled={!latestFile}
            loading={removeMutation.isPending}
            onClick={() => latestFile && removeMutation.mutate(latestFile.id)}
          >
            내리기
          </Button>
        </Can>
      </Space>
    </>
  );
}

export function FittingModal({
  item,
  open,
  onClose,
  onRequestFinal,
  requestFinalBlocked,
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

  return (
    <Modal
      title={
        <Space size={8}>
          <span>완성복 발주</span>
          <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
            {item.customerName} · {item.displayName}
          </Typography.Text>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={720}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>닫기</Button>
          <Can permission="JOURNEY_EDIT">
            <Tooltip title={requestFinalBlocked ?? ''}>
              <Button
                type="primary"
                icon={<SendOutlined />}
                disabled={!!requestFinalBlocked || !onRequestFinal}
                onClick={() => {
                  onRequestFinal?.();
                  onClose();
                }}
              >
                완성복 발주하기
              </Button>
            </Tooltip>
          </Can>
        </Space>
      }
    >
      {/* 무엇이 준비됐는지 — 제작 발주 창과 같은 줄 모양을 쓴다. */}
      <PrepRow
        label="가봉"
        done={!!latest}
        detail={
          latest ? (
            <Typography.Text type="secondary">
              {latest.fittingDate}
              {latest.notes ? ` · ${latest.notes}` : ''}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">가봉일을 먼저 기록해 주세요.</Typography.Text>
          )
        }
      />

      {/*
        서류 두 줄 — 제작 발주 창과 같은 모양이다 (2026-08-05 현업 확정).
        위는 시스템이 만드는 가봉 지시서, 아래는 손으로 고쳐 공장에 보낸 최종본이다.
      */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: '1px solid #f0f0f0',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Typography.Text strong>가봉 지시서</Typography.Text>
        <Typography.Text type="secondary" style={{ flex: 1 }}>
          {latest ? '가봉 기록으로 만듭니다' : '가봉일을 저장하면 만들 수 있습니다'}
        </Typography.Text>
        <Tooltip title={latest ? '' : '가봉 기록을 저장하면 만들 수 있습니다.'}>
          <Button
            icon={<FileExcelOutlined />}
            disabled={!latest}
            onClick={() => latest && void downloadFittingSheet(latest.id)}
          >
            출력
          </Button>
        </Tooltip>
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: '1px solid #f5f5f5',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Typography.Text strong>최종 가봉 지시서</Typography.Text>
        {latest ? (
          <FinalFittingSheetRow fittingId={latest.id} />
        ) : (
          <Typography.Text type="secondary" style={{ flex: 1 }}>
            가봉 기록을 저장한 뒤 올릴 수 있습니다
          </Typography.Text>
        )}
      </div>

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
        {/* 기록 저장은 창의 주 동작이 아니다 — 주 동작은 아래 [완성복 발주하기]다. */}
        <Button icon={<SaveOutlined />} loading={saveMutation.isPending} onClick={() => form.submit()}>
          가봉 기록 저장
        </Button>
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
