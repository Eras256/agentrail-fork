import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  RECEIPT_VERSION,
  anchorReceipt,
  buildSpendReceipt,
  buildTaskProofReceipt,
  canonicalizeReceipt,
  hashReceipt,
  ReceiptAnchorProvider,
  SpendReceipt,
} from "../src/lib/receipts.js";
import { verifyAndDeductSpend } from "../src/lib/scoped-allowance.js";
import { computeTaskCommitment, verifyTaskProof } from "../src/lib/proof-of-task.js";
import { EscrowTask, ScopedAllowance, SpendRequest } from "../src/types.js";

const AGENT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OWNER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const DEST = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TX = "a".repeat(64);

function allowance(overrides: Partial<ScopedAllowance> = {}): ScopedAllowance {
  return {
    id: "allow-1",
    ownerPublicKey: OWNER,
    agentPublicKey: AGENT,
    maxStroops: 100_000_000n,
    spentStroops: 0n,
    validFrom: 1_700_000_000,
    validUntil: 1_900_000_000,
    active: true,
    ...overrides,
  };
}

function spendRequest(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    allowanceId: "allow-1",
    agentPublicKey: AGENT,
    destination: DEST,
    amountStroops: 10_000_000n,
    timestamp: 1_800_000_000,
    ...overrides,
  };
}

function okProvider(contentFrom?: (hash: string) => string): ReceiptAnchorProvider & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async anchor(req) {
      calls.push(req);
      return {
        cid: "QmTestCid",
        contentSha256: contentFrom ? contentFrom(req.hash) : req.hash,
        gatewayUrl: "https://gateway.example/ipfs/QmTestCid",
        anchoredAt: "2026-11-17T00:00:00.000Z",
      };
    },
  };
}

describe("Spend receipts", () => {
  it("builds a receipt from a successful spend, with fee and net from the result", () => {
    const req = spendRequest();
    const result = verifyAndDeductSpend(allowance(), req);
    const receipt = buildSpendReceipt(req, result, { contractId: CONTRACT, txHash: TX.toUpperCase() });

    expect(receipt).toEqual({
      kind: "spend",
      version: RECEIPT_VERSION,
      contractId: CONTRACT,
      allowanceId: "allow-1",
      agentPublicKey: AGENT,
      destination: DEST,
      amountStroops: 10_000_000n,
      feeStroops: result.feeStroops,
      netStroops: result.netStroops,
      timestamp: 1_800_000_000,
      txHash: TX,
    });
  });

  it("leaves txHash out when the caller has none", () => {
    const req = spendRequest();
    const receipt = buildSpendReceipt(req, verifyAndDeductSpend(allowance(), req), { contractId: CONTRACT });
    expect("txHash" in receipt).toBe(false);
  });

  it("defaults fee to 0 and net to the amount when the result has none", () => {
    const req = spendRequest();
    const receipt = buildSpendReceipt(req, { ok: true, code: "OK", message: "ok" }, { contractId: CONTRACT });
    expect(receipt.feeStroops).toBe(0n);
    expect(receipt.netStroops).toBe(req.amountStroops);
  });

  it("accepts a contract id as destination", () => {
    const req = spendRequest({ destination: CONTRACT });
    const receipt = buildSpendReceipt(req, { ok: true, code: "OK", message: "ok" }, { contractId: CONTRACT });
    expect(receipt.destination).toBe(CONTRACT);
  });

  it("refuses to build a receipt for a rejected spend", () => {
    const req = spendRequest({ agentPublicKey: OWNER });
    const result = verifyAndDeductSpend(allowance(), req);
    expect(() => buildSpendReceipt(req, result, { contractId: CONTRACT })).toThrow(/rejected spend \(UNAUTHORIZED_AGENT\)/);
  });

  it("rejects invalid inputs through Zod", () => {
    const req = spendRequest();
    const ok = { ok: true, code: "OK", message: "ok" };
    expect(() => buildSpendReceipt(req, ok, { contractId: "not-a-contract" })).toThrow();
    expect(() => buildSpendReceipt(req, ok, { contractId: CONTRACT, txHash: "xyz" })).toThrow();
    expect(() => buildSpendReceipt(spendRequest({ destination: "nope" }), ok, { contractId: CONTRACT })).toThrow();
    expect(() => buildSpendReceipt(spendRequest({ timestamp: 1.5 }), ok, { contractId: CONTRACT })).toThrow();
    expect(() => buildSpendReceipt(req, ok, { contractId: 42 } as unknown as { contractId: string })).toThrow();
  });
});

