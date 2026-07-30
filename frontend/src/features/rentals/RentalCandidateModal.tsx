/**
 * 렌탈 부위별 후보 실물 검색 팝업 — 스타일 컨설팅 목록의 렌탈 부위 행에서 띄운다.
 * 행에서 지정한 컬러·사이즈로 AVAILABLE 실물을 걸러 보여주고, 하나를 골라 담는다.
 * 날짜 기간잠금(배정)은 이후 렌탈예약에서 처리한다 (설계서 04 §4.3).
 */
import { CheckOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Modal, Space, Spin, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { RentalCandidate } from '../../api/rentals';
import {
  fetchRentalLineCandidates,
  selectRentalLineItem,
  startRentalSelection,
} from '../../api/rentals';

interface Props {
  open: boolean;
  contractItemId: string;
  contractItemComponentId: string;
  /** 팝업 제목 — "렌탈 정장 #1 · 상의(자켓)" */
  title: string;
  /** 행에서 지정한 조건 (표시용) */
  colorName: string | null;
  sizeName: string | null;
  selectedInventoryItemId: string | null;
  onClose: () => void;
}

export function RentalCandidateModal({
  open,
  contractItemId,
  contractItemComponentId,
  title,
  colorName,
  sizeName,
  selectedInventoryItemId,
  onClose,
}: Props) {
  const queryClient = useQueryClient();

  // 세션 시작 API는 현재본이 있으면 그대로 돌려준다(멱등) — 목록에서 바로 열어도 안전하다.
  const sessionQuery = useQuery({
    queryKey: ['rental-selection', 'session', contractItemId],
    queryFn: () => startRentalSelection(contractItemId),
    enabled: open && !!contractItemId,
    retry: false,
  });
  const session = sessionQuery.data ?? null;

  const candidatesQuery = useQuery({
    queryKey: ['rental-selection', 'candidates', session?.sessionId, contractItemComponentId],
    queryFn: () => fetchRentalLineCandidates(session!.sessionId, contractItemComponentId),
    enabled: open && !!session?.sessionId,
  });

  const selectMutation = useMutation({
    mutationFn: (inventoryItemId: string | null) =>
      selectRentalLineItem(session!.sessionId, contractItemComponentId, {
        inventoryItemId,
        version: session!.version,
      }),
    onSuccess: (detail, inventoryItemId) => {
      queryClient.setQueryData(['rental-selection', 'session', contractItemId], detail);
      void queryClient.invalidateQueries({ queryKey: ['rental-selection', 'progress'] });
      message.success(inventoryItemId ? '실물을 선택했습니다.' : '선택을 해제했습니다.');
      if (inventoryItemId) onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const columns: ColumnsType<RentalCandidate> = [
    { title: '관리코드', dataIndex: 'managementCode', key: 'managementCode', width: 160 },
    { title: '컬러', dataIndex: 'color', key: 'color', width: 120 },
    { title: '사이즈', dataIndex: 'size', key: 'size', width: 100 },
    {
      title: '',
      key: 'pick',
      width: 110,
      render: (_, row) =>
        row.id === selectedInventoryItemId ? (
          <Button
            danger
            loading={selectMutation.isPending}
            onClick={() => selectMutation.mutate(null)}
          >
            선택 해제
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<CheckOutlined />}
            loading={selectMutation.isPending}
            onClick={() => selectMutation.mutate(row.id)}
          >
            선택
          </Button>
        ),
    },
  ];

  const candidates = candidatesQuery.data?.candidates ?? [];

  return (
    <Modal open={open} onCancel={onClose} title={title} width={820} destroyOnHidden footer={null}>
      {sessionQuery.error ? (
        <Alert
          type="error"
          showIcon
          message="렌탈 선택 세션을 열지 못했습니다."
          description={(sessionQuery.error as Error).message}
        />
      ) : sessionQuery.isLoading ? (
        <Spin style={{ display: 'block', margin: '64px auto' }} size="large" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Typography.Text type="secondary">검색 조건</Typography.Text>
            <Tag color={colorName ? 'blue' : undefined}>컬러: {colorName ?? '전체'}</Tag>
            <Tag color={sizeName ? 'blue' : undefined}>사이즈: {sizeName ?? '전체'}</Tag>
          </Space>
          {/* 컬러·사이즈는 목록 행에서 고른다 — 여기서 다시 고르게 하면 저장 주체가 갈린다. */}
          <Typography.Text type="secondary">
            재고상태가 &apos;대여가능&apos;인 실물만 나옵니다. 조건을 바꾸려면 목록 행의 컬러·사이즈를
            수정하세요.
          </Typography.Text>
          <Table<RentalCandidate>
            rowKey="id"
            size="small"
            loading={candidatesQuery.isLoading}
            dataSource={candidates}
            columns={columns}
            pagination={false}
            scroll={{ x: 'max-content', y: 380 }}
            locale={{ emptyText: '조건에 맞는 대여가능 실물이 없습니다.' }}
            rowClassName={(row) => (row.id === selectedInventoryItemId ? 'ant-table-row-selected' : '')}
          />
        </Space>
      )}
    </Modal>
  );
}
