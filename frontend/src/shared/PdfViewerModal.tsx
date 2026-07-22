import { Modal } from 'antd';

/**
 * 범용 PDF 뷰어 모달.
 * 임의의 PDF URL을 iframe으로 렌더한다. (원단 가격표 등)
 * 실제 문서 URL은 호출부에서 전달한다 — 여기서는 표시만 담당한다.
 */

interface Props {
  open: boolean;
  url: string;
  title?: string;
  onClose: () => void;
}

export function PdfViewerModal({ open, url, title = 'PDF 미리보기', onClose }: Props) {
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={null}
      width="80vw"
      style={{ top: 24 }}
      styles={{ body: { padding: 0, height: '80vh' } }}
      destroyOnClose
    >
      <iframe
        src={url}
        title={title}
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
    </Modal>
  );
}
