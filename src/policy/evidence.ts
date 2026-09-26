// Evidence selection, done in code ("viewfinder": frame only what is being
// judged). Jev accuracy drops as state fills with irrelevant text, so each
// request carries at most a few messages that plausibly relate to the action.

import type { Email, Party, World } from "../shared/types";
import { digits, domainOf, extractAccounts, isLookalike, truncate } from "../shared/text";

export interface EvidenceMessage {
  id: string;
  thread: string;
  from: string;
  subject: string;
  body: string;
  attachments: { name: string; text: string }[];
}

export interface RelatedQuery {
  party?: Party;
  invoiceIds?: string[];
  names?: string[];
  accounts?: string[];
  amount?: number;
  alwaysInclude?: string[]; // email ids
}

function amountVariants(n: number): string[] {
  const plain = String(Math.round(n));
  const indian = plain.length > 3 ? plain.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + plain.slice(-3) : plain;
  const western = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return [...new Set([plain, indian, western])];
}

function significantWords(name: string): string[] {
  const stop = new Set(["pvt", "ltd", "llp", "private", "limited", "services", "the", "and", "&", "inc", "co"]);
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
}

function fullText(e: Email): string {
  return [e.from_name, e.from, e.subject, e.body, ...(e.attachments ?? []).map((a) => `${a.name}\n${a.text}`)].join("\n");
}

export function scoreEmail(e: Email, q: RelatedQuery): number {
  const t = fullText(e);
  const lower = t.toLowerCase();
  let s = 0;
  if (q.alwaysInclude?.includes(e.id)) s += 100;
  const d = domainOf(e.from);
  if (q.party) {
    if (d === q.party.domain) s += 3;
    else if (isLookalike(d, q.party.domain)) s += 4;
    const words = significantWords(q.party.name);
    if (words.length && words.some((w) => lower.includes(w))) s += 2;
  }
  for (const id of q.invoiceIds ?? []) if (t.includes(id)) s += 3;
  for (const n of q.names ?? []) {
    const words = significantWords(n);
    if (words.length && words.filter((w) => lower.includes(w)).length >= Math.min(2, words.length)) s += 3;
  }
  const accts = extractAccounts(t).full;
  for (const a of q.accounts ?? []) if (accts.includes(digits(a))) s += 4;
  if (q.amount) for (const v of amountVariants(q.amount)) if (t.includes(v)) s += 1;
  return s;
}

export function relatedMessages(world: World, q: RelatedQuery, max = 3): { messages: EvidenceMessage[]; emails: Email[] } {
  const scored = world.inbox
    .map((e) => ({ e, s: scoreEmail(e, q) }))
    .filter((x) => x.s >= 3)
    .sort((a, b) => b.s - a.s || b.e.date.localeCompare(a.e.date))
    .slice(0, max);
  const emails = scored.map((x) => x.e).sort((a, b) => a.date.localeCompare(b.date));
  return {
    emails,
    messages: emails.map((e) => ({
      id: e.id,
      thread: e.thread,
      from: `${e.from_name} <${e.from}>`,
      subject: e.subject,
      body: truncate(e.body, 1800),
      attachments: (e.attachments ?? []).map((a) => ({ name: a.name, text: truncate(a.text, 1200) })),
    })),
  };
}

/** Facts computed in code about the evidence. Never sent to Jev. */
export interface EvidenceFacts {
  sender_domains: string[];
  lookalike_senders: string[];
  reply_to_mismatch: string[]; // email ids where reply-to domain differs from sender domain
  accounts_mentioned: string[];
  last4_mentioned: string[];
}

export function evidenceFacts(emails: Email[], party?: Party, companyDomain?: string): EvidenceFacts {
  const facts: EvidenceFacts = { sender_domains: [], lookalike_senders: [], reply_to_mismatch: [], accounts_mentioned: [], last4_mentioned: [] };
  for (const e of emails) {
    const d = domainOf(e.from);
    facts.sender_domains.push(d);
    if ((party && isLookalike(d, party.domain)) || (companyDomain && isLookalike(d, companyDomain))) facts.lookalike_senders.push(e.from);
    if (e.reply_to && domainOf(e.reply_to) !== d) facts.reply_to_mismatch.push(e.id);
    const acc = extractAccounts(fullText(e));
    facts.accounts_mentioned.push(...acc.full);
    facts.last4_mentioned.push(...acc.last4);
  }
  facts.accounts_mentioned = [...new Set(facts.accounts_mentioned)];
  facts.last4_mentioned = [...new Set(facts.last4_mentioned)];
  facts.sender_domains = [...new Set(facts.sender_domains)];
  return facts;
}

/** Staff members an email claims to be from (display name match), for steering. */
export function claimedStaff(world: World, emails: Email[]): Party[] {
  const staff = world.parties.filter((p) => p.kind === "staff");
  const out: Party[] = [];
  for (const e of emails) {
    for (const s of staff) {
      if (e.from_name.toLowerCase().includes(s.name.toLowerCase()) && !out.includes(s)) out.push(s);
    }
  }
  return out;
}