describe("Proof-of-task receipts", () => {
  const output = JSON.stringify({ leads: 500 });
  const nonce = "nonce-1";
  const commitment = computeTaskCommitment(output, nonce);
  const task: EscrowTask = {
    taskId: "task-42",
    payerPublicKey: OWNER,
    agentWorkerPublicKey: AGENT,
    rewardStroops: 50_000_000n,
    taskCommitmentHash: commitment,
    expiresAt: 1_900_000_000,
    status: "pending",
  };

  it("records the commitment and the result, never the raw output or nonce", () => {
    const verification = verifyTaskProof(task, { taskId: task.taskId, agentWorkerPublicKey: AGENT, outputPayload: output, nonce }, 1_800_000_000);
    const receipt = buildTaskProofReceipt({
      taskId: task.taskId,
      agentWorkerPublicKey: AGENT,
      taskCommitmentHash: task.taskCommitmentHash,
      verification,
      timestamp: 1_800_000_000,
    });

    expect(receipt).toEqual({
      kind: "proof-of-task",
      version: RECEIPT_VERSION,
      taskId: "task-42",
      agentWorkerPublicKey: AGENT,
      taskCommitmentHash: commitment,
      verified: true,
      timestamp: 1_800_000_000,
    });
    const canonical = canonicalizeReceipt(receipt);
    expect(canonical).not.toContain(output);
    expect(canonical).not.toContain(nonce);
  });

  it("records a failed verification with its reason", () => {
    const verification = verifyTaskProof(task, { taskId: task.taskId, agentWorkerPublicKey: AGENT, outputPayload: "tampered", nonce }, 1_800_000_000);
    const receipt = buildTaskProofReceipt({
      taskId: task.taskId,
      agentWorkerPublicKey: AGENT,
      taskCommitmentHash: commitment,
      verification,
      timestamp: 1_800_000_000,
    });
    expect(receipt.verified).toBe(false);
    expect(receipt.reason).toBe("Cryptographic commitment hash mismatch");
  });

  it("rejects a malformed commitment hash or worker key", () => {
    const base = { taskId: "t", agentWorkerPublicKey: AGENT, taskCommitmentHash: commitment, verification: { ok: true }, timestamp: 1 };
    expect(() => buildTaskProofReceipt({ ...base, taskCommitmentHash: "abc" })).toThrow();
    expect(() => buildTaskProofReceipt({ ...base, agentWorkerPublicKey: "GBAD" })).toThrow();
    expect(() => buildTaskProofReceipt({ ...base, taskId: "" })).toThrow();
  });
});

describe("Canonical form and hash", () => {
  it("is independent of key order and serializes bigint as a decimal string", () => {
    const req = spendRequest();
    const receipt = buildSpendReceipt(req, verifyAndDeductSpend(allowance(), req), { contractId: CONTRACT });
    const shuffled = Object.fromEntries(Object.entries(receipt).reverse()) as SpendReceipt;

    expect(canonicalizeReceipt(shuffled)).toBe(canonicalizeReceipt(receipt));
    expect(canonicalizeReceipt(receipt)).toContain('"amountStroops":"10000000"');
    expect(hashReceipt(receipt)).toBe(createHash("sha256").update(canonicalizeReceipt(receipt), "utf8").digest("hex"));
  });

  it("handles nested arrays and objects and drops undefined fields", () => {
    const value = { b: [2n, { z: 1, a: undefined }], a: null } as unknown as SpendReceipt;
    expect(canonicalizeReceipt(value)).toBe('{"a":null,"b":["2",{"z":1}]}');
  });

  it("changes when any field changes", () => {
    const req = spendRequest();
    const result = verifyAndDeductSpend(allowance(), req);
    const a = buildSpendReceipt(req, result, { contractId: CONTRACT });
    const b = buildSpendReceipt({ ...req, timestamp: req.timestamp + 1 }, result, { contractId: CONTRACT });
    expect(hashReceipt(a)).not.toBe(hashReceipt(b));
  });
});

