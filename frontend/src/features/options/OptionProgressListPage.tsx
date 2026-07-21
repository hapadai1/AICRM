/** OPT-001 품목별 옵션 진행 목록 */
import { CopyOutlined, EyeOutlined, PlayCircleOutlined, RightCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Modal, Progress, Radio, Space, Spin, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OptionProgressItem } from '../../api/options';
import { copyOptionSession, fetchOptionProgress } from '../../api/options';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { OPTION_STATUS_META } from './option-meta';

export function OptionProgressListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [copySource, setCopySource] = useState<OptionProgressItem | null>(null);
  const [copyTargetId, setCopyTargetId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['options', 'progress'],
    queryFn: fetchOptionProgress,
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
          <Typography.Text strong style={{ fontSize: 16 }}>
            {row.displayName}
          </Typography.Text>
          <Typography.Text type="secondary">
            {row.customerName} · {row.orderNo}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '원단',
      dataIndex: 'fabric',
      key: 'fabric',
      render: (fabric: string | null) => fabric ?? <Typography.Text type="secondary">미입력</Typography.Text>,
    },
    {
      title: '진행상태',
      dataIndex: 'status',
      key: 'status',
      width: 120,
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
      width: 220,
      render: (_, row) => (
        <Space>
          <Progress
            percent={Math.round((row.completedStages / row.totalStages) * 100)}
            size="small"
            style={{ width: 120 }}
            showInfo={false}
          />
          <Typography.Text>
            {row.completedStages}/{row.totalStages} 단계
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '액션',
      key: 'actions',
      width: 320,
      render: (_, row) => (
        <Space wrap>
          {row.status === 'NOT_STARTED' && (
            <Button
              type="primary"
              size="large"
              icon={<PlayCircleOutlined />}
              onClick={() => navigate(`/options/${row.orderItemId}`)}
            >
              선택 시작
            </Button>
          )}
          {row.status === 'IN_PROGRESS' && (
            <Button
              type="primary"
              size="large"
              icon={<RightCircleOutlined />}
              onClick={() => navigate(`/options/${row.orderItemId}`)}
            >
              계속
            </Button>
          )}
          {(row.status === 'REVIEW' || row.status === 'CONFIRMED') && (
            <Button
              size="large"
              icon={<EyeOutlined />}
              onClick={() => navigate(`/options/${row.orderItemId}/review`)}
            >
              옵션 보기
            </Button>
          )}
          {row.sessionId && copyTargets(row).length > 0 && (
            <Button size="large" icon={<CopyOutlined />} onClick={() => setCopySource(row)}>
              동일 옵션 적용
            </Button>
          )}
        </Space>
      ),
    },
  ];

  if (error) {
    return <Alert type="error" showIcon message="옵션 진행 목록을 불러오지 못했습니다." description={(error as Error).message} />;
  }

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            품목별 옵션 진행
          </Typography.Title>
          <Typography.Text type="secondary">
            맞춤 품목의 옵션 선택 진행상태입니다. 렌탈 품목은 옵션 선택 대상이 아닙니다.
          </Typography.Text>
        </div>
        {isLoading ? (
          <Spin style={{ display: 'block', margin: '48px auto' }} />
        ) : (
          <Table<OptionProgressItem>
            rowKey="orderItemId"
            dataSource={data ?? []}
            columns={columns}
            pagination={false}
            size="large"
          />
        )}
      </Space>

      <Modal
        title={`동일 옵션 적용 — ${copySource?.displayName ?? ''}`}
        open={!!copySource}
        onCancel={() => {
          setCopySource(null);
          setCopyTargetId(null);
        }}
        okText="적용"
        cancelText="취소"
        okButtonProps={{ disabled: !copyTargetId, loading: copyMutation.isPending, size: 'large' }}
        cancelButtonProps={{ size: 'large' }}
        onOk={() => {
          if (copySource?.sessionId && copyTargetId) {
            copyMutation.mutate({ sessionId: copySource.sessionId, targetId: copyTargetId });
          }
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
              <Radio key={t.orderItemId} value={t.orderItemId} style={{ minHeight: 48, alignItems: 'center' }}>
                <Space>
                  <Typography.Text strong>{t.displayName}</Typography.Text>
                  <Typography.Text type="secondary">
                    {t.customerName} · {t.orderNo}
                  </Typography.Text>
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
    </Card>
  );
}
