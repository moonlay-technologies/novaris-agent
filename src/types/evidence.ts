/**
 * Endpoint compliance evidence (schema_version 1).
 *
 * Wire format of POST /devices/:id/evidence, defined by
 * novaris-backend/docs/03-modules/endpoint-compliance/evidence.schema.json.
 * Field names are snake_case on purpose so the objects are sent as-is: the
 * agent reports facts with a collection status, never PASS/FAIL verdicts.
 */

export type EvidencePlatform = 'windows' | 'macos' | 'linux';

export type EvidenceCategoryId =
  | 'identity'
  | 'patch'
  | 'protection'
  | 'encryption'
  | 'access'
  | 'exposure'
  | 'software'
  | 'hardening'
  | 'audit'
  | 'agent';

export type EvidenceItemStatus = 'ok' | 'unknown' | 'error' | 'not_applicable';

export type EvidenceReason =
  | 'insufficient_privilege'
  | 'tool_unavailable'
  | 'timeout'
  | 'command_failed'
  | 'parse_error'
  | 'unsupported_platform'
  | 'not_configured'
  | 'not_detected';

export type EvidenceItem<T> =
  | { status: 'ok'; reason: null; source: string; error: null; value: T }
  | { status: Exclude<EvidenceItemStatus, 'ok'>; reason: EvidenceReason; source: string; error: string | null; value: null };

export type RunMode = 'service' | 'desktop';

// --- identity ---------------------------------------------------------------

export interface IdentityDeviceValue {
  hostname: string;
  serial_number: string | null;
  manufacturer: string | null;
  model: string | null;
  os_family: EvidencePlatform;
  os_name: string;
  os_version: string;
  os_build: string | null;
  os_edition: string | null;
  arch: string | null;
  primary_ip: string | null;
  primary_mac: string | null;
}

export type JoinType = 'none' | 'domain' | 'entra' | 'hybrid' | 'realm' | 'unknown';

export interface IdentityManagementValue {
  join_type: JoinType;
  mdm_enrolled: boolean | null;
  mdm_server: string | null;
}

export interface IdentityItems {
  device: EvidenceItem<IdentityDeviceValue>;
  management?: EvidenceItem<IdentityManagementValue>;
}

// --- agent ------------------------------------------------------------------

/** Categories reported in agent.health.collectors (every category except agent itself). */
export type CollectedCategoryId = Exclude<EvidenceCategoryId, 'agent'>;

export interface CollectorHealth {
  category: CollectedCategoryId;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
}

export interface AgentHealthValue {
  run_mode: RunMode;
  elevated: boolean;
  osquery_available: boolean;
  osquery_version: string | null;
  config_hash: string | null;
  collectors: CollectorHealth[];
}

export interface AgentItems {
  health: EvidenceItem<AgentHealthValue>;
}

// --- envelope ---------------------------------------------------------------

/**
 * Item maps per category. Categories added in later tasks (patch, protection, ...)
 * extend this map; until then they are simply not sent.
 */
export interface EvidenceItemsByCategory {
  identity: IdentityItems;
  agent: AgentItems;
}

export type ImplementedCategoryId = keyof EvidenceItemsByCategory;

export interface EvidenceCategoryPayload<C extends ImplementedCategoryId = ImplementedCategoryId> {
  category: C;
  collected_at: string;
  items: EvidenceItemsByCategory[C];
}

export interface EvidenceEnvelope {
  schema_version: 1;
  agent_version: string;
  platform: EvidencePlatform;
  run_mode: RunMode;
  elevated: boolean;
  sent_at: string;
  categories: EvidenceCategoryPayload[];
}
