/** WO-002 작업지시서 미리보기·Excel 출력 — 확정 옵션·연결 채촌 검토, 출력 시 버전 생성 */
import { FileExcelOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Input, Modal, Row, Select, Space, Spin, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  WorkOrderMeasurementValue,
  WorkOrderOptionStage,
  WorkOrderVersionRow,
} from '../../api/workorders';
import {
  fetchWorkOrderPreview,
  fetchWorkOrderVersions,
  issueWorkOrderVersion,
} from '../../api/workorders';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { MEASUREMENT_TYPE_META, WORK_ORDER_STATUS_META } from './wo-meta';

export function WorkOrderPreviewPage() {
  const { orderItemId } = useParams<{ orderItemId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [modal, modalContextHolder] = Modal.useModal();
  const [note, setNote] = useState('');
  /** 미리보기용으로 골라본 채촌 세션. undefined면 품목에 연결된 채촌을 쓴다. */
  const [pickedMeasurementId, setPickedMeasurementId] = useState<string | undefined>(undefined);

  const previewQuery = useQuery({
    queryKey: ['workorders', 'preview', orderItemId, pickedMeasurementId ?? null],
    queryFn: () => fetchWorkOrderPreview(orderItemId ?? '', pickedMeasurementId),
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

  const issueMutation = useMutation({
    mutationFn: () =>
      issueWorkOrderVersion(orderItemId ?? '', {
        measurementSessionId: preview?.measurement?.measurementSessionId,
        note: note.trim() || undefined,
      }),
    onSuccess: (res) => {
      modal.success({
        title: 'Excel 출력 완료',
        content: (
          <Space direction="vertical" size={4}>
            <Typography.Text strong>V{res.versionNo} 버전이 생성되었습니다.</Typography.Text>
            <Typography.Text code>{res.file.fileName}</Typography.Text>
            <Typography.Text type="secondary">출력 시점의 옵션·채촌값이 스냅샷으로 보존됩니다.</Typography.Text>
          </Space>
        ),
        okText: '확인',
        okButtonProps: { size: 'large' },
      });
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['workorders'] });
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

  /**
   * 출력 가능 판정.
   * 백엔드에 optionConfirmed/measurementCompleted 같은 확정 플래그가 없어(docs/dev/08 §4),
   * 미리보기에 실제로 담겨 온 옵션·채촌 존재 여부로만 판정한다.
   * 권위 있는 판정 플래그는 백엔드 확정 후 교체한다.
   */
  const printable = preview.optionStages.length > 0 && !!measurement;

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
  ];

  const measurementSummary = measurement
    ? `V${measurement.versionNo} · ${measurement.measurementDate} · ${metaOf(MEASUREMENT_TYPE_META, measurement.measurementType).label}`
    : '-';

  const openIssueDialog = () => {
    modal.confirm({
      title: '작업지시서 Excel 출력',
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>
            사용 채촌 버전: <Typography.Text strong>{measurementSummary}</Typography.Text>
          </Typography.Text>
          <Typography.Text>비고: {note.trim() || '(없음)'}</Typography.Text>
          <Typography.Text type="secondary">출력 시 새 버전 번호가 생성되고 이전 파일은 보존됩니다.</Typography.Text>
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
          <StatusBadge label={statusMeta.label} color={statusMeta.color} />
        </Space>
        {!printable && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message="정식 출력 조건이 충족되지 않았습니다."
            description={[
              preview.optionStages.length === 0 ? '확정 옵션 없음' : null,
              !measurement ? '연결된 채촌 없음' : null,
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
            title="채촌 (사용 버전)"
            size="small"
            style={{ marginBottom: 16 }}
            extra={
              preview.measurementCandidates.length > 0 ? (
                <Select
                  size="large"
                  style={{ minWidth: 260, height: 44 }}
                  value={measurement?.measurementSessionId}
                  placeholder="채촌 버전 선택"
                  loading={previewQuery.isFetching}
                  onChange={setPickedMeasurementId}
                  options={preview.measurementCandidates.map((c) => ({
                    value: c.measurementSessionId,
                    label: `V${c.versionNo} · ${c.measurementDate} · ${metaOf(MEASUREMENT_TYPE_META, c.measurementType).label}${
                      c.isLinked ? ' (연결됨)' : ''
                    }${c.completed ? '' : ' (작성중)'}`,
                    disabled: !c.completed,
                  }))}
                />
              ) : null
            }
          >
            {measurement && !measurement.isLinked && (
              <Alert
                style={{ marginBottom: 12 }}
                type="info"
                showIcon
                message="품목에 연결된 채촌이 아닌 다른 버전을 미리보는 중입니다. 이 상태로 출력하면 이 버전이 사용됩니다."
              />
            )}
            {measurement ? (
              <Table<WorkOrderMeasurementValue>
                rowKey="key"
                dataSource={measurement.values}
                columns={measurementColumns}
                pagination={false}
                size="small"
              />
            ) : (
              <Alert type="warning" showIcon message="연결된 채촌 버전이 없습니다. 채촌을 먼저 완료해 주세요." />
            )}
          </Card>
        </Col>
      </Row>

      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary">변경 사유·비고 (V2 이상 출력 시 입력 권장)</Typography.Text>
            <Input
              size="large"
              style={{ height: 48 }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="예: 가봉 보정 반영"
            />
          </div>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button size="large" style={{ height: 56, minWidth: 140, fontSize: 18 }} onClick={() => navigate('/work-orders')}>
              목록으로
            </Button>
            <Button
              type="primary"
              size="large"
              style={{ height: 56, minWidth: 220, fontSize: 18 }}
              icon={<FileExcelOutlined />}
              disabled={!printable}
              loading={issueMutation.isPending}
              onClick={openIssueDialog}
            >
              Excel 출력
            </Button>
          </Space>
        </Space>
      </Card>

      <Card title="출력 이력" size="small">
        {workOrderId ? (
          <Table<WorkOrderVersionRow>
            rowKey="id"
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
    </Space>
  );
}
