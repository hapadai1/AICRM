import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, DatePicker, Descriptions, Input, Modal, Radio, Space, Tag, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  ALLOCATION_NOTE_KIND_META,
  createAllocationContact,
  createAllocationNote,
  fetchAllocationContactSuggestion,
  fetchAllocationNotes,
  type RentalAllocation,
  type RentalAllocationNote,
} from '../../api/rentals';
import { Can } from '../../shared/Can';
import { NotificationConfirmModal } from '../../shared/NotificationConfirmModal';
import { metaOf } from '../../shared/status-meta';

/**
 * 대여 건 연락·비고 창 (RENT-004).
 *
 * 한 건에 대해 "몇 번 연락했고, 뭐라고 답이 왔고, 무엇이 바뀌었나"를 한자리에서 다룬다.
 * 발송 이력은 고객·주문까지만 엮여 있어 대여 건별로는 셀 수 없었고, 전화로 받은 답을
 * 적을 곳도 없었다 (현업 확정 2026-08-03).
 */
export function RentalAllocationNotesModal({
  allocation,
  onClose,
}: {
  allocation: RentalAllocation | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'REPLY' | 'MEMO'>('REPLY');
  const [body, setBody] = useState('');
  const [changeOpen, setChangeOpen] = useState(false);
  const [newDate, setNewDate] = useState<Dayjs | null>(null);
  const [changeReason, setChangeReason] = useState('');
  const [contactOpen, setContactOpen] = useState(false);

  const id = allocation?.id;

  const notesQuery = useQuery({
    queryKey: ['rentals', 'allocations', 'notes', id],
    queryFn: () => fetchAllocationNotes(id!),
    enabled: !!id,
  });

  // 연락 문구는 창을 열 때가 아니라 [연락 보내기]를 누를 때 받아 온다 — 목록을 훑는 동안
  // 건마다 문구를 만들어 둘 이유가 없다.
  const suggestionQuery = useQuery({
    queryKey: ['rentals', 'allocations', 'contact-suggestion', id],
    queryFn: () => fetchAllocationContactSuggestion(id!),
    enabled: !!id && contactOpen,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['rentals', 'allocations', 'notes', id] });
    // 목록의 연락 횟수·비고도 함께 갱신한다.
    void queryClient.invalidateQueries({ queryKey: ['rentals', 'allocations'] });
  };

  const noteMutation = useMutation({
    mutationFn: (v: { kind: 'REPLY' | 'MEMO' | 'CHANGE'; body?: string; newReturnDueDate?: string }) =>
      createAllocationNote(id!, v),
    onSuccess: () => {
      setBody('');
      setChangeOpen(false);
      setNewDate(null);
      setChangeReason('');
      message.success('기록했습니다.');
      refresh();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '기록에 실패했습니다.'),
  });

  const contactMutation = useMutation({
    mutationFn: (v: { channel?: string; notificationHistoryId?: string }) => createAllocationContact(id!, v),
    onSuccess: () => refresh(),
    onError: (e) => message.error(e instanceof ApiError ? e.message : '연락 기록에 실패했습니다.'),
  });

  if (!allocation) return null;

  const notes = notesQuery.data ?? [];
  const contactCount = notes.filter((n) => n.kind === 'CONTACT').length;

  return (
    <>
      <Modal
        open={!!allocation}
        onCancel={onClose}
        title={`연락·비고 — ${allocation.customerName}`}
        width={720}
        footer={<Button onClick={onClose}>닫기</Button>}
        destroyOnHidden
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="주문 품목">{allocation.displayName ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="연락 횟수">{contactCount}회</Descriptions.Item>
            <Descriptions.Item label="픽업일">{allocation.pickupDate}</Descriptions.Item>
            <Descriptions.Item label="반납 예정일">{allocation.returnDueDate}</Descriptions.Item>
          </Descriptions>

          <Space size={8} wrap>
            <Can permission="NOTIFICATION_SEND">
              <Button type="primary" onClick={() => setContactOpen(true)}>
                연락 보내기
              </Button>
            </Can>
            <Button onClick={() => setChangeOpen(true)}>반납일 변경 기록</Button>
          </Space>

          {/* 전화로 받은 답을 적을 곳. 이게 없어 통화 결과가 아무 데도 안 남았다. */}
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Radio.Group value={kind} onChange={(e) => setKind(e.target.value)} optionType="button">
              <Radio value="REPLY">고객 회신</Radio>
              <Radio value="MEMO">메모</Radio>
            </Radio.Group>
            <Input.TextArea
              rows={2}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={kind === 'REPLY' ? '예: 3일 뒤 방문하겠다고 함' : '예: 보관 위치 A-3'}
            />
            <Button
              disabled={!body.trim()}
              loading={noteMutation.isPending}
              onClick={() => noteMutation.mutate({ kind, body })}
            >
              기록
            </Button>
          </Space>

          <NoteList notes={notes} loading={notesQuery.isLoading} />
        </Space>
      </Modal>

      {/* 반납일은 기록만 남기고 배정 기간은 그대로 둔다 — 원래 기간으로 걸어 둔 기간 잠금을
          흔들면 그 기간에 잡힌 다음 예약이 깨진다 (현업 확정 2026-08-03). */}
      <Modal
        open={changeOpen}
        title="반납일 변경 기록"
        okText="기록"
        cancelText="취소"
        confirmLoading={noteMutation.isPending}
        onCancel={() => setChangeOpen(false)}
        okButtonProps={{ disabled: !newDate }}
        onOk={() =>
          newDate &&
          noteMutation.mutate({
            kind: 'CHANGE',
            newReturnDueDate: newDate.format('YYYY-MM-DD'),
            body: changeReason,
          })
        }
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            예약 기간은 그대로 둡니다. 지연 표시도 원래 예정일({allocation.returnDueDate}) 기준으로 계속 뜹니다.
          </Typography.Text>
          <DatePicker
            style={{ width: '100%' }}
            value={newDate}
            onChange={setNewDate}
            placeholder="고객이 말한 반납일"
          />
          <Input
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
            placeholder="사유 (예: 고객 요청)"
          />
        </Space>
      </Modal>

      <NotificationConfirmModal
        open={contactOpen}
        title={`${allocation.customerName} — 고객 연락`}
        suggestion={suggestionQuery.data ?? null}
        onCancel={() => setContactOpen(false)}
        onDone={async (outcome, historyId) => {
          setContactOpen(false);
          // 연락 횟수에는 실제로 나간 것만 잡는다.
          if (outcome === 'SENT') {
            await contactMutation.mutateAsync({
              channel: suggestionQuery.data?.channel,
              notificationHistoryId: historyId,
            });
            return;
          }
          // 안 보내기로 한 것도 판단이다 — 남기지 않으면 다음 사람이 같은 창을 다시 연다.
          await noteMutation.mutateAsync({
            kind: 'MEMO',
            body: outcome === 'DEFERRED' ? '연락 보류 — 나중에 보내기로 함' : '연락 안 함',
          });
        }}
      />
    </>
  );
}

/** 연락·회신·변경·메모를 최근 것부터 한 줄씩 */
function NoteList({ notes, loading }: { notes: RentalAllocationNote[]; loading: boolean }) {
  if (loading) return <Typography.Text type="secondary">불러오는 중…</Typography.Text>;
  if (notes.length === 0)
    return <Typography.Text type="secondary">아직 연락·기록이 없습니다.</Typography.Text>;
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {notes.map((n) => {
        const meta = metaOf(ALLOCATION_NOTE_KIND_META, n.kind);
        return (
          <Space key={n.id ?? `${n.kind}-${n.createdAt}`} direction="vertical" size={0} style={{ width: '100%' }}>
            <Space size={6}>
              <Tag color={meta.color}>{meta.label}</Tag>
              <Typography.Text type="secondary">
                {dayjs(n.createdAt).format('YYYY-MM-DD HH:mm')} · {n.actor?.displayName ?? n.actorName ?? '-'}
              </Typography.Text>
            </Space>
            <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{n.body}</Typography.Text>
          </Space>
        );
      })}
    </Space>
  );
}
