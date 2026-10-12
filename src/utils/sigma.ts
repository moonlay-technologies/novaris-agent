import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { SigmaRule, SigmaSelection } from '../types/sigma';
import { getLogger } from './logger';

const STRING_MODIFIERS = ['contains', 'startswith', 'endswith', 're'] as const;
type StringModifier = (typeof STRING_MODIFIERS)[number];

let cachedRules: SigmaRule[] | null = null;

/**
 * Loads every `.yml`/`.yaml` file in `dir` as a Sigma rule. Invalid files are
 * logged and skipped rather than aborting the whole load - one bad rule file
 * shouldn't take detection offline entirely. Cached after the first call.
 */
export function loadSigmaRules(dir: string): SigmaRule[] {
  if (cachedRules) {
    return cachedRules;
  }

  const logger = getLogger();
  const rules: SigmaRule[] = [];

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
  } catch (error: any) {
    logger.warn('Failed to read Sigma rules directory', { dir, error: error?.message || error });
    cachedRules = [];
    return cachedRules;
  }

  for (const fileName of entries) {
    const filePath = path.join(dir, fileName);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(content) as Record<string, any>;

      // Sigma's `condition` lives *inside* the `detection` block as a sibling
      // of the named selections, e.g. `detection: { selection: {...}, condition: "selection" }`.
      const rawDetection: Record<string, any> | undefined = parsed?.detection;
      const condition: string | undefined = rawDetection?.condition;

      if (!parsed?.id || !rawDetection || typeof condition !== 'string') {
        logger.warn('Skipping invalid Sigma rule (missing id/detection/condition)', { filePath });
        continue;
      }

      const selections: Record<string, SigmaSelection> = {};
      for (const key of Object.keys(rawDetection)) {
        if (key !== 'condition') {
          selections[key] = rawDetection[key];
        }
      }

      rules.push({
        id: parsed.id,
        title: parsed.title || parsed.id,
        level: parsed.level || 'medium',
        logsource: parsed.logsource || {},
        event_type: parsed.event_type || parsed.id,
        detection: selections,
        condition,
      });
    } catch (error: any) {
      logger.warn('Failed to parse Sigma rule file', { filePath, error: error?.message || error });
    }
  }

  cachedRules = rules;
  return cachedRules;
}

function matchesValue(fieldValue: string, modifier: StringModifier | null, target: string): boolean {
  switch (modifier) {
    case 'contains':
      return fieldValue.toLowerCase().includes(target.toLowerCase());
    case 'startswith':
      return fieldValue.toLowerCase().startsWith(target.toLowerCase());
    case 'endswith':
      return fieldValue.toLowerCase().endsWith(target.toLowerCase());
    case 're':
      try {
        return new RegExp(target, 'i').test(fieldValue);
      } catch {
        return false;
      }
    default:
      return fieldValue.toLowerCase() === target.toLowerCase();
  }
}

function evaluateSelection(selection: SigmaSelection, fields: Record<string, string>): boolean {
  for (const key of Object.keys(selection)) {
    const parts = key.split('|');
    const fieldName = parts[0];
    const modifier = (parts.find((p) => (STRING_MODIFIERS as readonly string[]).includes(p)) as StringModifier | undefined) || null;
    const requireAll = parts.includes('all');

    const fieldValue = fields[fieldName] ?? '';
    const rawValue = selection[key];
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];

    const matches = values.map((value) => matchesValue(fieldValue, modifier, value));
    const keyMatches = requireAll ? matches.every(Boolean) : matches.some(Boolean);

    // Every key within a selection must match (AND) for the selection itself to match.
    if (!keyMatches) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluates a condition string made of selection names joined by `and`/`or`,
 * with an optional leading `not` per term (e.g. "selection", "not selection",
 * "selection_a or selection_b"). No parentheses or "1 of"/"all of" support -
 * not needed by any rule this engine ships with, and not worth a full
 * boolean-expression parser for this scope.
 */
function evaluateCondition(condition: string, detection: Record<string, SigmaSelection>, fields: Record<string, string>): boolean {
  const tokens = condition.trim().split(/\s+/).filter(Boolean);
  let result: boolean | null = null;
  let pendingOp: 'and' | 'or' | null = null;
  let negateNext = false;

  for (const rawToken of tokens) {
    const token = rawToken.toLowerCase();

    if (token === 'not') {
      negateNext = true;
      continue;
    }
    if (token === 'and' || token === 'or') {
      pendingOp = token;
      continue;
    }

    const selection = detection[rawToken];
    let value = selection ? evaluateSelection(selection, fields) : false;
    if (negateNext) {
      value = !value;
      negateNext = false;
    }

    if (result === null) {
      result = value;
    } else if (pendingOp === 'and') {
      result = result && value;
    } else if (pendingOp === 'or') {
      result = result || value;
    }
    pendingOp = null;
  }

  return result ?? false;
}

export function evaluateSigmaRule(rule: SigmaRule, fields: Record<string, string>): boolean {
  return evaluateCondition(rule.condition, rule.detection, fields);
}
