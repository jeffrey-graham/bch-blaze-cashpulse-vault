import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CashPulseVaultClient,
  decodeVaultCommitment,
  encodeCashAddr,
  encodeCashTokenPrefix,
  encodeVaultCommitment,
  pkhToLockingBytecode,
  type VaultUtxo,
} from "../src/bchVaultClient.ts";

describe("CashPulse Escrow & Micro-Bounty Vault — BCH BLAZE 2026 Test Suite", () => {
  const sampleCategory = "7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e";
  const hunterPkh = "11223344556677889900aabbccddeeff00112233";
  const vaultScript = "aa20" + "cc".repeat(32) + "87"; // P2SH32 locking bytecode

  it("1. Encodes Bitcoin Cash Mainnet CashAddr (q-addr and token-aware z-addr) with valid checksum", () => {
    const qAddr = encodeCashAddr(hunterPkh, "p2pkh");
    const zAddr = encodeCashAddr(hunterPkh, "p2pkh-token");
    assert.ok(qAddr.startsWith("bitcoincash:q"), `Expected q-addr, got ${qAddr}`);
    assert.ok(zAddr.startsWith("bitcoincash:z"), `Expected token-aware z-addr, got ${zAddr}`);
    assert.notEqual(qAddr, zAddr);
  });

  it("2. Round-trips 8-byte mutable NFT state commitment [milestoneIndex(2B), totalReleasedSats(6B)]", () => {
    const commitmentHex = encodeVaultCommitment({
      milestoneIndex: 2,
      totalReleasedSats: 125_000_000n,
    });
    assert.equal(commitmentHex.length, 16);
    const decoded = decodeVaultCommitment(commitmentHex);
    assert.equal(decoded.milestoneIndex, 2);
    assert.equal(decoded.totalReleasedSats, 125_000_000n);
  });

  it("3. Serializes CHIP-2022-02 CashTokens 0xef prefix for mutable NFT + fungible balance", () => {
    const prefix = encodeCashTokenPrefix({
      categoryId: sampleCategory,
      amount: 5000n,
      nft: {
        capability: "mutable",
        commitment: "0100a08601000000",
      },
    });
    assert.ok(prefix.startsWith("ef"), "CashTokens prefix must start with 0xef");
    // 1B (0xef) + 32B (category) + 1B (bitfield=0x71) + 1B (comm len=8) + 8B (comm) + 3B (compactSize 5000)
    assert.equal(prefix.slice(66, 68), "71");
  });

  it("4. Builds intermediate milestone covenant continuation TX and passes Native Introspection checks", () => {
    const initialUtxo: VaultUtxo = {
      txid: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      vout: 0,
      satoshis: 500_000n,
      lockingBytecode: vaultScript,
      token: {
        categoryId: sampleCategory,
        amount: 10_000n,
        nft: {
          capability: "mutable",
          commitment: encodeVaultCommitment({ milestoneIndex: 0, totalReleasedSats: 0n }),
        },
      },
    };

    const tx = CashPulseVaultClient.buildMilestoneReleaseTx({
      vaultUtxo: initialUtxo,
      hunterPkh,
      payoutSats: 150_000n,
      payoutTokens: 2_500n,
      totalMilestones: 4,
      minerFeeSats: 1_000n,
    });

    assert.equal(tx.outputs.length, 2, "Should have Output 0 (Vault continuation) and Output 1 (Hunter payout)");
    assert.equal(tx.outputs[0].satoshis, 349_000n);
    assert.equal(tx.outputs[0].token?.amount, 7_500n);
    assert.equal(tx.outputs[1].satoshis, 150_000n);
    assert.equal(tx.outputs[1].token?.amount, 2_500n);
    assert.equal(tx.outputs[1].lockingBytecode, pkhToLockingBytecode(hunterPkh));
    assert.equal(tx.nextState.milestoneIndex, 1);
    assert.equal(tx.nextState.totalReleasedSats, 150_000n);

    const verification = CashPulseVaultClient.verifyCovenantIntrospection(tx, hunterPkh, 4, 1_000n);
    assert.equal(verification.valid, true, `Introspection errors: ${verification.errors.join(", ")}`);
  });

  it("5. Builds final milestone drain TX and generates WizardConnect bch_signTransaction payload", () => {
    const finalStageUtxo: VaultUtxo = {
      txid: "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f",
      vout: 0,
      satoshis: 151_000n,
      lockingBytecode: vaultScript,
      token: {
        categoryId: sampleCategory,
        amount: 2_500n,
        nft: {
          capability: "mutable",
          commitment: encodeVaultCommitment({ milestoneIndex: 3, totalReleasedSats: 450_000n }),
        },
      },
    };

    const tx = CashPulseVaultClient.buildMilestoneReleaseTx({
      vaultUtxo: finalStageUtxo,
      hunterPkh,
      payoutSats: 150_000n,
      payoutTokens: 2_500n,
      totalMilestones: 4,
      minerFeeSats: 1_000n,
    });

    assert.equal(tx.outputs.length, 1, "Final milestone should drain directly to Hunter on Output 0");
    assert.equal(tx.outputs[0].satoshis, 150_000n);
    assert.equal(tx.outputs[0].token?.amount, 2_500n);

    const wcPayload = CashPulseVaultClient.buildWizardConnectPayload(tx);
    assert.equal(wcPayload.method, "bch_signTransaction");
    assert.equal(wcPayload.params.broadcast, true);
    assert.equal(wcPayload.params.sourceOutputs.length, 1);
  });
});
