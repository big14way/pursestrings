/**
 * Spots merchant text that tries to instruct the agent: prompt injection. Merchant
 * listings are data. A listing that addresses AI agents, overrides their rules,
 * redirects funds or asks for secrecy gets its merchant quarantined: none of its
 * text reaches the planner and none of its products can be paid.
 *
 * This is one layer, not the only one. The planner can only name catalog ids, every
 * payment is checked against the live 402 in code, and the Passport session caps
 * what any payment can be, whatever the agent was told.
 */

export type InjectionKind = "override" | "addresses-agent" | "redirects-funds" | "secrecy";

export interface InjectionFinding {
  kind: InjectionKind;
  /** Where in the merchant document, e.g. shops[0].description. */
  path: string;
  /** The sentence that matched, cleaned and shortened. */
  excerpt: string;
}

const RULES: Array<{ kind: InjectionKind; pattern: RegExp }> = [
  {
    kind: "override",
    pattern: /\b(ignore|disregard|forget|override|bypass)\b.{0,40}?\b(previous|prior|above|earlier|all|any|your|system|spending)\b.{0,30}?\b(instructions?|rules?|prompts?|limits?|guidelines?|polic(?:y|ies))\b/i,
  },
  {
    kind: "addresses-agent",
    pattern: /\b(notice|message|note|attention|instructions?)\b.{0,12}?\b(to|for)\b.{0,30}?\b(ai|llm|automated|autonomous|shopping)\b.{0,15}?\b(agents?|assistants?|bots?|models?)\b|\b(ai|llm)\s+(agents?|assistants?)\s*[:,]|\b(system|developer)\s+(prompt|message|override|instructions?)\s*:/i,
  },
  {
    kind: "redirects-funds",
    pattern: /\b(send|transfer|pay|wire|move|forward|deposit)\b.{0,50}?\b(whole|entire|all|remaining|full|rest of|maximum|max)\b.{0,25}?\b(budget|balance|funds|money|allowance|limit|wallet)\b/i,
  },
  {
    kind: "secrecy",
    pattern: /\b(do not|don't|never|without)\s+(tell|telling|inform|informing|mention|mentioning|show|showing|alert|alerting|notify|notifying)\b.{0,25}?\b(users?|human|owner|customer|buyer)\b/i,
  },
];

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
// C0/C1 controls (terminal escapes) and bidi overrides that can disguise text.
const CONTROL = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

/** Merchant text made safe to print and to match: no escapes, no hidden characters. */
export function cleanText(value: string): string {
  return value.normalize("NFKC").replace(ZERO_WIDTH, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

function excerptAround(text: string, start: number, end: number): string {
  const boundary = /[.!?](\s|$)/g;
  let from = 0;
  let to = text.length;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    const stop = m.index + 1;
    if (stop <= start) from = stop;
    else if (stop >= end) {
      to = stop;
      break;
    }
  }
  const sentence = text.slice(from, to).trim();
  if (sentence.length <= 220) return sentence;
  const left = Math.max(from, start - 60);
  const right = Math.min(to, end + 60);
  return `${left > from ? "…" : ""}${text.slice(left, right).trim()}${right < to ? "…" : ""}`;
}

/** Findings in one piece of text. */
export function scanText(value: string, path = "text"): InjectionFinding[] {
  const text = cleanText(value.slice(0, 4000));
  const findings: InjectionFinding[] = [];
  for (const { kind, pattern } of RULES) {
    const match = pattern.exec(text);
    if (match) findings.push({ kind, path, excerpt: excerptAround(text, match.index, match.index + match[0].length) });
  }
  return findings;
}

/** Findings anywhere in a merchant document: every string value and key. */
export function scanDocument(doc: unknown): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const seen = new Set<string>();
  let budget = 2000;
  const add = (list: InjectionFinding[]) => {
    for (const f of list) {
      const key = `${f.kind}|${f.excerpt}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(f);
      }
    }
  };
  const walk = (value: unknown, path: string, depth: number) => {
    if (budget-- <= 0 || depth > 8) return;
    if (typeof value === "string") add(scanText(value, path));
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        add(scanText(k, `${path}{key}`));
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };
  walk(doc, "", 0);
  return findings;
}

/** EVM addresses named in the findings, e.g. where injected text wants funds sent. */
export function addressesIn(findings: InjectionFinding[]): string[] {
  return [...new Set(findings.flatMap((f) => f.excerpt.match(/0x[0-9a-fA-F]{40}/g) ?? []))];
}

const SEVERITY: InjectionKind[] = ["redirects-funds", "override", "secrecy", "addresses-agent"];

/** The most telling finding first: redirected funds, then overrides. */
export function rankFindings(findings: InjectionFinding[]): InjectionFinding[] {
  return [...findings].sort((a, b) => SEVERITY.indexOf(a.kind) - SEVERITY.indexOf(b.kind));
}

export const KIND_LABEL: Record<InjectionKind, string> = {
  "redirects-funds": "tries to redirect funds",
  override: "tells the agent to ignore its rules",
  secrecy: "asks the agent to hide something from you",
  "addresses-agent": "addresses AI agents directly",
};
