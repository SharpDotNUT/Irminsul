import { readFileSync } from "node:fs";

export type RuleGroup = {
  description: string;
  patterns: string[];
};

export type RuleSet = {
  groups: Record<string, RuleGroup>;
  default: string[];
};

export const rules: RuleSet = JSON.parse(
  readFileSync(new URL("./rules.json", import.meta.url), "utf8"),
) as RuleSet;

/** Ordered, de-duplicated regex list for the named groups; validates unknown names. */
export function patternsForGroups(names: string[]): string[] {
  const patterns: string[] = [];
  for (const name of names) {
    const group = rules.groups[name];
    if (!group) {
      throw new Error(
        `未知规则组 "${name}"，可用: ${Object.keys(rules.groups).join(", ")}`,
      );
    }
    for (const pattern of group.patterns) {
      if (!patterns.includes(pattern)) patterns.push(pattern);
    }
  }
  return patterns;
}
