/** 계약 1:1 스타일 컨설팅 화면 — 계약의 전 맞춤 품목을 한 리스트로: 원단 입력·옵션 선택 (보조: 가격표·동일 적용) */
import {
  ArrowLeftOutlined,
  CopyOutlined,
  EyeOutlined,
  FilePdfOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  RightCircleOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Dropdown,
  Input,
  Modal,
  Progress,
  Radio,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchContract } from '../../api/contracts';
import type { OptionProgressItem } from '../../api/options';
import { copyOptionSession, fetchOptionProgress, startOptionSession } from '../../api/options';
import { PdfViewerModal } from '../../shared/PdfViewerModal';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { OPTION_STATUS_META } from './option-meta';

/** 원단 가격표(플레이스홀더). 실제 문서 URL로 교체 가능. */
const FABRIC_PRICE_PDF = '/sample-fabric-price.pdf';

export function ContractOptionsPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const { data: contract } = useQuery({
    queryKey: ['contracts', id],
    queryFn: () => fetchContract(id),
    enabled: !!id,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['options', 'progress', id],
    queryFn: () => fetchOptionProgress(id),
    enabled: !!id,
  });

  // 원단 인라인 입력 초안 (orderItemId → 원단명)
  const [fabricDraft, setFabricDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    setFabricDraft((prev) => {
      const next = { ...prev };
      for (const row of data) if (!(row.orderItemId in next)) next[row.orderItemId] = row.fabric ?? '';
      return next;
    });
  }, [data]);

  const [pdfOpen, setPdfOpen] = useState(false);
  const [copySource, setCopySource] = useState<OptionProgressItem | null>(null);
  const [copyTargetId, setCopyTargetId] = useState<string | null>(null);

  const fabricMutation = useMutation({
    mutationFn: ({ orderItemId, fabric }: { orderItemId: string; fabric: string }) =>
      startOptionSession(orderItemId, fabric),
    onSuccess: () => {
      message.success('원단을 저장했습니다.');
      void queryClient.invalidateQueries({ queryKey: ['options'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const copyMutation = useMutation({
    mutationFn: ({ sessionId, targetId }: { sessionId: string; targetId: string }) =>
      copyOptionSession(sessionId, targetId),
    onSuccess: () => {
      message.success('동일 옵션을 적용했습니다. 대상 품목에서 개별 수정이 가능합니다.');
      setCopySource(null);
      setCopyTargetId(null);
      void queryClient.invalidateQueries({ queryKey: ['options'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const copyTargets = (source: OptionProgressItem | null): OptionProgressItem[] =>
    (data ?? []).filter(
      (row) =>
        source &&
        row.orderItemId !== source.orderItemId &&
        row.productCategory === source.productCategory &&
        row.status !== 'CONFIRMED',
    );

  const columns: ColumnsType<OptionProgressItem> = [
    {
      title: '품목',
      key: 'item',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong style={{ fontSize: 15 }}>
            {row.displayName}
          </Typography.Text>
          <Typography.Text type="secondary">{row.orderNo}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '원단',
      key: 'fabric',
      width: 320,
      render: (_, row) => {
        const draft = fabricDraft[row.orderItemId] ?? '';
        // 별도 저장 버튼 없이 포커스 아웃/엔터 시 자동 저장 (변경분·비어있지 않을 때만)
        const save = () => {
          if (draft.trim() && draft.trim() !== (row.fabric ?? ''))
            fabricMutation.mutate({ orderItemId: row.orderItemId, fabric: draft.trim() });
        };
        return (
          <Input
            placeholder="원단명 입력 (예: 캐노니코 네이비 트윌)"
            value={draft}
            onChange={(e) => setFabricDraft((prev) => ({ ...prev, [row.orderItemId]: e.target.value }))}
            onBlur={save}
            onPressEnter={save}
          />
        );
      },
    },
    {
      title: '진행상태',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: OptionProgressItem['status']) => (
        <StatusBadge
          label={metaOf(OPTION_STATUS_META, status).label}
          color={metaOf(OPTION_STATUS_META, status).color}
        />
      ),
    },
    {
      title: '진행률',
      key: 'progress',
      width: 190,
      render: (_, row) => (
        <Space>
          <Progress
            percent={row.totalStages ? Math.round((row.completedStages / row.totalStages) * 100) : 0}
            size="small"
            style={{ width: 90 }}
            showInfo={false}
          />
          <Typography.Text>
            {row.completedStages}/{row.totalStages} 단계
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '옵션',
      key: 'optionAction',
      width: 150,
      render: (_, row) => {
        if (row.status === 'NOT_STARTED')
          return (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={() => navigate(`/options/${row.orderItemId}`)}
            >
              옵션 선택
            </Button>
          );
        if (row.status === 'IN_PROGRESS')
          return (
            <Button
              type="primary"
              icon={<RightCircleOutlined />}
              onClick={() => navigate(`/options/${row.orderItemId}`)}
            >
              옵션 선택
            </Button>
          );
        return (
          <Button icon={<EyeOutlined />} onClick={() => navigate(`/options/${row.orderItemId}/review`)}>
            옵션 보기
          </Button>
        );
      },
    },
    {
      title: '',
      key: 'more',
      width: 56,
      render: (_, row) => {
        const canCopy = !!row.sessionId && copyTargets(row).length > 0;
        return (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'copy',
                  icon: <CopyOutlined />,
                  label: '동일 옵션 적용',
                  disabled: !canCopy,
                  onClick: () => setCopySource(row),
                },
              ],
            }}
          >
            <Button type="text" icon={<MoreOutlined />} />
          </Dropdown>
        );
      },
    },
  ];

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="스타일 컨설팅 목록을 불러오지 못했습니다."
        description={(error as Error).message}
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/contracts/${id}`)}>
          계약으로
        </Button>
        <Button icon={<FilePdfOutlined />} onClick={() => setPdfOpen(true)}>
          원단 가격표
        </Button>
      </div>

      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={4} style={{ marginBottom: 4 }}>
              스타일 컨설팅 — {contract?.customerName ?? ''}
            </Typography.Title>
            <Typography.Text type="secondary">
              {[contract?.customerPhone, contract?.contractNo].filter(Boolean).join(' · ')}
            </Typography.Text>
          </div>
          {isLoading ? (
            <Spin style={{ display: 'block', margin: '48px auto' }} />
          ) : (
            <Table<OptionProgressItem>
              rowKey="orderItemId"
              scroll={{ x: 'max-content' }}
              dataSource={data ?? []}
              columns={columns}
              pagination={false}
              locale={{ emptyText: '이 계약에는 맞춤 품목이 없습니다.' }}
            />
          )}
        </Space>
      </Card>

      <PdfViewerModal
        open={pdfOpen}
        url={FABRIC_PRICE_PDF}
        title="원단 가격표"
        onClose={() => setPdfOpen(false)}
      />

      <Modal
        title={`동일 옵션 적용 — ${copySource?.displayName ?? ''}`}
        open={!!copySource}
        onCancel={() => {
          setCopySource(null);
          setCopyTargetId(null);
        }}
        okText="적용"
        cancelText="취소"
        okButtonProps={{ disabled: !copyTargetId, loading: copyMutation.isPending }}
        onOk={() => {
          if (copySource?.sessionId && copyTargetId)
            copyMutation.mutate({ sessionId: copySource.sessionId, targetId: copyTargetId });
        }}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text>
            선택값을 복사할 동일 대분류 품목을 선택하세요. 적용 후 개별 수정이 가능합니다.
          </Typography.Text>
          <Radio.Group
            value={copyTargetId}
            onChange={(e) => setCopyTargetId(e.target.value as string)}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {copyTargets(copySource).map((t) => (
              <Radio key={t.orderItemId} value={t.orderItemId} style={{ minHeight: 40, alignItems: 'center' }}>
                <Space>
                  <Typography.Text strong>{t.displayName}</Typography.Text>
                  <Typography.Text type="secondary">{t.orderNo}</Typography.Text>
                  <StatusBadge
                    label={metaOf(OPTION_STATUS_META, t.status).label}
                    color={metaOf(OPTION_STATUS_META, t.status).color}
                  />
                </Space>
              </Radio>
            ))}
          </Radio.Group>
        </Space>
      </Modal>
    </Space>
  );
}
