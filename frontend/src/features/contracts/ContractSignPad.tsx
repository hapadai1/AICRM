import { ClearOutlined, SaveOutlined } from '@ant-design/icons';
import { App, Button, Flex, Input, Space, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 계약 전자서명 캔버스 (설계서 v2 03 §4).
 *
 * 자체 `<canvas>` + Pointer Events 로 손글씨 서명을 받는다(의존성 0, self-contained).
 * - 고DPI 대응: devicePixelRatio 로 실제 픽셀을 스케일해 선명하게 그린다.
 * - 흰 배경 PNG: 투명 배경은 엑셀 앵커에서 보이지 않을 수 있어 흰색으로 채운다.
 * - 펜 두께 고정, `toDataURL('image/png')` 로 캡처.
 *
 * 버튼: [다시](로컬 초기화) · [취소] · [서명 저장]. 획이 있는데 저장 없이 [취소]하면 이탈 경고.
 * 부모는 이 컴포넌트를 Modal 안에 `destroyOnClose` 로 렌더해 열 때마다 새로 마운트하는 것을 권장한다.
 */

const CANVAS_HEIGHT = 240;
const PEN_WIDTH = 2.5;

interface ContractSignPadProps {
  /** 서명자 기본값(고객명). 편집 가능. */
  defaultSignerName?: string;
  /** [서명 저장] — data:image/png;base64,... 와 서명자명을 넘긴다. */
  onSave: (imageDataUrl: string, signerName: string) => void;
  onCancel: () => void;
  saving?: boolean;
}

export function ContractSignPad({ defaultSignerName, onSave, onCancel, saving }: ContractSignPadProps) {
  const { modal } = App.useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [hasStroke, setHasStroke] = useState(false);
  const [signerName, setSignerName] = useState(defaultSignerName ?? '');

  // 캔버스 초기화 — 흰 배경으로 채우고 펜 스타일을 지정한다.
  const resetCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.lineWidth = PEN_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1f1f1f';
  }, []);

  // 마운트 시 캔버스 픽셀 크기를 컨테이너에 맞추고(고DPI 스케일) 흰 배경을 깐다.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(CANVAS_HEIGHT * dpr);
    ctxRef.current = canvas.getContext('2d');
    resetCanvas();
  }, [resetCanvas]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastRef.current = pointFromEvent(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = ctxRef.current;
    const last = lastRef.current;
    if (!ctx || !last) return;
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    if (!hasStroke) setHasStroke(true);
  };

  const stopDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastRef.current = null;
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
  };

  const handleClear = () => {
    resetCanvas();
    setHasStroke(false);
  };

  const handleCancel = () => {
    if (!hasStroke) {
      onCancel();
      return;
    }
    modal.confirm({
      title: '서명 취소',
      content: '작성한 서명이 저장되지 않았습니다. 취소하면 사라집니다.',
      okText: '취소하고 닫기',
      okButtonProps: { danger: true },
      cancelText: '계속 서명',
      onOk: onCancel,
    });
  };

  const handleSave = () => {
    if (!hasStroke) return;
    if (!signerName.trim()) return;
    const dataUrl = canvasRef.current?.toDataURL('image/png');
    if (!dataUrl) return;
    onSave(dataUrl, signerName.trim());
  };

  return (
    <Flex vertical gap={12}>
      <Typography.Text type="secondary">
        아래 영역에 터치 또는 펜으로 서명해 주세요. 서명 후 [서명 저장]을 누르면 계약 확정이 가능합니다.
      </Typography.Text>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: CANVAS_HEIGHT,
          border: '1px solid #d9d9d9',
          borderRadius: 8,
          touchAction: 'none',
          cursor: 'crosshair',
          background: '#ffffff',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDrawing}
        onPointerLeave={stopDrawing}
        onPointerCancel={stopDrawing}
      />
      <Space>
        <Typography.Text strong>
          서명자 <Typography.Text type="danger">*</Typography.Text>
        </Typography.Text>
        <Input
          style={{ width: 220 }}
          value={signerName}
          maxLength={80}
          placeholder="서명자명"
          onChange={(e) => setSignerName(e.target.value)}
        />
      </Space>
      <Flex justify="space-between">
        <Button icon={<ClearOutlined />} onClick={handleClear} disabled={saving}>
          다시
        </Button>
        <Space>
          <Button onClick={handleCancel} disabled={saving}>
            취소
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!hasStroke || !signerName.trim()}
            onClick={handleSave}
          >
            서명 저장
          </Button>
        </Space>
      </Flex>
    </Flex>
  );
}
