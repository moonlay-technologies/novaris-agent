export interface YaraMatch {
  ruleName: string;
  targetFile: string;
  tags: string[];
  meta: Record<string, unknown>;
}
