import { Injectable } from '@nestjs/common';

export interface MessageSendRequest {
  channel: string; // ALIMTALK / SMS
  recipientPhone: string;
  body: string;
  templateCode?: string;
}

export interface MessageSendResult {
  success: boolean;
  vendorMessageId?: string;
  errorMessage?: string;
}

/**
 * 외부 메시지 벤더(알림톡/SMS) 연동 인터페이스 (구현표준 1.1 adapters 격리).
 * 실제 벤더 연동은 Phase 이후 교체하고, MVP는 스텁 구현을 사용한다.
 */
export interface MessageVendorAdapter {
  send(request: MessageSendRequest): Promise<MessageSendResult>;
}

export const MESSAGE_VENDOR_ADAPTER = 'MESSAGE_VENDOR_ADAPTER';

const digitsOnly = (phone: string) => phone.replace(/\D/g, '');

/**
 * 스텁 구현: 외부 호출 없이 성공 처리한다.
 * 단, DEMO_ALIMTALK_FAIL_PHONES에 등록된 번호는 알림톡만 실패시켜
 * SMS 대체 발송 흐름을 시연할 수 있게 한다(SMS는 항상 성공).
 */
@Injectable()
export class StubMessageVendorAdapter implements MessageVendorAdapter {
  private readonly alimtalkFailPhones = new Set(
    (process.env.DEMO_ALIMTALK_FAIL_PHONES ?? '')
      .split(',')
      .map((p) => digitsOnly(p))
      .filter(Boolean),
  );

  async send(request: MessageSendRequest): Promise<MessageSendResult> {
    if (
      request.channel === 'ALIMTALK' &&
      this.alimtalkFailPhones.has(digitsOnly(request.recipientPhone))
    ) {
      return { success: false, errorMessage: '알림톡 수신 동의가 없는 번호입니다.' };
    }
    return { success: true, vendorMessageId: `stub-${Date.now()}-${request.recipientPhone}` };
  }
}
