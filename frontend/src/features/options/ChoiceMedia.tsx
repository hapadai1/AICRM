/** 옵션 선택지 이미지 — 등록 이미지가 있으면 사진, 없으면 색상 블록으로 폴백한다. */
import { useQuery } from '@tanstack/react-query';
import { Image, Typography } from 'antd';
import { fetchFileObjectUrl } from '../../api/client';
import type { OptionChoiceView } from '../../api/options';
import { choiceColor, photoFrameStyle } from './option-meta';

export function ChoiceMedia({
  choice,
  maxHeight,
  fallbackHeight = 360,
}: {
  choice: OptionChoiceView;
  maxHeight: string;
  /** 이미지가 없을 때 색상 블록 높이. 팝업처럼 좁은 곳은 줄여 쓴다. */
  fallbackHeight?: number;
}) {
  const { data: src } = useQuery({
    queryKey: ['file-object-url', choice.imageUrl],
    queryFn: () => fetchFileObjectUrl(choice.imageUrl!),
    enabled: !!choice.imageUrl,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });

  if (choice.imageUrl && src) {
    return (
      <div style={photoFrameStyle()}>
        {/* 카드 전체가 '눌러 선택' 대상이므로 preview는 끄고 클릭이 카드로 전파되게 둔다. */}
        {/* 폭을 100%로 늘리지 않고 원본 크기로 둔다 — 늘리면 흐려져서 카라 벌림·커프스 모서리
            같은 미세한 차이가 뭉갠다. 칸이 좁을 때만 줄어들고, 세로로 긴 사진이 화면을
            넘기지 않도록 높이 상한만 둔다. */}
        <Image
          src={src}
          alt={choice.name}
          wrapperStyle={{ display: 'block', textAlign: 'center' }}
          style={{ maxWidth: '100%', maxHeight, height: 'auto', objectFit: 'contain' }}
          preview={false}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        height: fallbackHeight,
        borderRadius: 8,
        background: choiceColor(choice.choiceId),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Typography.Title
        level={3}
        style={{ color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.4)', margin: 0 }}
      >
        {choice.name}
      </Typography.Title>
    </div>
  );
}
