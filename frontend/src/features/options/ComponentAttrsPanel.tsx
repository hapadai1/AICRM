/**
 * 맞춤 스타일 컨설팅 — 부위(상의/하의/베스트)별 원단·컬러·패턴·비고 수기입력 (설계서 04 §2).
 * 정장은 부위 탭(JACKET/TROUSERS/VEST), 셔츠·구두는 단일 부위 섹션.
 * 저장은 부위별 component-attrs upsert(낙관적 잠금). 정장1/정장2는 서로 다른 세션이라 독립적이다.
 */
import { SaveOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Descriptions, Input, Space, Tabs, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import type { OptionComponentAttr, OptionSessionDetail } from '../../api/options';
import { componentGroupLabel, saveOptionComponentAttr } from '../../api/options';

interface AttrDraft {
  fabricName: string;
  colorName: string;
  patternName: string;
  notes: string;
}

const toDraft = (c: OptionComponentAttr): AttrDraft => ({
  fabricName: c.fabricName ?? '',
  colorName: c.colorName ?? '',
  patternName: c.patternName ?? '',
  notes: c.notes ?? '',
});

const emptyDraft: AttrDraft = { fabricName: '', colorName: '', patternName: '', notes: '' };

export function ComponentAttrsPanel({
  session,
  orderItemId,
}: {
  session: OptionSessionDetail;
  orderItemId: string;
}) {
  const queryClient = useQueryClient();
  const components = session.components;
  const readOnly = session.status === 'CONFIRMED';
  const [drafts, setDrafts] = useState<Record<string, AttrDraft>>({});

  // 세션이 바뀔 때만 초기화한다 — 한 부위를 저장해도 편집 중인 다른 부위 값이 날아가지 않게 한다.
  useEffect(() => {
    setDrafts(Object.fromEntries(components.map((c) => [c.componentGroup, toDraft(c)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  const saveMutation = useMutation({
    mutationFn: (group: string) =>
      saveOptionComponentAttr(session.sessionId, group, {
        ...(drafts[group] ?? emptyDraft),
        version: session.version,
      }),
    onSuccess: (res) => {
      message.success(`${componentGroupLabel(res.componentGroup)} 저장되었습니다.`);
      queryClient.setQueryData<OptionSessionDetail>(['options', 'session', orderItemId], (prev) =>
        prev
          ? {
              ...prev,
              version: res.version,
              components: prev.components.map((c) =>
                c.componentGroup === res.componentGroup && res.component ? res.component : c,
              ),
            }
          : prev,
      );
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (components.length === 0) return null;

  const patch = (group: string, key: keyof AttrDraft, value: string) =>
    setDrafts((prev) => ({
      ...prev,
      [group]: { ...(prev[group] ?? emptyDraft), [key]: value },
    }));

  const renderGroup = (c: OptionComponentAttr) => {
    if (readOnly) {
      const has = c.fabricName || c.colorName || c.patternName || c.notes;
      return (
        <Descriptions size="small" column={1} bordered style={{ background: '#fff' }}>
          <Descriptions.Item label="원단">{c.fabricName || '-'}</Descriptions.Item>
          <Descriptions.Item label="컬러">{c.colorName || '-'}</Descriptions.Item>
          <Descriptions.Item label="패턴">{c.patternName || '-'}</Descriptions.Item>
          <Descriptions.Item label="비고">{c.notes || '-'}</Descriptions.Item>
          {!has && (
            <Descriptions.Item label=" ">
              <Typography.Text type="secondary">입력 없음</Typography.Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      );
    }
    const d = drafts[c.componentGroup] ?? emptyDraft;
    const saving = saveMutation.isPending && saveMutation.variables === c.componentGroup;
    return (
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Input
          size="large"
          style={{ height: 48 }}
          addonBefore="원단"
          placeholder="원단명 (예: 캐노니코 네이비 트윌)"
          value={d.fabricName}
          onChange={(e) => patch(c.componentGroup, 'fabricName', e.target.value)}
        />
        <Input
          size="large"
          style={{ height: 48 }}
          addonBefore="컬러"
          placeholder="컬러 (예: 다크네이비)"
          value={d.colorName}
          onChange={(e) => patch(c.componentGroup, 'colorName', e.target.value)}
        />
        <Input
          size="large"
          style={{ height: 48 }}
          addonBefore="패턴"
          placeholder="패턴 (예: 헤링본 / 무지)"
          value={d.patternName}
          onChange={(e) => patch(c.componentGroup, 'patternName', e.target.value)}
        />
        <Input.TextArea
          rows={2}
          placeholder="비고 (부위별 요청사항)"
          value={d.notes}
          onChange={(e) => patch(c.componentGroup, 'notes', e.target.value)}
        />
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={saving}
          onClick={() => saveMutation.mutate(c.componentGroup)}
        >
          {componentGroupLabel(c.componentGroup)} 저장
        </Button>
      </Space>
    );
  };

  return (
    <Card size="small" title="부위별 원단·컬러·패턴">
      {components.length === 1 ? (
        renderGroup(components[0])
      ) : (
        <Tabs
          items={components.map((c) => ({
            key: c.componentGroup,
            label: componentGroupLabel(c.componentGroup),
            children: renderGroup(c),
          }))}
        />
      )}
    </Card>
  );
}
