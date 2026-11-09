import type { InfervaClient } from "./client.js";

/** The fields of a settlement record that its hash covers, in hash order. */
export type SettlementRecord = {
  seq: number;
  id: string;
  payer: string;
  provider: string;
  model: string;
  tokens: number;
  base: number;
  /** Always 0 on current records; kept in the hash so older records still verify. */
  discount: number;
  fee: number;
  capacity_id: string;
  epoch: number;
  created_at: number;
  prev_hash: string;
  hash: string;
};

/** Canonical string a settlement record hashes, chained to the previous record. Same as the INFERVA app. */
export function settlementPayload(r: Omit<SettlementRecord, "seq" | "prev_hash" | "hash">, prevHash: string) {
  return [prevHash, r.id, r.payer, r.provider, r.model, r.tokens, r.base, r.discount, r.fee, r.capacity_id, r.epoch, r.created_at].join("|");
}

export async function sha256Hex(text: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Broken = { seq: number; id: string; reason: "prev_hash_mismatch" | "hash_mismatch"; expected: string; found: string };

export type ChainCheck = {
  /** Records whose link and hash were recomputed and matched. */
  checked: number;
  /** True when every record checked matched. */
  intact: boolean;
  /** First record that does not verify, or null. */
  firstBroken: Broken | null;
  genesis: string;
  /** Hash of the last verified record (the genesis value when nothing was checked). */
  tip: string;
  lastSeq: number;
  /** True when verification stopped at maxRecords before reaching the end of the chain. */
  truncated: boolean;
};

/**
 * Check a run of records in order: each must point at the previous hash, and its own hash must equal
 * sha256(settlementPayload(record, prev)). Nothing trusts the stored hash column. Stops at the first break.
 */
export async function verifyRecords(records: SettlementRecord[], prev: string): Promise<{ checked: number; tip: string; broken: Broken | null }> {
  let checked = 0;
  for (const r of records) {
    if (r.prev_hash !== prev) return { checked, tip: prev, broken: { seq: r.seq, id: r.id, reason: "prev_hash_mismatch", expected: prev, found: r.prev_hash } };
    const hash = await sha256Hex(settlementPayload(r, prev));
    if (hash !== r.hash) return { checked, tip: prev, broken: { seq: r.seq, id: r.id, reason: "hash_mismatch", expected: hash, found: r.hash } };
    prev = hash;
    checked++;
  }
  return { checked, tip: prev, broken: null };
}

export const CHAIN_PAGE = 200;

/** Walk GET /api/chain from the genesis value, page by page, and recompute every hash. */
export async function verifyChain(client: InfervaClient, opts: { maxRecords?: number; pageSize?: number } = {}): Promise<ChainCheck> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? CHAIN_PAGE, 1), CHAIN_PAGE);
  const max = opts.maxRecords ?? Number.POSITIVE_INFINITY;
  let after = 0;
  let genesis = "";
  let prev = "";
  let checked = 0;
  for (;;) {
    const page = await client.get<{ genesis: string; records: SettlementRecord[] }>("/api/chain", { after, limit: pageSize });
    if (!genesis) {
      genesis = page.genesis;
      prev = genesis;
    }
    const records = page.records.slice(0, Math.max(0, max - checked));
    const res = await verifyRecords(records, prev);
    checked += res.checked;
    prev = res.tip;
    if (res.broken) return { checked, intact: false, firstBroken: res.broken, genesis, tip: prev, lastSeq: records[res.checked - 1]?.seq ?? after, truncated: false };
    const last = records[records.length - 1];
    if (last) after = last.seq;
    if (page.records.length < pageSize) return { checked, intact: true, firstBroken: null, genesis, tip: prev, lastSeq: after, truncated: false };
    if (checked >= max) return { checked, intact: true, firstBroken: null, genesis, tip: prev, lastSeq: after, truncated: true };
  }
}
