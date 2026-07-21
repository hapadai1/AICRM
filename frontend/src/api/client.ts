import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../app/auth-store';

/** 백엔드 오류 envelope를 표준화한 오류 객체 */
export class ApiError extends Error {
  code: string;
  fieldErrors?: Record<string, string>;

  constructor(code: string, message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

/** 목록 응답: envelope 언랩 후 { data, page } 형태 유지 */
export interface ListResult<T> {
  data: T[];
  page: {
    /** 백엔드 envelope 키는 number (response.interceptor.ts) */
    number: number;
    size: number;
    totalElements: number;
    totalPages: number;
  };
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    fieldErrors?: Record<string, string>;
  };
}

type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean };

export const api = axios.create({
  baseURL: '/api/v1',
});

// 요청 인터셉터: accessToken 첨부
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

function redirectToLogin(): void {
  useAuthStore.getState().clear();
  const current = window.location.pathname + window.location.search;
  const redirect = current && current !== '/login' ? `?redirect=${encodeURIComponent(current)}` : '';
  window.location.href = `/login${redirect}`;
}

// 동시 401에 대비해 refresh 요청을 단일화한다.
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = useAuthStore.getState().refreshToken;
      if (!refreshToken) {
        throw new ApiError('NO_REFRESH_TOKEN', '로그인이 필요합니다.');
      }
      // 인터셉터 재귀를 피하기 위해 순수 axios 사용
      const res = await axios.post('/api/v1/auth/refresh', { refreshToken });
      const payload = res.data?.data ?? res.data;
      useAuthStore.getState().setTokens({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
      });
      return payload.accessToken as string;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

// 응답 인터셉터: envelope 언랩 + 오류 변환 + 401 재시도
api.interceptors.response.use(
  (response) => {
    const body = response.data;
    if (body && typeof body === 'object' && 'data' in body) {
      // 목록 응답은 { data, page } 형태 유지 (totals 등 부가 필드도 그대로 전달)
      if ('page' in body) {
        const { meta: _meta, ...rest } = body as Record<string, unknown>;
        return rest as never;
      }
      return body.data;
    }
    return body;
  },
  async (error: AxiosError<ErrorEnvelope>) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;
    const isAuthPath =
      !!config?.url && (config.url.includes('/auth/login') || config.url.includes('/auth/refresh'));

    if (status === 401 && config && !config._retry && !isAuthPath) {
      config._retry = true;
      try {
        const newToken = await refreshAccessToken();
        config.headers.Authorization = `Bearer ${newToken}`;
        return api.request(config);
      } catch {
        redirectToLogin();
        return Promise.reject(new ApiError('UNAUTHORIZED', '인증이 만료되었습니다. 다시 로그인해 주세요.'));
      }
    }

    const envelope = error.response?.data?.error;
    if (envelope) {
      return Promise.reject(
        new ApiError(
          envelope.code ?? 'UNKNOWN_ERROR',
          envelope.message ?? '알 수 없는 오류가 발생했습니다.',
          envelope.fieldErrors,
        ),
      );
    }
    return Promise.reject(
      new ApiError('NETWORK_ERROR', error.message || '서버와 통신할 수 없습니다.'),
    );
  },
);

/**
 * 인터셉터가 envelope를 언랩하므로, 호출부에서 타입을 지정해 사용한다.
 * 예) const user = await request<AuthUser>({ url: '/users/me' });
 */
export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  return api.request(config) as Promise<T>;
}

/**
 * 인증이 필요한 파일(옵션 이미지 등)을 blob으로 받아 object URL로 변환한다.
 * <img src>는 Authorization 헤더를 보내지 못하므로 화면에서 이 URL을 사용한다.
 * 호출부는 더 이상 필요 없을 때 URL.revokeObjectURL로 해제해야 한다.
 */
export async function fetchFileObjectUrl(path: string): Promise<string> {
  const response = await api.request({ url: path, responseType: 'blob' });
  return URL.createObjectURL(response as unknown as Blob);
}
