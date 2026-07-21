/** DASH-001 공유 메모: 목록·작성·수정·완료·삭제 */
import { CheckCircleOutlined, DeleteOutlined, EditOutlined, UndoOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Input, List, Popconfirm, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  createSharedMemo,
  deleteSharedMemo,
  fetchSharedMemos,
  updateSharedMemo,
} from '../../api/dashboard';
import type { SharedMemo } from '../../api/dashboard';

export function SharedMemoCard() {
  const [newContent, setNewContent] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const memosQuery = useQuery({ queryKey: ['shared-memos'], queryFn: fetchSharedMemos });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['shared-memos'] });
  const onError = (e: unknown) =>
    message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');

  const createMutation = useMutation({
    mutationFn: createSharedMemo,
    onSuccess: () => {
      setNewContent('');
      invalidate();
    },
    onError,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { content?: string; completed?: boolean } }) =>
      updateSharedMemo(id, payload),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSharedMemo,
    onSuccess: () => {
      message.success('메모를 삭제했습니다.');
      invalidate();
    },
    onError,
  });

  const renderMemo = (memo: SharedMemo) => {
    const isEditing = editingId === memo.id;
    return (
      <List.Item
        key={memo.id}
        actions={
          isEditing
            ? [
                <Button
                  key="save"
                  type="primary"
                  size="small"
                  loading={updateMutation.isPending}
                  onClick={() =>
                    updateMutation.mutate({ id: memo.id, payload: { content: editingContent } })
                  }
                >
                  저장
                </Button>,
                <Button key="cancel" size="small" onClick={() => setEditingId(null)}>
                  취소
                </Button>,
              ]
            : [
                <Button
                  key="complete"
                  size="small"
                  type="text"
                  icon={memo.completed ? <UndoOutlined /> : <CheckCircleOutlined />}
                  onClick={() =>
                    updateMutation.mutate({ id: memo.id, payload: { completed: !memo.completed } })
                  }
                >
                  {memo.completed ? '완료 취소' : '완료'}
                </Button>,
                <Button
                  key="edit"
                  size="small"
                  type="text"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditingId(memo.id);
                    setEditingContent(memo.content);
                  }}
                >
                  수정
                </Button>,
                <Popconfirm
                  key="delete"
                  title="메모를 삭제할까요?"
                  okText="삭제"
                  cancelText="취소"
                  onConfirm={() => deleteMutation.mutate(memo.id)}
                >
                  <Button size="small" type="text" danger icon={<DeleteOutlined />}>
                    삭제
                  </Button>
                </Popconfirm>,
              ]
        }
      >
        <List.Item.Meta
          title={
            <Space size="small">
              <Typography.Text strong>{memo.authorName}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {dayjs(memo.createdAt).format('MM-DD HH:mm')}
                {memo.updatedAt ? ' (수정됨)' : ''}
              </Typography.Text>
              {memo.completed && <Tag color="green">완료</Tag>}
            </Space>
          }
          description={
            isEditing ? (
              <Input.TextArea
                value={editingContent}
                onChange={(e) => setEditingContent(e.target.value)}
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
            ) : (
              <Typography.Text delete={memo.completed}>{memo.content}</Typography.Text>
            )
          }
        />
      </List.Item>
    );
  };

  return (
    <Card title="공유 메모" size="small">
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input.TextArea
          placeholder="팀에 공유할 메모를 입력하세요"
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          autoSize={{ minRows: 1, maxRows: 3 }}
        />
        <Button
          type="primary"
          loading={createMutation.isPending}
          disabled={!newContent.trim()}
          onClick={() => createMutation.mutate(newContent)}
        >
          등록
        </Button>
      </Space.Compact>
      <List<SharedMemo>
        size="small"
        loading={memosQuery.isLoading}
        dataSource={memosQuery.data ?? []}
        renderItem={renderMemo}
        locale={{ emptyText: '등록된 메모가 없습니다.' }}
      />
    </Card>
  );
}
