// Deterministic helpers. Anything numeric, date-based or string-exact lives
// here, in code, never in a Jev question (Jev 1.13 is weak at numbers, dates
// and exact string comparison).

export function digits(s: string | undefined | null): string {
  return String(s ?? "").replace(/\D+/g, "");
}

export function normIfsc(s: string | undefined | null): string {
  return String(s ?? "").replace(/\s+/g, "").toUpperCase();
}

export function samePhone(a: string, b: string): boolean {
  const da = digits(a);
  const db = digits(b);
  if (!da || !db) return false;
  // Compare the last 10 digits so "+91 80 4110 2231" == "08041102231".
  return da.slice(-10) === db.slice(-10);
}

export function sameAccount(a: string | undefined, b: string | undefined): boolean {
  const da = digits(a);
  const db = digits(b);
  return da.length >= 6 && da === db;
}

export function last4(s: string | undefined): string {
  return digits(s).slice(-4);
}

export function domainOf(address: string | undefined): string {
  const m = String(address ?? "").toLowerCase().match(/@([a-z0-9.-]+)/);
  return m ? m[1] : "";
}

/** Levenshtein distance, small and dependency-free. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

function stem(domain: string): string {
  // "spiceroute-ingredients.co.in" -> "spicerouteingredients"
  const parts = domain.toLowerCase().split(".");
  const cut = parts.length > 2 && ["co", "com", "net", "org", "ac", "gov"].includes(parts[parts.length - 2])
    ? parts.length - 2
    : parts.length - 1;
  return parts.slice(0, cut).join("").replace(/[^a-z0-9]/g, "");
}

/**
 * True when `candidate` is not the registered domain but looks like it:
 * small edit distance, or one stem contains the other (acmepack.in vs
 * acme-pack.co, spiceroute.co.in vs spiceroute-ingredients.co.in).
 */
export function isLookalike(candidate: string, registered: string): boolean {
  const c = candidate.toLowerCase();
  const r = registered.toLowerCase();
  if (!c || !r || c === r) return false;
  const sc = stem(c);
  const sr = stem(r);
  if (!sc || !sr) return false;
  if (sc === sr) return true;
  if (sc.length >= 5 && sr.length >= 5 && (sc.includes(sr) || sr.includes(sc))) return true;
  return editDistance(sc, sr) <= 2;
}

/**
 * Candidate enumeration for account numbers mentioned in free text.
 * Returns digit strings of 9-18 digits (Indian account numbers), tolerating
 * spaces and dashes inside the number, plus "ending 4471" style last-4s.
 */
export function extractAccounts(text: string): { full: string[]; last4: string[] } {
  const full = new Set<string>();
  const tails = new Set<string>();
  // Drop phone numbers written with a country code ("+91 44 4205 7788").
  const noPhones = text.replace(/\+\d{1,3}(?:[\s-]?\d){6,12}/g, " ");
  const re = /(?:\d[\s-]?){9,18}/g;
  for (const m of noPhones.matchAll(re)) {
    const d = digits(m[0]);
    if (d.length >= 9 && d.length <= 18 && !/^(91)?[6-9]\d{9}$/.test(d)) full.add(d);
  }
  for (const m of text.matchAll(/(?:ending(?:\s+in)?|ends\s+(?:in|with)|last\s+(?:4|four)\s+digits?)\s*[:#]?\s*(\d{4})\b/gi)) {
    tails.add(m[1]);
  }
  return { full: [...full], last4: [...tails] };
}

export function inr(n: number): string {
  // Indian grouping: 18,40,000
  const s = Math.round(n).toString();
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3;
  return `₹${grouped}`;
}

export function hoursBetween(aIso: string, bIso: string): number {
  return (Date.parse(bIso) - Date.parse(aIso)) / 3_600_000;
}

export function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
