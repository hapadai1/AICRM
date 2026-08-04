/** WO-002 작업지시서 미리보기·Excel 출력 — 확정 옵션·연결 채촌 검토, 출력 시 버전 생성 */
import { DownloadOutlined, EyeOutlined, FileExcelOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Input, Modal, Row, Space, Spin, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  WorkOrderMeasurementValue,
  WorkOrderOptionStage,
  WorkOrderVersionRow,
} from '../../api/workorders';
import {
  downloadWorkOrderVersionFile,
  fetchWorkOrderPreview,
  fetchWorkOrderVersions,
  issueWorkOrderVersion,
} from '../../api/workorders';
import { BackButton } from '../../shared/BackButton';
import { MeasurementPickerModal } from './MeasurementPickerModal';
import { WorkOrderFormPreviewModal } from './WorkOrderFormPreviewModal';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { MEASUREMENT_TYPE_META, WORK_ORDER_STATUS_META } from './wo-meta';

export function WorkOrderPreviewPage() {
  const { orderItemId } = useParams<{ orderItemId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [modal, modalContextHolder] = Modal.useModal();
  const [note, setNote] = useState('');
  /** 채촌 선택 팝업 열림 여부 — 고른 채촌은 품목 연결로 바로 확정된다. */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 양식 미리보기 대상 — 'draft'는 출력 전 현재 값, 그 외는 저장된 버전 id */
  const [formPreviewTarget, setFormPreviewTarget] = useState<'draft' | string | null>(null);

  const previewQuery = useQuery({
    queryKey: ['workorders', 'preview', orderItemId],
    queryFn: () => fetchWorkOrderPreview(orderItemId ?? ''),
    enabled: !!orderItemId,
    placeholderData: (prev) => prev,
  });
  const preview = previewQuery.data;
  const workOrderId = preview?.workOrderId;

  const versionsQuery = useQuery({
    queryKey: ['workorders', 'versions', workOrderId],
    queryFn: () => fetchWorkOrderVersions(workOrderId ?? ''),
    enabled: !!workOrderId,
  });

  /** 이미 만들어진 파일을 그대로 받는다 — 새 버전이 생기지 않는다. */
  const downloadMutation = useMutation({
    mutationFn: (v: { versionId: string; fileName: string }) =>
      downloadWorkOrderVersionFile(v.versionId, v.fileName),
    onError: (e: Error) => message.error(`파일을 내려받지 못했습니다: ${e.message}`),
  });

  const issueMutation = useMutation({
    mutationFn: () =>
      issueWorkOrderVersion(orderItemId ?? '', {
        measurementSessionId: preview?.measurement?.measurementSessionId,
        note: note.trim() || undefined,
      }),
    onSuccess: async (res) => {
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['workorders'] });
      void queryClient.invalidateQueries({ queryKey: ['production'] });
      // 출력 = 버전 생성 + 파일 내려받기. 실패해도 버전은 남으므로 이력에서 다시 받을 수 있다.
      try {
        await downloadWorkOrderVersionFile(res.workOrderVersionId, res.file.fileName);
      } catch {
        message.warning('버전은 생성됐지만 자동 내려받기에 실패했습니다. 출력 이력에서 내려받아 주세요.');
      }
      modal.success({
        title: 'Excel 출력 완료',
        content: (
          <Space direction="vertical" size={4}>
            <Typography.Text strong>V{res.versionNo} 버전이 생성되었습니다.</Typography.Text>
            <Typography.Text code>{res.file.fileName}</Typography.Text>
            <Typography.Text type="secondary">
              파일이 내려받기 폴더에 저장됩니다. 출력 시점의 옵션·채촌값은 스냅샷으로 보존됩니다.
            </Typography.Text>
          </Space>
        ),
        okText: '확인',
        okButtonProps: { size: 'large' },
      });
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (previewQuery.isLoading) return <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />;
  if (previewQuery.error || !preview) {
    return (
      <Alert
        type="error"
        showIcon
        message="작업지시서 미리보기를 불러오지 못했습니다."
        description={(previewQuery.error as Error | null)?.message}
        action={
          <Button size="large" onClick={() => navigate('/work-orders')}>
            목록으로
          </Button>
        }
      />
    );
  }

  const statusMeta = metaOf(WORK_ORDER_STATUS_META, preview.status);
  const measurement = preview.measurement;

  // 출력 가능 판정 — 백엔드가 옵션 확정·채촌 완료를 종합해 내려준다 (docs/dev/08 §4).
  const printable = preview.printable;

  const optionColumns: ColumnsType<WorkOrderOptionStage> = [
    { title: '순번', dataIndex: 'sequenceNo', key: 'sequenceNo', width: 64 },
    { title: '단계명', dataIndex: 'stageName', key: 'stageName' },
    {
      title: '선택 옵션',
      dataIndex: 'choiceName',
      key: 'choiceName',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
  ];

  const measurementColumns: ColumnsType<WorkOrderMeasurementValue> = [
    { title: '항목', dataIndex: 'label', key: 'label' },
    {
      title: '값',
      dataIndex: 'display',
      key: 'display',
      render: (display: string) =>
        display ? (
          <Typography.Text strong>{display}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
  ];

  const versionColumns: ColumnsType<WorkOrderVersionRow> = [
    { title: '버전', dataIndex: 'versionNo', key: 'versionNo', width: 72, render: (v: number) => `V${v}` },
    { title: '출력일시', dataIndex: 'issuedAt', key: 'issuedAt', width: 160 },
    // 백엔드는 issuedBy를 {id, displayName} 객체로 보내므로 매퍼가 편 이름을 쓴다.
    { title: '출력자', dataIndex: 'issuedByName', key: 'issuedByName', width: 110 },
    {
      title: '파일명',
      dataIndex: 'fileName',
      key: 'fileName',
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    {
      title: '변경 사유·비고',
      dataIndex: 'changeReason',
      key: 'changeReason',
      render: (v?: string) => v ?? <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '파일',
      key: 'download',
      width: 200,
      render: (_: unknown, row: WorkOrderVersionRow) => (
        <Space size={6}>
          <Button size="large" icon={<EyeOutlined />} onClick={() => setFormPreviewTarget(row.id)}>
            보기
          </Button>
          <Button
            size="large"
            icon={<DownloadOutlined />}
            loading={downloadMutation.isPending && downloadMutation.variables?.versionId === row.id}
            onClick={() => downloadMutation.mutate({ versionId: row.id, fileName: row.fileName })}
          >
            받기
          </Button>
        </Space>
      ),
    },
  ];

  // 최신 출력본 — 재출력(새 버전) 없이 그대로 다시 받으려는 경우에 쓴다.
  const versions = versionsQuery.data ?? [];
  const latestVersion =
    versions.find((v) => v.id === preview.currentVersionId) ?? versions[0] ?? undefined;

  const measurementSummary = measurement
    ? `${metaOf(MEASUREMENT_TYPE_META, measurement.measurementType).label} · ${measurement.measurementDate}`
    : '-';

  const openIssueDialog = () => {
    modal.confirm({
      title: '작업지시서 Excel 출력',
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>
            사용 채촌: <Typography.Text strong>{measurementSummary}</Typography.Text>
          </Typography.Text>
          <Typography.Text>비고: {note.trim() || '(없음)'}</Typography.Text>
          <Typography.Text type="secondary">
            출력 시 새 버전 번호가 생성되고 Excel 파일이 바로 내려받아집니다. 이전 파일은 보존됩니다.
          </Typography.Text>
          {latestVersion && (
            <Typography.Text type="secondary">
              같은 내용을 다시 받기만 하려면 [최신본 받기]를 쓰세요 (버전이 늘지 않습니다).
            </Typography.Text>
          )}
        </Space>
      ),
      okText: '출력',
      cancelText: '취소',
      okButtonProps: { size: 'large' },
      cancelButtonProps: { size: 'large' },
      onOk: () => issueMutation.mutateAsync(),
    });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {modalContextHolder}
      <Card>
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              작업지시서 — {preview.customerName} · {preview.itemLabel}
            </Typography.Title>
            <Typography.Text type="secondary">
              {preview.orderNo} · 원단: {preview.fabricName ?? '미입력'}
              {preview.optionVersionNo ? ` · 옵션 V${preview.optionVersionNo}` : ''}
              {preview.currentVersionNo ? ` · 최신 출력 V${preview.currentVersionNo}` : ''}
            </Typography.Text>
          </div>
          {/* 기능 버튼은 화면 우상단 한 곳에 모은다 (계약서 작성·렌탈 선택 화면과 동일 규칙). */}
          <Space wrap>
            <StatusBadge label={statusMeta.label} color={statusMeta.color} />
            <Button
              icon={<EyeOutlined />}
              disabled={!printable}
              onClick={() => setFormPreviewTarget('draft')}
            >
              양식 미리보기
            </Button>
            {latestVersion && (
              <Button
                icon={<DownloadOutlined />}
                loading={
                  downloadMutation.isPending &&
                  downloadMutation.variables?.versionId === latestVersion.id
                }
                onClick={() =>
                  downloadMutation.mutate({
                    versionId: latestVersion.id,
                    fileName: latestVersion.fileName,
                  })
                }
              >
                최신본 받기 (V{latestVersion.versionNo})
              </Button>
            )}
            <Button
              type="primary"
              icon={<FileExcelOutlined />}
              disabled={!printable}
              loading={issueMutation.isPending}
              onClick={openIssueDialog}
            >
              Excel 출력
            </Button>
          </Space>
        </Space>
        {/* 출력 시 기록할 사유 — 누르는 버튼([Excel 출력])과 같은 카드에 둔다. */}
        <div style={{ marginTop: 12, maxWidth: 520 }}>
          <Typography.Text type="secondary">변경 사유·비고 (V2 이상 출력 시 입력 권장)</Typography.Text>
          <Input
            size="large"
            style={{ height: 48 }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="예: 가봉 보정 반영"
          />
        </div>
        {!printable && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message="정식 출력 조건이 충족되지 않았습니다."
            description={[
              !preview.optionConfirmed ? '옵션 미확정' : null,
              !preview.measurementCompleted ? '채촌 미완료' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        )}
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card title="옵션 (확정 선택값)" size="small" style={{ marginBottom: 16 }}>
            <Table<WorkOrderOptionStage>
              rowKey="key"
              scroll={{ x: 'max-content' }}
              dataSource={preview.optionStages}
              columns={optionColumns}
              pagination={false}
              size="middle"
              locale={{ emptyText: '확정된 옵션이 없습니다.' }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            title="채촌 (사용 기록)"
            size="small"
            style={{ marginBottom: 16 }}
            extra={
              preview.canChangeMeasurement && preview.measurementCandidates.length > 0 ? (
                <Button
                  size="large"
                  icon={<SearchOutlined />}
                  loading={previewQuery.isFetching}
                  onClick={() => setPickerOpen(true)}
                >
                  채촌 변경
                </Button>
              ) : null
            }
          >
            <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
              <Space size={8} wrap>
                <Typography.Text type="secondary">사용 채촌</Typography.Text>
                <Typography.Text strong style={{ fontSize: 16 }}>
                  {measurementSummary}
                </Typography.Text>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {preview.measurementAutoSelected
                  ? '가장 최근 완료 채촌을 자동으로 골랐습니다. 출력하면 이 채촌으로 확정됩니다.'
                  : preview.canChangeMeasurement
                    ? '이 품목에 확정된 채촌입니다.'
                    : '작업요청이 끝나 채촌이 확정되었습니다.'}
              </Typography.Text>
            </Space>
            {measurement ? (
              <Table<WorkOrderMeasurementValue>
                rowKey="key"
                scroll={{ x: 'max-content' }}
                dataSource={measurement.values}
                columns={measurementColumns}
                pagination={false}
                size="small"
              />
            ) : (
              <Alert type="warning" showIcon message="연결된 채촌이 없습니다. 채촌을 먼저 완료해 주세요." />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="출력 이력" size="small">
        {workOrderId ? (
          <Table<WorkOrderVersionRow>
            rowKey="id"
            scroll={{ x: 'max-content' }}
            dataSource={versionsQuery.data ?? []}
            columns={versionColumns}
            pagination={false}
            size="middle"
            loading={versionsQuery.isLoading}
            locale={{ emptyText: '출력 이력이 없습니다.' }}
          />
        ) : (
          <Typography.Text type="secondary">출력 이력이 없습니다. 첫 출력 시 V1이 생성됩니다.</Typography.Text>
        )}
      </Card>

      {/* 하단은 페이지 이동 전용 — 출력 버튼들은 위 헤더 액션바에 있다. */}
      <Card>
        <BackButton />
      </Card>

      {/* 채촌 변경 — 이 고객의 채촌만 띄워 고르고, 고른 즉시 품목 연결로 확정한다. */}
      <MeasurementPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        orderItemId={orderItemId ?? ''}
        customerId={preview.customerId}
        customerName={preview.customerName}
        currentSessionId={measurement?.measurementSessionId}
        onPicked={() => void previewQuery.refetch()}
      />

      <WorkOrderFormPreviewModal
        open={formPreviewTarget != null}
        onClose={() => setFormPreviewTarget(null)}
        orderItemId={formPreviewTarget === 'draft' ? orderItemId : undefined}
        measurementSessionId={
          formPreviewTarget === 'draft' ? measurement?.measurementSessionId : undefined
        }
        versionId={formPreviewTarget && formPreviewTarget !== 'draft' ? formPreviewTarget : undefined}
        title={
          formPreviewTarget === 'draft'
            ? `작업지시서 양식 미리보기 — ${preview.customerName} · ${preview.itemLabel}`
            : '저장된 출력본 보기'
        }
        downloading={downloadMutation.isPending}
        onDownload={
          // 출력 전 초안은 아직 파일이 없어 내려받을 수 없다(먼저 [Excel 출력]).
          formPreviewTarget && formPreviewTarget !== 'draft'
            ? () => {
                const row = versions.find((v) => v.id === formPreviewTarget);
                if (row) downloadMutation.mutate({ versionId: row.id, fileName: row.fileName });
              }
            : undefined
        }
      />
    </Space>
  );
}
