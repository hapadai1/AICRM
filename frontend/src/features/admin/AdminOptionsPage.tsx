/**
 * ADMIN-002 옵션 세트·단계 관리
 * - 품목 대분류 선택 → 버전 목록(DRAFT/ACTIVE/RETIRED) → 단계 표 + A/B 선택지
 * - 새 버전(기존 복사), DRAFT만 편집, 활성화 시 기존 ACTIVE → RETIRED 확인
 */
import { DeleteOutlined, PlusOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Image,
  Input,
  InputNumber,
  Radio,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import {
  activateOptionSetVersion,
  createOptionSetVersion,
  fetchOptionSetVersion,
  fetchOptionSets,
  saveOptionStages,
} from '../../api/admin';
import { CHOICE_SLOTS, MAX_CHOICES, MIN_CHOICES } from '../../api/admin';
import type {
  OptionSetVersionStatus,
  OptionSetVersionSummary,
  OptionStageInput,
} from '../../api/admin';
import { ApiError, fetchFileObjectUrl } from '../../api/client';
import { PRODUCT_CATEGORY_LABEL } from '../contracts/labels';
import { metaOf } from '../../shared/status-meta';

const STATUS_META: Record<OptionSetVersionStatus, { label: string; color: string }> = {
  DRAFT: { label: '작성중', color: 'gold' },
  ACTIVE: { label: '사용중', color: 'green' },
  RETIRED: { label: '종료', color: 'default' },
};

interface EditableChoice {
  name: string;
  factoryName: string;
  /** 계약금액에 더해지는 추가금액(원) */
  extraPrice: number;
  imageUrl: string | null;
  imageFileId?: string;
}

interface EditableStage {
  key: string;
  id?: string;
  code?: string;
  name: string;
  sortOrder: number;
  required: boolean;
  /** 2~3개, 화면 순서가 곧 A/B/C 슬롯이다 */
  choices: EditableChoice[];
}

let localKeySeq = 0;

const emptyChoice = (): EditableChoice => ({
  name: '',
  factoryName: '',
  extraPrice: 0,
  imageUrl: null,
});

/**
 * 선택지 사진이 세로로 긴 원본이라 잘리지 않게 contain으로 담고,
 * 인화물처럼 보이도록 둘레에 흰 여백을 둔다(썸네일이라 좁게).
 */
const THUMB_MAT = 6;
const THUMB_STYLE = {
  width: 88,
  height: 124,
  padding: THUMB_MAT,
  borderRadius: 4,
  border: '1px solid #e8e8e8',
  background: '#ffffff',
  objectFit: 'contain' as const,
  boxSizing: 'border-box' as const,
  flexShrink: 0,
  cursor: 'zoom-in' as const,
};

/** 아직 이미지가 없는 선택지(신규 단계) 자리 표시 */
function ImagePlaceholder() {
  return (
    <div
      style={{
        ...THUMB_STYLE,
        border: '1px dashed #d9d9d9',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#bfbfbf',
        fontSize: 11,
        cursor: 'default',
      }}
    >
      이미지
    </div>
  );
}

/** 인증이 필요한 파일이라 blob으로 받아 object URL로 렌더한다. */
function ChoiceImage({ path, alt }: { path: string | null; alt: string }) {
  const { data } = useQuery({
    queryKey: ['file-object-url', path],
    queryFn: () => fetchFileObjectUrl(path!),
    enabled: !!path,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });
  if (!path || !data) return <ImagePlaceholder />;
  return <Image src={data} alt={alt} style={THUMB_STYLE} preview={{ mask: '크게 보기' }} />;
}

export function AdminOptionsPage() {
  const [category, setCategory] = useState<'SUIT' | 'SHIRT' | 'SHOES'>('SUIT');
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [draftStages, setDraftStages] = useState<EditableStage[]>([]);
  const [dirty, setDirty] = useState(false);
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();

  const setsQuery = useQuery({ queryKey: ['option-sets'], queryFn: fetchOptionSets });

  const currentSet = useMemo(
    () => (setsQuery.data ?? []).find((s) => s.category === category),
    [setsQuery.data, category],
  );

  // 대분류 변경 시 최신 버전 자동 선택
  useEffect(() => {
    if (!currentSet) return;
    setSelectedVersionId((prev) => {
      if (prev && currentSet.versions.some((v) => v.id === prev)) return prev;
      const active = currentSet.versions.find((v) => v.status === 'ACTIVE');
      return active?.id ?? currentSet.versions[0]?.id ?? null;
    });
  }, [currentSet]);

  const versionQuery = useQuery({
    queryKey: ['option-set-versions', selectedVersionId],
    queryFn: () => fetchOptionSetVersion(selectedVersionId!),
    enabled: !!selectedVersionId,
  });
  const version = versionQuery.data;
  const isDraft = version?.status === 'DRAFT';

  // 버전 상세 로드 시 편집 상태 초기화
  useEffect(() => {
    if (!version) {
      setDraftStages([]);
      setDirty(false);
      return;
    }
    setDraftStages(
      version.stages.map((s) => ({
        key: s.id,
        id: s.id,
        code: s.code,
        name: s.name,
        sortOrder: s.sortOrder,
        required: s.required,
        choices: CHOICE_SLOTS.map((slot) => s.choices.find((c) => c.slot === slot))
          .filter((c): c is NonNullable<typeof c> => !!c)
          .map((c) => ({
            name: c.name,
            factoryName: c.factoryName ?? '',
            extraPrice: c.extraPrice,
            imageUrl: c.imageUrl,
            imageFileId: c.imageFileId,
          })),
      })),
    );
    setDirty(false);
  }, [version]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['option-sets'] });
    void queryClient.invalidateQueries({ queryKey: ['option-set-versions'] });
  };
  const onApiError = (e: unknown) =>
    message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.');

  const createVersionMutation = useMutation({
    mutationFn: () => createOptionSetVersion(currentSet!.id, selectedVersionId ?? undefined),
    onSuccess: (created) => {
      message.success(`V${created.versionNo} 초안이 생성되었습니다.`);
      invalidate();
      setSelectedVersionId(created.id);
    },
    onError: onApiError,
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const stages: OptionStageInput[] = draftStages.map((s, idx) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        sortOrder: s.sortOrder || idx + 1,
        required: s.required,
        choices: s.choices.map((c, i) => ({
          slot: CHOICE_SLOTS[i],
          name: c.name,
          factoryName: c.factoryName || undefined,
          extraPrice: c.extraPrice,
          imageFileId: c.imageFileId,
        })),
      }));
      return saveOptionStages(selectedVersionId!, stages);
    },
    onSuccess: () => {
      message.success('단계가 저장되었습니다.');
      invalidate();
    },
    onError: onApiError,
  });

  const activateMutation = useMutation({
    mutationFn: () => activateOptionSetVersion(selectedVersionId!),
    onSuccess: (v) => {
      message.success(`V${v.versionNo} 버전이 활성화되었습니다.`);
      invalidate();
    },
    onError: onApiError,
  });

  const handleActivate = () => {
    if (!version || !currentSet) return;
    const currentActive = currentSet.versions.find((v) => v.status === 'ACTIVE');
    modal.confirm({
      title: '옵션 버전 활성화',
      content: currentActive
        ? `기존 사용중 버전 V${currentActive.versionNo}은(는) 종료(RETIRED) 처리되고 V${version.versionNo}이(가) 새로 적용됩니다. 진행할까요?`
        : `V${version.versionNo} 버전을 활성화할까요?`,
      okText: '활성화',
      cancelText: '취소',
      onOk: () => activateMutation.mutate(),
    });
  };

  const patchStage = (key: string, patch: Partial<EditableStage>) => {
    setDraftStages((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
    setDirty(true);
  };

  const versionColumns: ColumnsType<OptionSetVersionSummary> = [
    { title: '버전', dataIndex: 'versionNo', width: 70, render: (n: number) => `V${n}` },
    {
      title: '상태',
      dataIndex: 'status',
      width: 90,
      render: (s: OptionSetVersionStatus) => (
        <Tag color={metaOf(STATUS_META, s).color}>{metaOf(STATUS_META, s).label}</Tag>
      ),
    },
    { title: '단계 수', dataIndex: 'stageCount', width: 80, align: 'center' },
    { title: '생성일', dataIndex: 'createdAt', width: 110 },
    { title: '활성화일', dataIndex: 'activatedAt', width: 110, render: (v?: string) => v ?? '-' },
  ];

  const patchChoice = (stageKey: string, index: number, patch: Partial<EditableChoice>) => {
    setDraftStages((prev) =>
      prev.map((s) =>
        s.key === stageKey
          ? { ...s, choices: s.choices.map((c, i) => (i === index ? { ...c, ...patch } : c)) }
          : s,
      ),
    );
    setDirty(true);
  };

  const choiceCell = (stage: EditableStage, index: number) => {
    const choice = stage.choices[index];
    const slot = CHOICE_SLOTS[index];

    // 3번째 칸은 선택지가 2개인 단계에서 비어 있다 — 초안이면 추가 버튼을 놓는다.
    if (!choice) {
      if (!isDraft || index !== stage.choices.length || stage.choices.length >= MAX_CHOICES)
        return <Typography.Text type="secondary">-</Typography.Text>;
      return (
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() => {
            setDraftStages((prev) =>
              prev.map((s) =>
                s.key === stage.key ? { ...s, choices: [...s.choices, emptyChoice()] } : s,
              ),
            );
            setDirty(true);
          }}
        >
          선택지 추가
        </Button>
      );
    }

    const removable = isDraft && stage.choices.length > MIN_CHOICES && index === stage.choices.length - 1;
    return (
      <Space align="start">
        <ChoiceImage path={choice.imageUrl} alt={`${stage.name} ${slot} ${choice.name}`} />
        <Space direction="vertical" size={4} style={{ width: 168 }}>
          {isDraft ? (
            <>
              <Input
                size="small"
                placeholder={`선택지 ${slot} 명칭`}
                value={choice.name}
                onChange={(e) => patchChoice(stage.key, index, { name: e.target.value })}
              />
              <Input
                size="small"
                placeholder="공장 전달명"
                value={choice.factoryName}
                onChange={(e) => patchChoice(stage.key, index, { factoryName: e.target.value })}
              />
              <InputNumber
                size="small"
                min={0}
                step={1000}
                style={{ width: '100%' }}
                prefix="+"
                addonAfter="원"
                placeholder="추가금액"
                value={choice.extraPrice}
                formatter={(v) => `${v ?? 0}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                parser={(v) => Number((v ?? '').replace(/,/g, ''))}
                onChange={(v) => patchChoice(stage.key, index, { extraPrice: v ?? 0 })}
              />
              {removable && (
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    setDraftStages((prev) =>
                      prev.map((s) =>
                        s.key === stage.key
                          ? { ...s, choices: s.choices.filter((_, i) => i !== index) }
                          : s,
                      ),
                    );
                    setDirty(true);
                  }}
                >
                  선택지 삭제
                </Button>
              )}
            </>
          ) : (
            <>
              <Typography.Text>{choice.name || '-'}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {choice.factoryName || '-'}
              </Typography.Text>
              {choice.extraPrice > 0 && (
                <Tag color="red" style={{ marginInlineEnd: 0 }}>
                  +{choice.extraPrice.toLocaleString()}원
                </Tag>
              )}
            </>
          )}
        </Space>
      </Space>
    );
  };

  const stageColumns: ColumnsType<EditableStage> = [
    {
      title: '순서',
      dataIndex: 'sortOrder',
      width: 80,
      render: (v: number, s) =>
        isDraft ? (
          <InputNumber
            size="small"
            min={1}
            value={v}
            style={{ width: 60 }}
            onChange={(next) => patchStage(s.key, { sortOrder: next ?? 1 })}
          />
        ) : (
          v
        ),
    },
    {
      title: '단계명',
      dataIndex: 'name',
      width: 180,
      render: (v: string, s) =>
        isDraft ? (
          <Input
            size="small"
            value={v}
            onChange={(e) => patchStage(s.key, { name: e.target.value })}
          />
        ) : (
          v
        ),
    },
    {
      title: '필수',
      dataIndex: 'required',
      width: 70,
      align: 'center',
      render: (v: boolean, s) => (
        <Checkbox
          checked={v}
          disabled={!isDraft}
          onChange={(e) => patchStage(s.key, { required: e.target.checked })}
        />
      ),
    },
    ...CHOICE_SLOTS.map(
      (slot, index) =>
        ({
          title: `선택지 #${index + 1} (${slot})`,
          key: slot,
          width: 280,
          render: (_: unknown, s: EditableStage) => choiceCell(s, index),
        }) as ColumnsType<EditableStage>[number],
    ),
    ...(isDraft
      ? [
          {
            title: '삭제',
            key: 'remove',
            width: 60,
            render: (_: unknown, s: EditableStage) => (
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => {
                  setDraftStages((prev) => prev.filter((x) => x.key !== s.key));
                  setDirty(true);
                }}
              />
            ),
          } as ColumnsType<EditableStage>[number],
        ]
      : []),
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="옵션 세트·단계 관리">
        <Space wrap>
          <Typography.Text>품목 대분류</Typography.Text>
          <Radio.Group
            value={category}
            onChange={(e) => setCategory(e.target.value as typeof category)}
            optionType="button"
            buttonStyle="solid"
            options={(['SUIT', 'SHIRT', 'SHOES'] as const).map((value) => ({
              value,
              label: PRODUCT_CATEGORY_LABEL[value],
            }))}
          />
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={9}>
          <Card
            size="small"
            title={`버전 목록${currentSet ? ` — ${currentSet.name}` : ''}`}
            extra={
              <Button
                size="small"
                icon={<PlusOutlined />}
                loading={createVersionMutation.isPending}
                disabled={!currentSet}
                onClick={() => createVersionMutation.mutate()}
              >
                새 버전 (선택 버전 복사)
              </Button>
            }
          >
            <Table<OptionSetVersionSummary>
              rowKey="id"
              scroll={{ x: 'max-content' }}
              size="small"
              loading={setsQuery.isLoading}
              dataSource={currentSet?.versions ?? []}
              columns={versionColumns}
              pagination={false}
              rowClassName={(v) => (v.id === selectedVersionId ? 'ant-table-row-selected' : '')}
              onRow={(v) => ({
                onClick: () => setSelectedVersionId(v.id),
                style: { cursor: 'pointer' },
              })}
            />
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          {!version ? (
            <Card>
              <Empty description="버전을 선택해 주세요." />
            </Card>
          ) : (
            <Card
              size="small"
              title={
                <Space>
                  단계 구성 — V{version.versionNo}
                  <Tag color={metaOf(STATUS_META, version.status).color}>
                    {metaOf(STATUS_META, version.status).label}
                  </Tag>
                </Space>
              }
              extra={
                isDraft ? (
                  <Space>
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() => {
                        localKeySeq += 1;
                        setDraftStages((prev) => [
                          ...prev,
                          {
                            key: `local-${localKeySeq}`,
                            name: '',
                            sortOrder: prev.length + 1,
                            required: true,
                            choices: [emptyChoice(), emptyChoice()],
                          },
                        ]);
                        setDirty(true);
                      }}
                    >
                      단계 추가
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      icon={<SaveOutlined />}
                      loading={saveMutation.isPending}
                      disabled={!dirty}
                      onClick={() => saveMutation.mutate()}
                    >
                      저장
                    </Button>
                    <Button
                      size="small"
                      icon={<ThunderboltOutlined />}
                      loading={activateMutation.isPending}
                      onClick={handleActivate}
                    >
                      활성화
                    </Button>
                  </Space>
                ) : undefined
              }
            >
              {!isDraft && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="사용중·종료 버전은 직접 수정할 수 없습니다. 변경이 필요하면 새 버전을 생성해 주세요."
                />
              )}
              {isDraft && dirty && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="저장되지 않은 변경이 있습니다."
                />
              )}
              <Table<EditableStage>
                rowKey="key"
                size="small"
                loading={versionQuery.isLoading}
                dataSource={[...draftStages].sort((a, b) => a.sortOrder - b.sortOrder)}
                columns={stageColumns}
                pagination={false}
                scroll={{ x: 1240 }}
                locale={{ emptyText: '단계가 없습니다. 단계를 추가해 주세요.' }}
              />
            </Card>
          )}
        </Col>
      </Row>
    </Space>
  );
}