describe("anchorReceipt", () => {
  const req = spendRequest();
  const receipt = buildSpendReceipt(req, verifyAndDeductSpend(allowance(), req), { contractId: CONTRACT, txHash: TX });

  it("sends only the hash (plus tag and txHash) and returns a verify URL", async () => {
    const provider = okProvider();
    const out = await anchorReceipt(receipt, provider, { tag: "agentrail-spend" });

    expect(provider.calls).toEqual([{ hash: hashReceipt(receipt), tag: "agentrail-spend", txHash: TX }]);
    expect(out).toEqual({
      ok: true,
      cid: "QmTestCid",
      contentSha256: hashReceipt(receipt),
      verifyUrl: "https://nirium.xyz/verify?cid=QmTestCid",
      gatewayUrl: "https://gateway.example/ipfs/QmTestCid",
      anchoredAt: "2026-11-17T00:00:00.000Z",
    });
  });

  it("omits tag and txHash when absent, and works for proof-of-task receipts", async () => {
    const proof = buildTaskProofReceipt({
      taskId: "t",
      agentWorkerPublicKey: AGENT,
      taskCommitmentHash: "b".repeat(64),
      verification: { ok: true },
      timestamp: 1,
    });
    const provider: ReceiptAnchorProvider & { calls: unknown[] } = {
      calls: [],
      async anchor(r) {
        this.calls.push(r);
        return { cid: "QmProof", contentSha256: r.hash };
      },
    };
    const out = await anchorReceipt(proof, provider);
    expect(provider.calls).toEqual([{ hash: hashReceipt(proof) }]);
    expect(out).toEqual({ ok: true, cid: "QmProof", contentSha256: hashReceipt(proof), verifyUrl: "https://nirium.xyz/verify?cid=QmProof" });
  });

  it("returns ok:false instead of throwing when the provider fails", async () => {
    const provider: ReceiptAnchorProvider = { anchor: vi.fn().mockRejectedValue(new Error("network down")) };
    await expect(anchorReceipt(receipt, provider)).resolves.toEqual({
      ok: false,
      contentSha256: hashReceipt(receipt),
      error: "network down",
    });
  });

  it("reports non-Error rejections as strings", async () => {
    const provider: ReceiptAnchorProvider = { anchor: vi.fn().mockRejectedValue("boom") };
    const out = await anchorReceipt(receipt, provider);
    expect(out).toMatchObject({ ok: false, error: "boom" });
  });

  it("flags an anchor that returns a different content hash", async () => {
    const out = await anchorReceipt(receipt, okProvider(() => "c".repeat(64)));
    expect(out).toEqual({ ok: false, contentSha256: hashReceipt(receipt), error: "Anchor returned a different content hash" });
  });

  it("rejects a bad tag or a tampered receipt without calling the provider", async () => {
    const provider = okProvider();
    const badTag = await anchorReceipt(receipt, provider, { tag: "x".repeat(65) });
    const tampered = await anchorReceipt({ ...receipt, contractId: "bad" }, provider);
    expect(badTag.ok).toBe(false);
    expect(tampered).toMatchObject({ ok: false, contentSha256: "" });
    expect(provider.calls).toHaveLength(0);
  });
});
