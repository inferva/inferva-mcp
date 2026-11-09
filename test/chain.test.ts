import { describe, expect, it } from "vitest";
import { sha256Hex, settlementPayload, verifyChain, verifyRecords } from "../src/chain.js";
import { InfervaClient } from "../src/client.js";
import { BASE, GENESIS, buildChain, chainRoute, mockFetch } from "./helpers.js";

describe("settlement hash chain", () => {
  it("uses the app's payload format", async () => {
    const [r] = buildChain(1);
    expect(settlementPayload(r!, GENESIS)).toBe(`${GENESIS}|req_0001|0x000000000000000000000000000000000000beef|prv_basalt|basalt-70b|100|180|0|18|cap_1|500000|1794000001000`);
    expect(await sha256Hex(settlementPayload(r!, GENESIS))).toBe(r!.hash);
  });

  it("verifies a hand-built 3-record chain from genesis", async () => {
    const records = buildChain(3);
    const res = await verifyRecords(records, GENESIS);
    expect(res).toEqual({ checked: 3, tip: records[2]!.hash, broken: null });
  });

  it("finds a record whose contents were edited", async () => {
    const records = buildChain(3);
    records[1]!.fee = 1; // hash column left as it was
    const res = await verifyRecords(records, GENESIS);
    expect(res.checked).toBe(1);
    expect(res.broken).toMatchObject({ seq: 2, id: "req_0002", reason: "hash_mismatch", found: records[1]!.hash });
  });

  it("finds a dropped record (broken link)", async () => {
    const records = buildChain(3);
    const res = await verifyRecords([records[0]!, records[2]!], GENESIS);
    expect(res.broken).toMatchObject({ seq: 3, reason: "prev_hash_mismatch", expected: records[0]!.hash, found: records[1]!.hash });
  });

  it("finds a record rehashed without fixing the next link", async () => {
    const records = buildChain(3);
    records[1]!.tokens = 999;
    records[1]!.hash = await sha256Hex(settlementPayload(records[1]!, records[1]!.prev_hash));
    const res = await verifyRecords(records, GENESIS);
    expect(res.checked).toBe(2);
    expect(res.broken).toMatchObject({ seq: 3, reason: "prev_hash_mismatch" });
  });

  it("walks /api/chain page by page", async () => {
    const records = buildChain(5);
    const { fetch, calls } = mockFetch({ "GET /api/chain": chainRoute(records) });
    const res = await verifyChain(new InfervaClient({ baseUrl: BASE, fetch }), { pageSize: 2 });
    expect(res).toMatchObject({ checked: 5, intact: true, firstBroken: null, genesis: GENESIS, tip: records[4]!.hash, lastSeq: 5, truncated: false });
    expect(calls.map((c) => c.url.searchParams.get("after"))).toEqual(["0", "2", "4"]);
  });

  it("reports the first broken record across pages", async () => {
    const records = buildChain(5);
    records[3]!.model = "other";
    const { fetch } = mockFetch({ "GET /api/chain": chainRoute(records) });
    const res = await verifyChain(new InfervaClient({ baseUrl: BASE, fetch }), { pageSize: 2 });
    expect(res).toMatchObject({ checked: 3, intact: false, lastSeq: 3, firstBroken: { seq: 4, reason: "hash_mismatch" } });
  });

  it("stops at maxRecords", async () => {
    const records = buildChain(5);
    const { fetch } = mockFetch({ "GET /api/chain": chainRoute(records) });
    const res = await verifyChain(new InfervaClient({ baseUrl: BASE, fetch }), { pageSize: 2, maxRecords: 3 });
    expect(res).toMatchObject({ checked: 3, intact: true, truncated: true, lastSeq: 3 });
  });

  it("handles an empty chain", async () => {
    const { fetch } = mockFetch({ "GET /api/chain": chainRoute([]) });
    const res = await verifyChain(new InfervaClient({ baseUrl: BASE, fetch }));
    expect(res).toMatchObject({ checked: 0, intact: true, tip: GENESIS });
  });
});
