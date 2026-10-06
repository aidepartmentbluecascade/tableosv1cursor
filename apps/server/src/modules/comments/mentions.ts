const MENTION_RE = /@(user|team|contact):([0-9a-f-]{36})/gi;

export interface ParsedMention {
  principalType: "user" | "team" | "contact";
  principalId: string;
}

export function parseMentions(body: string): ParsedMention[] {
  const seen = new Set<string>();
  const out: ParsedMention[] = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const principalType = match[1] as ParsedMention["principalType"];
    const principalId = match[2];
    if (!principalId) continue;
    const key = `${principalType}:${principalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ principalType, principalId });
  }
  return out;
}
