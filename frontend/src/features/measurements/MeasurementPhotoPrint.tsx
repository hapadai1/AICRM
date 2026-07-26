/**
 * 채촌 사진 A4 인쇄 (설계서 v2 05 §5).
 * 선택한 N장을 A4 한 장 그리드로 인쇄한다. 그리드 열 수는 cols = ceil(sqrt(N)) 규칙.
 * 인증이 필요한 `/api/v1/files/:id`는 <img>가 헤더를 못 보내므로 blob(objectURL)로 로드한다(미결 M5).
 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Space, Spin, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { fetchFileObjectUrl } from '../../api/client';
import {
  fetchMeasurement,
  fetchMeasurementImages,
  type MeasurementImage,
} from '../../api/measurements';

/** cols = ceil(sqrt(N)). 17장 이상은 밀도 경고와 함께 5열 상한으로 묶는다. */
function gridCols(n: number): number {
  if (n <= 1) return 1;
  const base = Math.ceil(Math.sqrt(n));
  return Math.min(base, 5);
}

const PRINT_STYLE = `
  @page { size: A4; margin: 8mm; }
  @media print {
    .no-print { display: none !important; }
    .ant-layout-sider, .ant-layout-header { display: none !important; }
    .ant-layout-content { margin: 0 !important; padding: 0 !important; }
    .meas-print-page { position: absolute; inset: 0; }
  }
  .meas-print-grid {
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    gap: 4mm;
    width: 194mm;
    height: 281mm;
  }
  .meas-print-cell {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .meas-print-cell img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
`;

export function MeasurementPhotoPrint() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const printedRef = useRef(false);

  const sessionQuery = useQuery({
    queryKey: ['measurements', 'detail', id],
    queryFn: () => fetchMeasurement(id as string),
    enabled: !!id,
  });
  const imagesQuery = useQuery({
    queryKey: ['measurements', 'images', id],
    queryFn: () => fetchMeasurementImages(id as string),
    enabled: !!id,
  });
  const images = useMemo(() => imagesQuery.data ?? [], [imagesQuery.data]);

  // ?ids=fileId,fileId 로 넘어온 선택분을 초기 선택으로 둔다. 없으면 전체 선택.
  const idsParam = searchParams.get('ids');
  const [selected, setSelected] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (selected !== null || images.length === 0) return;
    const wanted = (idsParam ?? '').split(',').filter(Boolean);
    setSelected(new Set(wanted.length > 0 ? wanted : images.map((im) => im.fileId)));
  }, [images, idsParam, selected]);

  const selectedImages = useMemo(
    () => (selected ? images.filter((im) => selected.has(im.fileId)) : []),
    [images, selected],
  );

  // 선택 이미지들을 blob objectURL로 미리 로드한다. 언마운트 시 해제.
  const urlsQuery = useQuery({
    queryKey: ['meas-print-urls', id, selectedImages.map((im) => im.fileId).join(',')],
    queryFn: async () => {
      const map: Record<string, string> = {};
      await Promise.all(
        selectedImages.map(async (im) => {
          map[im.fileId] = await fetchFileObjectUrl(`/files/${im.fileId}`);
        }),
      );
      return map;
    },
    enabled: selectedImages.length > 0,
    staleTime: Infinity,
    gcTime: 0,
  });

  useEffect(() => {
    const urls = urlsQuery.data;
    return () => {
      if (urls) Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [urlsQuery.data]);

  // 이미지 URL이 모두 준비되면 한 번만 인쇄창을 띄운다.
  useEffect(() => {
    if (printedRef.current) return;
    if (selectedImages.length === 0) return;
    if (!urlsQuery.data) return;
    printedRef.current = true;
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, [urlsQuery.data, selectedImages.length]);

  const toggle = (fileId: string) =>
    setSelected((s) => {
      const next = new Set(s ?? []);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });

  if (!id) return <Alert type="warning" showIcon message="채촌 세션이 지정되지 않았습니다." />;
  if (sessionQuery.isLoading || imagesQuery.isLoading) {
    return <Spin style={{ display: 'block', margin: '80px auto' }} size="large" />;
  }

  const session = sessionQuery.data;
  const cols = gridCols(selectedImages.length);
  const urls = urlsQuery.data ?? {};

  return (
    <div className="meas-print-page" style={{ background: '#fff' }}>
      <style>{PRINT_STYLE}</style>

      {/* 인쇄 시 숨겨지는 조작 영역 */}
      <div className="no-print" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space align="center" wrap style={{ justifyContent: 'space-between', width: '100%' }}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              사진 인쇄 — {session?.customerName ?? ''}
              {session ? ` · ${session.measurementDate} · V${session.versionNo}` : ''}
            </Typography.Title>
            <Space>
              <Button onClick={() => setSelected(new Set(images.map((im) => im.fileId)))}>전체 선택</Button>
              <Button onClick={() => setSelected(new Set())}>선택 해제</Button>
              <Button
                type="primary"
                disabled={selectedImages.length === 0}
                onClick={() => window.print()}
              >
                인쇄 ({selectedImages.length}장)
              </Button>
              <Button onClick={() => navigate(-1)}>닫기</Button>
            </Space>
          </Space>

          {images.length === 0 && <Alert type="info" showIcon message="첨부된 사진이 없습니다." />}
          {selectedImages.length >= 17 && (
            <Alert
              type="warning"
              showIcon
              message="선택 장수가 많아 장당 크기가 작아집니다(가독성 저하)."
            />
          )}

          {/* 선택용 썸네일 목록 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 8,
            }}
          >
            {images.map((im) => (
              <SelectableThumb
                key={im.fileId}
                image={im}
                checked={selected?.has(im.fileId) ?? false}
                onToggle={() => toggle(im.fileId)}
              />
            ))}
          </div>
        </Space>
      </div>

      {/* 실제 A4 인쇄 그리드 */}
      {selectedImages.length > 0 && (
        <div className="meas-print-grid" style={{ ['--cols' as string]: cols }}>
          {selectedImages.map((im) => (
            <div key={im.fileId} className="meas-print-cell">
              {urls[im.fileId] ? <img src={urls[im.fileId]} alt={im.originalName} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 선택용 썸네일 (조작 영역 전용, 인쇄에는 포함되지 않음) */
function SelectableThumb({
  image,
  checked,
  onToggle,
}: {
  image: MeasurementImage;
  checked: boolean;
  onToggle: () => void;
}) {
  const { data: src } = useQuery({
    queryKey: ['file-object-url', image.fileId],
    queryFn: () => fetchFileObjectUrl(`/files/${image.fileId}`),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });
  return (
    <div
      onClick={onToggle}
      style={{
        position: 'relative',
        border: checked ? '2px solid #1677ff' : '1px solid #d9d9d9',
        borderRadius: 8,
        padding: 4,
        cursor: 'pointer',
        height: 120,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#fafafa',
      }}
    >
      <Checkbox checked={checked} style={{ position: 'absolute', top: 6, left: 6 }} />
      {src ? (
        <img
          src={src}
          alt={image.originalName}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      ) : (
        <Spin size="small" />
      )}
    </div>
  );
}
