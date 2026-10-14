import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { getLogger } from '../../dist/utils/logger';
import { InstallTokenStore } from '../agentRuntime/installTokenStore';

/** The signed-in Novaris user, as much of it as the renderer may see. */
export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: string;
  clientId: number;
  branchId: number | null;
  mustChangePassword: boolean;
}

export interface UserSessionStatus {
  signedIn: boolean;
  user: SessionUser | null;
  expiresAt: string | null;
}

interface StoredSession {
  token: string;
  user: SessionUser;
}

export class SessionExpiredError extends Error {
  constructor(message = 'Your session has expired. Sign in again.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/** Refresh the JWT once less than this much of its lifetime is left. */
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Signs a Novaris user in on this device and makes authenticated calls on
 * their behalf. Lives in the main process: the JWT is kept encrypted with the
 * OS keychain and never reaches the renderer, which only sees the user's
 * profile through status().
 */
export class UserSessionService {
  private session: StoredSession | null = null;
  private refreshing: Promise<string> | null = null;
  private listeners: Array<(status: UserSessionStatus) => void> = [];
  private logger = getLogger();

  constructor(
    private readonly store: InstallTokenStore,
    private readonly getApiUrl: () => string | undefined
  ) {}

  onChange(listener: (status: UserSessionStatus) => void): void {
    this.listeners.push(listener);
  }

  status(): UserSessionStatus {
    if (!this.session) {
      return { signedIn: false, user: null, expiresAt: null };
    }
    const expiry = tokenExpiry(this.session.token);
    return {
      signedIn: true,
      user: { ...this.session.user },
      expiresAt: expiry ? new Date(expiry).toISOString() : null,
    };
  }

  /** Restores the session saved by a previous run, dropping it if the token has expired. */
  restore(): UserSessionStatus {
    const raw = this.store.load();
    if (!raw) {
      return this.status();
    }
    try {
      const stored = JSON.parse(raw) as StoredSession;
      if (!stored.token || !stored.user || isExpired(stored.token)) {
        this.store.clear();
        return this.status();
      }
      this.session = stored;
      this.logger.info('Restored user session', { userId: stored.user.id });
      // The window may already be showing the signed-out state.
      this.emit();
    } catch {
      this.store.clear();
    }
    return this.status();
  }

  async login(email: string, password: string): Promise<UserSessionStatus> {
    const response = await axios.post(
      `${this.apiUrl()}/auth/login`,
      { email, password },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const data = response.data?.data ?? response.data;
    if (typeof data?.token !== 'string' || !data.user) {
      throw new Error('Unexpected sign-in response from the backend');
    }
    this.setSession({ token: data.token, user: toSessionUser(data.user) });
    this.logger.info('User signed in', { userId: this.session?.user.id });
    return this.status();
  }

  logout(): UserSessionStatus {
    if (this.session) {
      this.logger.info('User signed out', { userId: this.session.user.id });
    }
    this.session = null;
    this.store.clear();
    this.emit();
    return this.status();
  }

  async changePassword(currentPassword: string, newPassword: string, confirmation: string): Promise<UserSessionStatus> {
    const user = this.requireSession().user;
    await this.request({
      method: 'PUT',
      url: `/users/${user.id}/password`,
      data: { current_password: currentPassword, new_password: newPassword, password_confirmation: confirmation },
    });
    this.setSession({ ...this.requireSession(), user: { ...user, mustChangePassword: false } });
    return this.status();
  }

  /**
   * A valid JWT for the signed-in user, refreshed when close to expiry.
   * Also handed to the local assistant runtime for the backend AI proxy.
   */
  async getToken(): Promise<string> {
    const session = this.requireSession();
    const expiry = tokenExpiry(session.token);
    if (expiry === null || expiry - Date.now() > REFRESH_WINDOW_MS) {
      return session.token;
    }
    if (expiry <= Date.now()) {
      this.logout();
      throw new SessionExpiredError();
    }
    this.refreshing ??= this.refresh(session.token).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Calls the backend API as the signed-in user. A 401 ends the session. */
  async request<T = unknown>(config: AxiosRequestConfig): Promise<T> {
    const token = await this.getToken();
    try {
      const response = await axios.request({
        baseURL: this.apiUrl(),
        timeout: REQUEST_TIMEOUT_MS,
        ...config,
        headers: { ...config.headers, Authorization: `Bearer ${token}` },
      });
      return response.data as T;
    } catch (error) {
      if ((error as AxiosError).response?.status === 401) {
        this.logout();
        throw new SessionExpiredError();
      }
      throw error;
    }
  }

  private async refresh(token: string): Promise<string> {
    try {
      const response = await axios.post(
        `${this.apiUrl()}/auth/refresh-token`,
        { token },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      const next = response.data?.data?.token ?? response.data?.token;
      if (typeof next !== 'string') {
        throw new Error('Unexpected refresh response from the backend');
      }
      this.setSession({ ...this.requireSession(), token: next });
      return next;
    } catch (error) {
      if ((error as AxiosError).response?.status === 401) {
        this.logout();
        throw new SessionExpiredError();
      }
      // Offline or backend hiccup: the current token is still valid for a while.
      this.logger.warn('Session refresh failed, keeping current token', { error: (error as Error).message });
      return token;
    }
  }

  private setSession(session: StoredSession): void {
    this.session = session;
    if (!this.store.save(JSON.stringify(session))) {
      this.logger.warn('OS encryption unavailable; the session will not survive a restart');
    }
    this.emit();
  }

  private requireSession(): StoredSession {
    if (!this.session) {
      throw new SessionExpiredError('Sign in to continue.');
    }
    return this.session;
  }

  private apiUrl(): string {
    const apiUrl = this.getApiUrl()?.replace(/\/+$/, '');
    if (!apiUrl) {
      throw new Error('Configure the backend API URL in Settings before signing in');
    }
    return apiUrl;
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        this.logger.warn('User session listener failed', { error });
      }
    }
  }
}

function toSessionUser(user: Record<string, any>): SessionUser {
  return {
    id: Number(user.id),
    name: String(user.name ?? ''),
    email: String(user.email ?? ''),
    role: String(user.role ?? ''),
    clientId: Number(user.client_id ?? user.clientId),
    branchId: user.branch_id ?? user.branchId ?? null,
    mustChangePassword: Boolean(user.must_change_password ?? user.mustChangePassword),
  };
}

/** Expiry of a JWT in epoch ms, or null if it carries none. The signature is the backend's concern. */
function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpired(token: string): boolean {
  const expiry = tokenExpiry(token);
  return expiry !== null && expiry <= Date.now();
}
