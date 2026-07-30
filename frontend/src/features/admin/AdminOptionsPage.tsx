/**
 * ADMIN-002 옵션 세트·단계 관리
 * - 품목 대분류 선택 → 버전 목록(DRAFT/ACTIVE/RETIRED) → 단계 목록 + 선택지
 * - 단계는 세로로 쌓는다: 첫 줄에 순서·단계명·필수, 그 아래 선택지 사진 격자
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
  Empty,
  Image,
  Input,
  InputNumber,
  Radio,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import {
  activateOptionSetVersion,
  createOptionSetVersion,
  deleteOptionSetVersion,
  fetchOptionSets,
} from '../../api/admin';
import { CHOICE_SLOTS, MAX_CHOICES, MIN_CHOICES } from '../../api/admin';
import type { OptionSetVersionStatus, OptionSetVersionSummary } from '../../api/admin';
import {
  componentGroupLabel,
  fetchAdminOptionSetVersion,
  OPTION_COMPONENT_GROUPS,
  saveAdminOptionStages,
} from '../../api/options';
import type { AdminOptionStageInput } from '../../api/options';
import { ApiError, fetchFileObjectUrl } from '../../api/client';
import { PRODUCT_CATEGORY_LABEL } from '../contracts/labels';
import { metaOf } from '../../shared/status-meta';

const STATUS_META: Record<OptionSetVersionStatus, { label: string; color: string }> = {
  DRAFT: { label: '작성중', color: 'gold' },
  ACTIVE: { label: '사용중', color: 'green' },
  RETIRED: { label: '종료', color: 'default' },
};

interface EditableChoice {
  /** 서버 선택지 id — 사용중 버전에서 가격만 바로 고칠 때 쓴다. 새로 추가한 칸은 없다. */
  id?: string;
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
  /** 부위 그룹(JACKET/TROUSERS/VEST). 셔츠·구두 등 단일 부위 세트는 null. */
  componentGroup: string | null;
  /**
   * 표시 전용 부위 내 순번. 표에 뿌리기 직전 stageTable()이 매긴다 (저장 대상 아님).
   * sortOrder는 세트 전체를 관통하는 흐름 순서라 부위 탭에서는 베스트가 12·13으로 보인다.
   */
  groupOrder?: number;
  /** 2~40개, 화면 순서가 곧 A~Z·AA~ 슬롯이다 */
  choices: EditableChoice[];
}

let localKeySeq = 0;

const emptyChoice = (): EditableChoice => ({
  name: '',
  factoryName: '',
  extraPrice: 0,
  imageUrl: null,
});

/** 인화물처럼 보이도록 사진 둘레에 두르는 흰 여백 */
const THUMB_MAT = 6;
/**
 * 등록된 사진을 원본 크기(100%)로 보여준다 — 줄이면 카라 벌림·커프스 모서리처럼
 * 선택지를 가르는 미세한 차이가 화면에서 사라져 등록이 맞는지 확인할 수 없다.
 * width를 주지 않아 원본보다 늘어나지도 않는다 — 셔츠 자산은 290px대라 늘리면 뭉갠다
 * (원본이 상담자료 한 장에서 잘라낸 것이라 해상도가 거기까지다).
 * 칸(CHOICE_COL_WIDTH)보다 큰 사진만 maxWidth로 줄고, 원본은 '크게 보기'로 확인한다.
 */
const THUMB_STYLE = {
  maxWidth: '100%',
  height: 'auto' as const,
  padding: THUMB_MAT,
  borderRadius: 4,
  border: '1px solid #e8e8e8',
  background: '#ffffff',
  objectFit: 'contain' as const,
  boxSizing: 'border-box' as const,
  cursor: 'zoom-in' as const,
};

/**
 * 선택지 한 칸의 최소 너비.
 * 실제 자산 폭은 셔츠 284~393, 정장 377~941(STITCH), 베스트 769~804, 구두 830이다.
 * 620이면 대부분이 원본대로 들어가고(정장 STITCH·베스트만 살짝 줄어든다) 한 줄에 2~3장씩 비교된다.
 * 941까지 올리면 전부 원본이지만 한 줄에 한 장이라 비교가 안 된다.
 */
