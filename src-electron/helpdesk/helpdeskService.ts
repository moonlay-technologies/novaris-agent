import { AxiosRequestConfig } from 'axios';

/** Makes backend calls as the signed-in user; satisfied by UserSessionService. */
export interface UserRequester {
  request<T = unknown>(config: AxiosRequestConfig): Promise<T>;
}

export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
export type AccessRequestType = 'baru' | 'perubahan' | 'terminasi';

export interface NewTicket {
  title: string;
  description: string;
  priority?: TicketPriority;
}

export interface NewAssetRequest {
  category_id: number;
  title: string;
  justification: string;
  quantity?: number;
  needed_by?: string;
}

export interface NewAccessRequest {
  license_id: number;
  request_type: AccessRequestType;
  access_level_requested: string;
  business_justification: string;
  access_start_date: string;
  access_end_date?: string | null;
  direct_supervisor_name: string;
  direct_supervisor_title: string;
  notes?: string | null;
}

const PRIORITIES: readonly string[] = ['low', 'medium', 'high', 'urgent'];
const STATUSES: readonly string[] = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];
const REQUEST_TYPES: readonly string[] = ['baru', 'perubahan', 'terminasi'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Self-service helpdesk for the signed-in user: tickets, access requests and
 * asset requests through the backend's `/me/*` routes. The backend files each
 * request as the user; this class only shapes and sanity-checks what the
 * renderer sends before it leaves the device.
 */
export class HelpdeskService {
  constructor(private readonly session: UserRequester) {}

  async listTickets(status?: unknown): Promise<unknown[]> {
    const params = typeof status === 'string' && STATUSES.includes(status) ? { status } : undefined;
    return this.data(await this.session.request({ method: 'GET', url: '/me/tickets', params }));
  }

  async createTicket(input: unknown): Promise<unknown> {
    const body = record(input);
    const ticket: NewTicket = {
      title: text(body.title, 'Title', 255),
      description: text(body.description, 'Description'),
    };
    if (body.priority !== undefined && body.priority !== '') {
      ticket.priority = oneOf(body.priority, PRIORITIES, 'Priority') as TicketPriority;
    }
    return this.data(await this.session.request({ method: 'POST', url: '/me/tickets', data: ticket }));
  }

  async listAssetCategories(): Promise<unknown[]> {
    return this.data(await this.session.request({ method: 'GET', url: '/me/asset-categories' }));
  }

  async requestAsset(input: unknown): Promise<unknown> {
    const body = record(input);
    const request: NewAssetRequest = {
      category_id: id(body.category_id, 'Category'),
      title: text(body.title, 'Title', 255),
      justification: text(body.justification, 'Justification'),
    };
    if (body.quantity !== undefined && body.quantity !== '') {
      request.quantity = id(body.quantity, 'Quantity');
    }
    if (body.needed_by) {
      request.needed_by = date(body.needed_by, 'Needed by');
    }
    return this.data(await this.session.request({ method: 'POST', url: '/me/asset-requests', data: request }));
  }

  async listAccessSystems(): Promise<unknown[]> {
    return this.data(await this.session.request({ method: 'GET', url: '/me/access-systems' }));
  }

  async requestAccess(input: unknown): Promise<unknown> {
    const body = record(input);
    const request: NewAccessRequest = {
      license_id: id(body.license_id, 'System'),
      request_type: oneOf(body.request_type, REQUEST_TYPES, 'Request type') as AccessRequestType,
      access_level_requested: text(body.access_level_requested, 'Access level'),
      business_justification: text(body.business_justification, 'Business justification'),
      access_start_date: date(body.access_start_date, 'Start date'),
      direct_supervisor_name: text(body.direct_supervisor_name, 'Supervisor name', 255),
      direct_supervisor_title: text(body.direct_supervisor_title, 'Supervisor title', 255),
    };
    if (body.access_end_date) {
      request.access_end_date = date(body.access_end_date, 'End date');
    }
    if (typeof body.notes === 'string' && body.notes.trim()) {
      request.notes = text(body.notes, 'Notes', 5000);
    }
    return this.data(await this.session.request({ method: 'POST', url: '/me/access-requests', data: request }));
  }

  private data<T>(response: unknown): T {
    return (response as { data?: T })?.data as T;
  }
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid request');
  }
  return input as Record<string, unknown>;
}

function text(value: unknown, label: string, max?: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`${label} is required`);
  if (max && trimmed.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return trimmed;
}

function id(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} is required`);
  return n;
}

function oneOf(value: unknown, allowed: readonly string[], label: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label} is invalid`);
  return value;
}

function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error(`${label} must be a date`);
  return value;
}
