import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AUDIT_TRAIL_MAINNET_URL,
  AUDIT_TRAIL_TESTNET_URL,
  createAuditTrailProvider,
} from "../src/lib/audit-trail-provider.js";

const HASH = "d".repeat(64);

function response(status: number, body: unknown, badJson = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: badJson ? () => Promise.reject(new Error("not json")) : () => Promise.resolve(body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createAuditTrailProvider", () => {
  it("POSTs only the hash to the testnet node by default and maps the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(201, { cid: "QmA", content_sha256: HASH, gatewayUrl: "https://g/ipfs/QmA", anchoredAt: "2026-11-17T00:00:00Z", verify: "..." })
    );
    const provider = createAuditTrailProvider({ fetchImpl });
    const out = await provider.anchor({ hash: HASH, tag: "agentrail" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${AUDIT_TRAIL_TESTNET_URL}/api/audit/log`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ hash: HASH, tag: "agentrail" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(out).toEqual({ cid: "QmA", contentSha256: HASH, gatewayUrl: "https://g/ipfs/QmA", anchoredAt: "2026-11-17T00:00:00Z" });
  });

  it("uses a custom base URL and strips trailing slashes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(201, { cid: "QmB", content_sha256: HASH }));
    const out = await createAuditTrailProvider({ baseUrl: `${AUDIT_TRAIL_MAINNET_URL}//`, fetchImpl }).anchor({ hash: HASH });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${AUDIT_TRAIL_MAINNET_URL}/api/audit/log`);
    expect(out).toEqual({ cid: "QmB", contentSha256: HASH });
  });

  it("falls back to the global fetch when none is injected", async () => {
    const globalFetch = vi.fn().mockResolvedValue(response(201, { cid: "QmG", content_sha256: HASH }));
    vi.stubGlobal("fetch", globalFetch);
    const out = await createAuditTrailProvider().anchor({ hash: HASH });
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(out.cid).toBe("QmG");
  });

  it("surfaces the server's error message on a non-2xx answer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(400, { error: "`hash` must be a 64-char sha-256 hex" }));
    await expect(createAuditTrailProvider({ fetchImpl }).anchor({ hash: "bad" })).rejects.toThrow(
      "Audit Trail returned HTTP 400: `hash` must be a 64-char sha-256 hex"
    );
  });

  it("handles a non-2xx answer without a JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(503, undefined, true));
    await expect(createAuditTrailProvider({ fetchImpl }).anchor({ hash: HASH })).rejects.toThrow(
      "Audit Trail returned HTTP 503: no error message"
    );
  });

  it("rejects a 2xx answer that does not match the expected shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(201, { cid: "", content_sha256: "nope" }));
    await expect(createAuditTrailProvider({ fetchImpl }).anchor({ hash: HASH })).rejects.toThrow();
  });

  it("aborts the request after timeoutMs", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, init: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );
    const pending = createAuditTrailProvider({ fetchImpl, timeoutMs: 50 }).anchor({ hash: HASH });
    const assertion = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("validates options with Zod", () => {
    expect(() => createAuditTrailProvider({ baseUrl: "http://insecure.example" })).toThrow();
    expect(() => createAuditTrailProvider({ baseUrl: "not a url" })).toThrow();
    expect(() => createAuditTrailProvider({ timeoutMs: 0 })).toThrow();
    expect(() => createAuditTrailProvider({ timeoutMs: 120_000 })).toThrow();
  });
});
