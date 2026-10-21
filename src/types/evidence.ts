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

// --- patch ------------------------------------------------------------------

export type PackageManager = 'wua' | 'apt' | 'dnf' | 'yum' | 'zypper' | 'softwareupdate';

export interface PatchUpdatesValue {
  pending_total: number;
  pending_security: number;
  oldest_pending_security_days: number | null;
  /** Last SUCCESSFUL query of the update source, not the agent run time. */
  last_scan_at: string | null;
  last_installed_at: string | null;
  package_manager: PackageManager;
}

export interface PatchRebootValue {
  reboot_pending: boolean;
  uptime_seconds: number;
}

export interface PatchItems {
  updates: EvidenceItem<PatchUpdatesValue>;
  reboot: EvidenceItem<PatchRebootValue>;
}

// --- protection -------------------------------------------------------------

export interface AntimalwareProduct {
  name: string;
  /** builtin = OS protection that is not a separate product (macOS XProtect). */
  kind: 'av' | 'edr' | 'builtin';
  realtime_enabled: boolean | null;
  signatures_up_to_date?: boolean | null;
  signature_age_days?: number | null;
  tamper_protected?: boolean | null;
}

export interface AntimalwareValue {
  products: AntimalwareProduct[];
  gatekeeper_enabled: boolean | null;
}

export interface ProtectionItems {
  antimalware: EvidenceItem<AntimalwareValue>;
}

// --- encryption -------------------------------------------------------------

export interface SystemVolumeValue {
  volume: string;
  encrypted: boolean;
  method: string | null;
  protection_on: boolean | null;
}

export interface OtherVolumesValue {
  total: number;
  encrypted: number;
}

export interface EncryptionItems {
  system_volume: EvidenceItem<SystemVolumeValue>;
  other_volumes?: EvidenceItem<OtherVolumesValue>;
}

// --- access -----------------------------------------------------------------

export interface AdminMember {
  name: string;
  type: 'user' | 'group' | 'unknown';
  scope: 'local' | 'domain' | 'unknown';
  enabled?: boolean | null;
}

export interface LocalAdminsValue {
  members: AdminMember[];
  count: number;
}

export interface ScreenLockValue {
  enabled: boolean;
  timeout_seconds: number | null;
  password_on_wake?: boolean | null;
  scope: 'machine_policy' | 'console_user';
}

export interface DefaultAccountsValue {
  guest_enabled: boolean | null;
  builtin_admin_enabled?: boolean | null;
}

export interface AccessItems {
  local_admins: EvidenceItem<LocalAdminsValue>;
  screen_lock: EvidenceItem<ScreenLockValue>;
  default_accounts?: EvidenceItem<DefaultAccountsValue>;
}

// --- exposure ---------------------------------------------------------------

export type FirewallProduct = 'windows_firewall' | 'macos_alf' | 'ufw' | 'firewalld' | 'nftables' | 'iptables' | 'none';

export interface FirewallValue {
  product: FirewallProduct;
  profiles: Array<{ name: 'domain' | 'private' | 'public' | 'global'; enabled: boolean }>;
}

export interface RemoteAccessValue {
  rdp_enabled?: boolean | null;
  rdp_nla_required?: boolean | null;
  ssh_server_enabled?: boolean | null;
  screen_sharing_enabled?: boolean | null;
}

export interface ListeningPort {
  protocol: 'tcp' | 'udp';
  port: number;
  bind_scope: 'any' | 'loopback' | 'specific';
  /** Executable name only, never the command line. */
  process_name?: string | null;
}

export interface ExposureItems {
  firewall: EvidenceItem<FirewallValue>;
  remote_access?: EvidenceItem<RemoteAccessValue>;
  listening_ports?: EvidenceItem<{ ports: ListeningPort[] }>;
}

// --- software ---------------------------------------------------------------

export interface SoftwareInventoryValue {
  item_count: number;
  /** sha256 of the sorted "name|version" lines. */
  inventory_hash: string;
  last_synced_at: string | null;
}

export interface SoftwareItems {
  inventory: EvidenceItem<SoftwareInventoryValue>;
}

// --- hardening --------------------------------------------------------------

export interface SecureBootValue {
  supported: boolean | null;
  enabled: boolean | null;
}

export interface TpmValue {
  present: boolean;
  ready: boolean | null;
  version?: string | null;
}

export type BaselineSettings = Record<string, boolean | number | string | null>;

export interface HardeningItems {
  secure_boot?: EvidenceItem<SecureBootValue>;
  tpm?: EvidenceItem<TpmValue>;
  baseline?: EvidenceItem<{ settings: BaselineSettings }>;
}

// --- audit ------------------------------------------------------------------

export interface AuditCategorySetting {
  id: string;
  success: boolean;
  failure: boolean;
}

export interface AuditLoggingValue {
  service: 'windows_eventlog' | 'auditd' | 'journald' | 'macos_unified_log';
  service_running: boolean;
  security_log_max_mb?: number | null;
  categories?: AuditCategorySetting[] | null;
}

export interface AuditItems {
  logging?: EvidenceItem<AuditLoggingValue>;
  time_sync?: EvidenceItem<{ enabled: boolean; service?: string | null }>;
}

// --- envelope ---------------------------------------------------------------

/** Item map of every category. */
export interface EvidenceItemsByCategory {
  identity: IdentityItems;
  patch: PatchItems;
  protection: ProtectionItems;
  encryption: EncryptionItems;
  access: AccessItems;
  exposure: ExposureItems;
  software: SoftwareItems;
  hardening: HardeningItems;
  audit: AuditItems;
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
