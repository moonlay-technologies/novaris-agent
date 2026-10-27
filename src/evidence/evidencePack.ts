import { CommandRunner } from '../utils/commandRunner';
import { FileReader } from '../utils/fileReader';
import { OsqueryClient } from '../utils/osquery';
import { EvidenceItemsByCategory, EvidencePlatform, ImplementedCategoryId, RunMode } from '../types/evidence';

/** What a pack may use to collect evidence. Everything is injectable for tests. */
export interface EvidenceContext {
  platform: EvidencePlatform;
  runMode: RunMode;
  elevated: boolean;
  runner: CommandRunner;
  osquery: OsqueryClient;
  files: FileReader;
  now: () => Date;
  uptimeSeconds: () => number;
}

/**
 * Collects the evidence items of one category. A pack never throws for an
 * individual probe: it reports the probe's status in the item instead.
 */
export interface EvidencePack<C extends ImplementedCategoryId = ImplementedCategoryId> {
  readonly category: C;
  collect(context: EvidenceContext): Promise<EvidenceItemsByCategory[C]>;
}

/** A pack for any implemented category. */
export type AnyEvidencePack = { [C in ImplementedCategoryId]: EvidencePack<C> }[ImplementedCategoryId];
