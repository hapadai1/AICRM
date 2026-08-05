/**
 * 채촌 사진 갤러리 (설계서 v2 05 §4.3·§5) — 썸네일·선택·삭제·A4 인쇄.
 * 2026-08-05 MeasurementEditPage에서 분리 — 이미지 목록·선택 상태는 페이지가 갖는다.
 */
import { DeleteOutlined, PrinterOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Checkbox, Empty, Space, Spin, Typography } from 'antd';
import { fetchFileObjectUrl } from '../../api/client';
import type { MeasurementImage } from '../../api/measurements';

export function MeasurementPhotoGallery({
  images,
  loading,
  selected,
  deletingFileId,
  onSelectAll,
  onToggle,
  onDelete,
  onPrint,
}: {
  images: MeasurementImage[];
  loading: boolean;
  selected: Set<string>;
  /** 삭제 진행 중인 fileId (그 썸네일 버튼만 스피너) */
  deletingFileId: string | null;
  onSelectAll: (checked: boolean) => void;
  onToggle: (fileId: string) => void;
  onDelete: (fileId: string) => void;
  onPrint: () => void;
}) {
  return (
    <Card
      size="small"
      title={`사진 (${images.length}/50)`}
      style={{ marginBottom: 16 }}
      extra={
        images.length > 0 && (
          <Space wrap>
            <Checkbox
              checked={selected.size === images.length}
              indeterminate={selected.size > 0 && selected.size < images.length}
              onChange={(e) => onSelectAll(e.target.checked)}
            >
              전체 선택
            </Checkbox>
            <Button icon={<PrinterOutlined />} disabled={selected.size === 0} onClick={onPrint}>
              선택 인쇄 ({selected.size})
            </Button>
          </Space>
        )
      }
    >
      {loading ? (
        <Spin />
      ) : images.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="첨부된 사진이 없습니다." />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: 12,
          }}
        >
          {images.map((im) => (
            <MeasurementImageThumb
              key={im.fileId}
              image={im}
              checked={selected.has(im.fileId)}
              onToggle={() => onToggle(im.fileId)}
              onDelete={() => onDelete(im.fileId)}
              deleting={deletingFileId === im.fileId}
            />
          ))}
        </div>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        최대 50장까지 첨부할 수 있습니다. 인쇄할 사진을 선택해 A4 한 장으로 출력하세요.
      </Typography.Text>
    </Card>
  );
}

/**
 * 갤러리 썸네일 — 선택 체크박스·삭제 버튼.
 * 인증이 필요한 파일이라 <img>가 헤더를 못 보내므로 blob(objectURL)로 로드한다.
 */
function MeasurementImageThumb({
  image,
  checked,
  onToggle,
  onDelete,
  deleting,
}: {
  image: MeasurementImage;
  checked: boolean;
  onToggle: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { data: src } = useQuery({
    queryKey: ['file-object-url', image.fileId],
    queryFn: () => fetchFileObjectUrl(`/files/${image.fileId}`),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });
  return (
    <div
      style={{
        position: 'relative',
        border: checked ? '2px solid #1677ff' : '1px solid #d9d9d9',
        borderRadius: 8,
        height: 120,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#fafafa',
        overflow: 'hidden',
      }}
    >
      <Checkbox
        checked={checked}
        onChange={onToggle}
        style={{ position: 'absolute', top: 6, left: 6, zIndex: 1 }}
      />
      <Button
        size="small"
        danger
        icon={<DeleteOutlined />}
        loading={deleting}
        onClick={onDelete}
        style={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}
      />
      {src ? (
        <img
          src={src}
          alt={image.originalName}
          onClick={onToggle}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'pointer' }}
        />
      ) : (
        <Spin size="small" />
      )}
    </div>
  );
}
