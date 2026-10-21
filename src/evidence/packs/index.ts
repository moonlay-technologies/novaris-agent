import { AnyEvidencePack } from '../evidencePack';
import { IdentityPack } from './identityPack';

/** Category packs in report order. The agent pack is added by EvidenceCollector itself. */
export function createEvidencePacks(): AnyEvidencePack[] {
  return [new IdentityPack()];
}
