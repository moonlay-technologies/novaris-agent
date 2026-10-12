export type SigmaLevel = 'informational' | 'low' | 'medium' | 'high' | 'critical';

/**
 * A single named selection within a rule's `detection` block: field names
 * (optionally suffixed with a modifier, e.g. `message|contains`) mapped to
 * one value or a list of values. List values are OR'd together by default;
 * suffixing the modifier with `|all` (e.g. `message|contains|all`) requires
 * every value in the list to match instead.
 */
export type SigmaSelection = Record<string, string | string[]>;

export interface SigmaRule {
  id: string;
  title: string;
  level: SigmaLevel;
  logsource: Record<string, string>;
  /**
   * Custom (non-core-Sigma) field carrying the stable machine-readable
   * classification stored downstream (`SecurityEvent.eventType`, the backend's
   * `device_security_events.event_type` column, existing dashboard filters).
   * Not part of the Sigma spec proper, but additive custom fields are a normal
   * pattern in real-world Sigma rules (alongside e.g. `references`/`fields`).
   * Falls back to `id` if a rule omits it, so plain third-party Sigma rules
   * still produce *something* usable.
   */
  event_type?: string;
  /** Named selections referenced by `condition`. */
  detection: Record<string, SigmaSelection>;
  /** e.g. "selection", "selection_a or selection_b", "not selection". */
  condition: string;
}