const CHOICE_COL_WIDTH = 620;

/** 선택지 추가금액 상한(원) — 백엔드 MAX_EXTRA_PRICE 와 같은 값. 자릿수 오타를 막는다. */
const MAX_EXTRA_PRICE = 100_000_000;

/** 아직 이미지가 없는 선택지(신규 단계) 자리 표시 */
function ImagePlaceholder() {
  return (
    <div
      style={{
        ...THUMB_STYLE,
        width: '100%',
        height: 160,
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
  return (
    <Image
      src={data}
      alt={alt}
      style={THUMB_STYLE}
      // rootClassName으로 확대 미리보기에도 같은 흰 여백을 준다 (index.css)
      preview={{ mask: '크게 보기', rootClassName: 'option-choice-preview' }}
    />
  );
}

export function AdminOptionsPage() {
  const [category, setCategory] = useState<'SUIT' | 'SHIRT' | 'SHOES'>('SUIT');
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [draftStages, setDraftStages] = useState<EditableStage[]>([]);
  const [dirty, setDirty] = useState(false);
  // 정장 세트는 부위(상의/하의/베스트) 탭으로 세분한다. 셔츠·구두는 단일 화면.
  const componentGroups = OPTION_COMPONENT_GROUPS[category];
  const hasGroups = componentGroups.length > 1;
  const [activeGroup, setActiveGroup] = useState<string>(componentGroups[0] ?? '');
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

  // 대분류 변경 시 부위 탭을 그 카테고리의 첫 부위로 되돌린다.
  useEffect(() => {
    setActiveGroup(componentGroups[0] ?? '');
  }, [componentGroups]);

  const versionQuery = useQuery({
    queryKey: ['option-set-versions', selectedVersionId],
    queryFn: () => fetchAdminOptionSetVersion(selectedVersionId!),
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
        componentGroup: s.componentGroup,
        choices: CHOICE_SLOTS.map((slot) => s.choices.find((c) => c.slot === slot))
          .filter((c): c is NonNullable<typeof c> => !!c)
          .map((c) => ({
            id: c.id,
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
      const stages: AdminOptionStageInput[] = draftStages.map((s, idx) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        sortOrder: s.sortOrder || idx + 1,
        required: s.required,
        componentGroup: s.componentGroup,
        choices: s.choices.map((c, i) => ({
          slot: CHOICE_SLOTS[i],
          name: c.name,
          factoryName: c.factoryName || undefined,
          extraPrice: c.extraPrice,
          imageFileId: c.imageFileId,
        })),
      }));
      return saveAdminOptionStages(selectedVersionId!, stages);
    },
    onSuccess: () => {
      message.success('단계가 저장되었습니다.');
      invalidate();
    },
    onError: onApiError,
  });

  /** 잘못 만든 작성중 버전 정리 — 사용중·종료 버전은 백엔드가 막는다. */
  const deleteVersionMutation = useMutation({
    mutationFn: (versionId: string) => deleteOptionSetVersion(versionId),
    onSuccess: (res) => {
      message.success(`V${res.versionNo} 초안을 삭제했습니다.`);
      // 지운 버전을 보고 있었다면 선택을 비워 목록 새로고침 후 사용중 버전이 잡히게 한다.
      setSelectedVersionId((prev) => (prev === res.versionId ? null : prev));
      invalidate();
    },
    onError: onApiError,
  });

  const handleDeleteVersion = (v: OptionSetVersionSummary) => {
    modal.confirm({
      title: `V${v.versionNo} 초안 삭제`,
      content: '작성 중인 단계·선택지가 함께 삭제되며 되돌릴 수 없습니다. 삭제할까요?',
      okText: '삭제',
      okButtonProps: { danger: true },
      cancelText: '취소',
      onOk: () => deleteVersionMutation.mutate(v.id),
    });
  };

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
    {
      // 작성중 버전만 지운다 — 사용중·종료 버전은 확정 계약이 참조하는 기록이다.
      title: '삭제',
      key: 'remove',
      width: 60,
      align: 'center',
      render: (_: unknown, v) =>
        v.status === 'DRAFT' ? (
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            loading={deleteVersionMutation.isPending && deleteVersionMutation.variables === v.id}
            onClick={(e) => {
              // 행 클릭(버전 선택)까지 같이 타지 않게 막는다.
              e.stopPropagation();
              handleDeleteVersion(v);
            }}
          />
        ) : null,
    },
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

  const addChoiceButton = (stage: EditableStage) => (
    <Button
      size="small"
      type="dashed"
      style={{ height: '100%', minHeight: 120 }}
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

  const choiceCell = (stage: EditableStage, index: number) => {
    const choice = stage.choices[index];
    const slot = CHOICE_SLOTS[index];
    const removable = isDraft && stage.choices.length > MIN_CHOICES && index === stage.choices.length - 1;
    return (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {/* 격자 배치라 열 머리글이 없다 — 칸마다 슬롯을 적어 A~Z 순서를 알아볼 수 있게 한다. */}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          선택지 #{index + 1} ({slot})
        </Typography.Text>
        <ChoiceImage path={choice.imageUrl} alt={`${stage.name} ${slot} ${choice.name}`} />
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
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
                max={MAX_EXTRA_PRICE}
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
              {/*
                추가금액은 작성중(DRAFT) 버전에서만 고친다. 사용중 버전에서 바로 고칠 수 있게
                두면 같은 버전 번호가 시점에 따라 다른 금액을 뜻하게 되어, "V1로 계약했다"는
                말만으로 얼마였는지 알 수 없다. 가격도 구성과 같이 새 버전으로만 바꾼다.
              */}
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

  /**
   * 선택지는 화면 폭에 들어가는 만큼 옆으로 놓고 넘치면 아래로 접는다.
   * 한 칸은 사진 원본 폭(CHOICE_COL_WIDTH)을 유지하므로 좁은 화면에서는 한 줄에 하나씩 내려간다.
   */
  const choicesGrid = (stage: EditableStage) => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(min(${CHOICE_COL_WIDTH}px, 100%), 1fr))`,
        gap: 12,
        alignItems: 'start',
      }}
    >
      {stage.choices.map((_, i) => (
        <div key={i}>{choiceCell(stage, i)}</div>
      ))}
      {isDraft && stage.choices.length < MAX_CHOICES && <div>{addChoiceButton(stage)}</div>}
    </div>
  );

  /**
   * 단계 하나를 세로로 쌓아 보여준다 — 첫 줄에 순서·단계명·필수, 그 아래 선택지 사진.
   * 예전처럼 단계명 옆으로 사진 열을 이어 붙이면, 선택지가 많은 단계(구두 29스타일)에서
   * 오른쪽 사진을 보려고 가로 스크롤한 순간 단계명이 화면 밖으로 밀려 무슨 단계인지 알 수 없었다.
   */
  const stageBlock = (s: EditableStage) => (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap size={8} style={{ width: '100%' }}>
        {/* 편집 중에는 전체 순번을 그대로 다뤄야 한다 — 순번은 한 버전 안에서 유일해야 하고
            (option_stages의 (version, sequence_no) 유일 제약) 부위를 가로지르는 진행 순서를
            정하는 값이라, 부위별로 1부터 다시 매기면 부위 간 순서를 표현할 수 없다. */}
        {isDraft ? (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              순서(전체)
            </Typography.Text>
            <InputNumber
              size="small"
              min={1}
              value={s.sortOrder}
              style={{ width: 64 }}
              onChange={(next) => patchStage(s.key, { sortOrder: next ?? 1 })}
            />
            <Input
              size="small"
              style={{ width: 220 }}
              placeholder="단계명"
              value={s.name}
              onChange={(e) => patchStage(s.key, { name: e.target.value })}
            />
          </>
        ) : s.groupOrder != null && s.groupOrder !== s.sortOrder ? (
          // 부위 탭에서는 그 부위 기준 번호를 보여준다(베스트 12·13 → 1·2).
          <Tooltip title={`전체 순서 ${s.sortOrder}번`}>
            <Typography.Text strong style={{ fontSize: 15 }}>
              {s.groupOrder}. {s.name}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text strong style={{ fontSize: 15 }}>
            {s.sortOrder}. {s.name}
          </Typography.Text>
        )}
        <Checkbox
          checked={s.required}
          disabled={!isDraft}
          onChange={(e) => patchStage(s.key, { required: e.target.checked })}
        >
          필수
        </Checkbox>
        {isDraft && (
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              setDraftStages((prev) => prev.filter((x) => x.key !== s.key));
              setDirty(true);
            }}
          >
            단계 삭제
          </Button>
        )}
      </Space>
      {choicesGrid(s)}
    </Space>
  );

  // 단계 블록 하나가 곧 한 행이라 열은 하나뿐이다 — 머리글은 표에서 감춘다.
  const stageColumns: ColumnsType<EditableStage> = [
    { title: '단계', key: 'stage', render: (_: unknown, s: EditableStage) => stageBlock(s) },
  ];

  const sortedStages = [...draftStages].sort((a, b) => a.sortOrder - b.sortOrder);

  const stageTable = (rows: EditableStage[]) => (
    <Table<EditableStage>
      rowKey="key"
      size="small"
      loading={versionQuery.isLoading}
      // 부위 내 순번은 여기서 매긴다 — 표가 페이지로 잘리므로 render의 행 인덱스로는
      // 2페이지부터 1로 되돌아간다.
      dataSource={rows.map((s, i) => ({ ...s, groupOrder: i + 1 }))}
      columns={stageColumns}
      showHeader={false}
      /*
        페이지로 나누지 않고 단계를 전부 편다. 사진이 원본 크기라 페이지가 길어지지만,
        페이지를 넘겨 가며 보면 단계 간 비교가 끊긴다 — 세로 스크롤로 훑는 편이 낫다.
      */
      pagination={false}
      // 선택지가 화면 폭 안에서 접히므로 가로 스크롤을 두지 않는다 — 스크롤하면 단계명이 밀려난다.
      locale={{ emptyText: '단계가 없습니다. 단계를 추가해 주세요.' }}
    />
  );

  // 정장 세트 부위 탭: 표준 부위(상의/하의/베스트) + 미지정(구 버전 백필 전) 단계가 있으면 마지막 탭.
  const NONE_KEY = '__none__';
  const ungroupedStages = sortedStages.filter(
    (s) => !s.componentGroup || !componentGroups.includes(s.componentGroup),
  );
  const groupTabItems = [
    ...componentGroups.map((g) => ({
      key: g,
      label: `${componentGroupLabel(g)} (${sortedStages.filter((s) => s.componentGroup === g).length})`,
      children: stageTable(sortedStages.filter((s) => s.componentGroup === g)),
    })),
    ...(ungroupedStages.length > 0
      ? [
          {
            key: NONE_KEY,
            label: `미지정 (${ungroupedStages.length})`,
            children: stageTable(ungroupedStages),
          },
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

      {/* 선택지가 3개까지 늘어 단계 표가 넓다. 좌우로 나누면 표가 눌리므로 위아래로 쌓는다. */}
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
                        // 정장 세트는 현재 부위 탭에 단계를 추가한다. 셔츠·구두는 부위 없음(null).
                        componentGroup:
                          hasGroups && componentGroups.includes(activeGroup) ? activeGroup : null,
                        choices: [emptyChoice(), emptyChoice()],
                      },
                    ]);
                    setDirty(true);
                  }}
                >
                  {hasGroups && componentGroups.includes(activeGroup)
                    ? `${componentGroupLabel(activeGroup)} 단계 추가`
                    : '단계 추가'}
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
          {version.status === 'ACTIVE' && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="사용중 버전은 수정할 수 없습니다. 변경이 필요하면 새 버전을 생성해 주세요."
            />
          )}
          {version.status === 'RETIRED' && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="종료된 버전은 과거 기록이라 수정할 수 없습니다. 변경이 필요하면 새 버전을 생성해 주세요."
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
          {hasGroups ? (
            <Tabs
              activeKey={activeGroup}
              onChange={setActiveGroup}
              items={groupTabItems}
            />
          ) : (
            stageTable(sortedStages)
          )}
        </Card>
      )}
    </Space>
  );
}
