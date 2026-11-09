import crypto from "node:crypto";

/**
 * CashPulse Vault Client — Bitcoin Cash Mainnet Covenant + CashTokens Transaction Builder
 * Supports CashAddr (q/z/p/r), CHIP-2022-02 CashTokens (0xef prefix), Native Introspection
 * verification, WizardConnect (WC2 bch_signTransaction), and Mainnet-JS send requests.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export type NftCapability = "none" | "mutable" | "minting";

export interface CashTokenData {
  categoryId: string; // 32-byte hex (64 chars)
  amount: bigint; // Fungible token amount
  nft?: {
    capability: NftCapability;
    commitment: string; // Hex string (up to 40 bytes on BCH)
  };
}

export interface VaultStateCommitment {
  milestoneIndex: number; // uint16 LE
  totalReleasedSats: bigint; // uint48 LE
}

export interface VaultUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  lockingBytecode: string;
  token: CashTokenData;
}

export interface MilestoneReleaseParams {
  vaultUtxo: VaultUtxo;
  hunterPkh: string; // 20-byte hex (40 chars)
  payoutSats: bigint;
  payoutTokens: bigint;
  totalMilestones: number;
  minerFeeSats?: bigint;
  locktime?: number;
}

export interface TxOutput {
  satoshis: bigint;
  lockingBytecode: string;
  token?: CashTokenData;
  cashTokenPrefixHex: string;
}

export interface BuiltCovenantTransaction {
  version: number;
  locktime: number;
  inputs: Array<{
    txid: string;
    vout: number;
    sequence: number;
    utxo: VaultUtxo;
  }>;
  outputs: TxOutput[];
  rawHex: string;
  txid: string;
  nextCommitmentHex: string;
  nextState: VaultStateCommitment;
}

export interface IntrospectionVerificationResult {
  valid: boolean;
  checks: {
    covenantBytecodePreserved: boolean;
    tokenCategoryPreserved: boolean;
    tokenBalanceConserved: boolean;
    satoshiValueConserved: boolean;
    commitmentIncremented: boolean;
    hunterP2pkhValid: boolean;
    dustThresholdMet: boolean;
  };
  errors: string[];
}

function polymod(values: number[]): bigint {
  const GENERATORS: [number, bigint][] = [
    [0x01, 0x98f2bc8e61n],
    [0x02, 0x79b76d99e2n],
    [0x04, 0xf33e5fb3c4n],
    [0x08, 0xae2eabe2a8n],
    [0x10, 0x1e4f43e470n],
  ];
  let c = 1n;
  for (const d of values) {
    const c0 = Number(c >> 35n);
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (const [bit, gen] of GENERATORS) {
      if ((c0 & bit) !== 0) c ^= gen;
    }
  }
  return c ^ 1n;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  }
  return ret;
}

/**
 * Encode a 20-byte hash160 into a Bitcoin Cash Mainnet CashAddr (`bitcoincash:q...` or token-aware `bitcoincash:z...`).
 */
export function encodeCashAddr(
  hash20Hex: string,
  type: "p2pkh" | "p2sh" | "p2pkh-token" | "p2sh-token" = "p2pkh-token",
  prefix = "bitcoincash",
): string {
  const hashBytes = Buffer.from(hash20Hex, "hex");
  if (hashBytes.length !== 20) {
    throw new Error(`Expected 20-byte hash160, got ${hashBytes.length} bytes`);
  }
  const versionMap: Record<typeof type, number> = {
    p2pkh: 0x00, // 'q'
    p2sh: 0x08, // 'p'
    "p2pkh-token": 0x10, // 'z' (CHIP-2022-02 token-aware P2PKH)
    "p2sh-token": 0x18, // 'r' (CHIP-2022-02 token-aware P2SH)
  };
  const payload = new Uint8Array(21);
  payload[0] = versionMap[type];
  payload.set(hashBytes, 1);

  const payload5Bit = convertBits(payload, 8, 5, true);
  const prefixData = Array.from(prefix).map((ch) => ch.charCodeAt(0) & 0x1f);
  const checksumInput = [...prefixData, 0, ...payload5Bit, 0, 0, 0, 0, 0, 0, 0, 0];
  const mod = polymod(checksumInput);
  const checksum: number[] = [];
  for (let i = 0; i < 8; i++) {
    checksum.push(Number((mod >> BigInt(5 * (7 - i))) & 0x1fn));
  }
  const combined = [...payload5Bit, ...checksum].map((v) => CHARSET[v]).join("");
  return `${prefix}:${combined}`;
}

export function pkhToLockingBytecode(pkhHex: string): string {
  if (!/^[0-9a-fA-F]{40}$/.test(pkhHex)) {
    throw new Error("Invalid 20-byte PKH hex");
  }
  return `76a914${pkhHex.toLowerCase()}88ac`;
}

export function encodeVaultCommitment(state: VaultStateCommitment): string {
  if (state.milestoneIndex < 0 || state.milestoneIndex > 0xffff) {
    throw new Error("milestoneIndex out of uint16 range");
  }
  if (state.totalReleasedSats < 0n || state.totalReleasedSats > 0xffffffffffffn) {
    throw new Error("totalReleasedSats out of uint48 range");
  }
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(state.milestoneIndex, 0);
  buf.writeUIntLE(Number(state.totalReleasedSats), 2, 6);
  return buf.toString("hex");
}

export function decodeVaultCommitment(commitmentHex: string): VaultStateCommitment {
  const buf = Buffer.from(commitmentHex, "hex");
  if (buf.length !== 8) {
    throw new Error(`Expected 8-byte commitment, got ${buf.length}`);
  }
  const milestoneIndex = buf.readUInt16LE(0);
  const totalReleasedSats = BigInt(buf.readUIntLE(2, 6));
  return { milestoneIndex, totalReleasedSats };
}

function encodeCompactSize(n: bigint): Buffer {
  if (n < 0xfdn) {
    return Buffer.from([Number(n)]);
  } else if (n <= 0xffffn) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(Number(n), 1);
    return b;
  } else if (n <= 0xffffffffn) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(Number(n), 1);
    return b;
  } else {
    const b = Buffer.alloc(9);
    b[0] = 0xff;
    b.writeBigUInt64LE(n, 1);
    return b;
  }
}

/**
 * Serialize CHIP-2022-02 CashTokens prefix (`0xef` + 32B category + bitfield + [commitment] + [amount]).
 */
export function encodeCashTokenPrefix(token?: CashTokenData): string {
  if (!token) return "";
  if (!/^[0-9a-fA-F]{64}$/.test(token.categoryId)) {
    throw new Error("Invalid 32-byte CashTokens categoryId");
  }
  const hasNft = Boolean(token.nft);
  const hasAmount = token.amount > 0n;
  const hasCommitment = Boolean(token.nft && token.nft.commitment.length > 0);

  let bitfield = 0;
  if (hasAmount) bitfield |= 0x10;
  if (hasNft) {
    bitfield |= 0x20;
    if (hasCommitment) bitfield |= 0x40;
    const capBits: Record<NftCapability, number> = {
      none: 0x00,
      mutable: 0x01,
      minting: 0x02,
    };
    bitfield |= capBits[token.nft!.capability];
  }

  // Category bytes in tx serialization are little-endian (reversed from display order)
  const categoryBuf = Buffer.from(token.categoryId, "hex").reverse();
  const parts: Buffer[] = [Buffer.from([0xef]), categoryBuf, Buffer.from([bitfield])];

  if (hasNft && hasCommitment) {
    const commBuf = Buffer.from(token.nft!.commitment, "hex");
    parts.push(encodeCompactSize(BigInt(commBuf.length)), commBuf);
  }
  if (hasAmount) {
    parts.push(encodeCompactSize(token.amount));
  }
  return Buffer.concat(parts).toString("hex");
}

export class CashPulseVaultClient {
  /**
   * Build a deterministic CashPulse Vault milestone payout transaction on BCH Mainnet.
   */
  static buildMilestoneReleaseTx(params: MilestoneReleaseParams): BuiltCovenantTransaction {
    const {
      vaultUtxo,
      hunterPkh,
      payoutSats,
      payoutTokens,
      totalMilestones,
      minerFeeSats = 1000n,
      locktime = 0,
    } = params;

    if (payoutSats < 546n) {
      throw new Error("payoutSats must be >= 546 satoshis (BCH dust limit)");
    }
    if (payoutTokens < 0n || payoutTokens > vaultUtxo.token.amount) {
      throw new Error("Invalid payoutTokens amount");
    }
    if (!vaultUtxo.token.nft || vaultUtxo.token.nft.capability !== "mutable") {
      throw new Error("Vault UTXO must carry a mutable CashTokens NFT state commitment");
    }

    const currentState = decodeVaultCommitment(vaultUtxo.token.nft.commitment);
    const nextMilestone = currentState.milestoneIndex + 1;
    if (nextMilestone > totalMilestones) {
      throw new Error(`Milestone ${nextMilestone} exceeds totalMilestones (${totalMilestones})`);
    }

    const remainingSats = vaultUtxo.satoshis - payoutSats - minerFeeSats;
    const remainingTokens = vaultUtxo.token.amount - payoutTokens;
    if (remainingSats < 0n) {
      throw new Error("Insufficient vault satoshis to cover payout + miner fee");
    }

    const nextState: VaultStateCommitment = {
      milestoneIndex: nextMilestone,
      totalReleasedSats: currentState.totalReleasedSats + payoutSats,
    };
    const nextCommitmentHex = encodeVaultCommitment(nextState);
    const hunterLockingBytecode = pkhToLockingBytecode(hunterPkh);

    const outputs: TxOutput[] = [];

    if (remainingSats > 1000n && nextMilestone < totalMilestones) {
      // Output 0: Covenant continuation UTXO
      const contToken: CashTokenData = {
        categoryId: vaultUtxo.token.categoryId,
        amount: remainingTokens,
        nft: {
          capability: "mutable",
          commitment: nextCommitmentHex,
        },
      };
      outputs.push({
        satoshis: remainingSats,
        lockingBytecode: vaultUtxo.lockingBytecode.toLowerCase(),
        token: contToken,
        cashTokenPrefixHex: encodeCashTokenPrefix(contToken),
      });

      // Output 1: Hunter milestone payout
      const hunterToken: CashTokenData | undefined =
        payoutTokens > 0n
          ? {
              categoryId: vaultUtxo.token.categoryId,
              amount: payoutTokens,
            }
          : undefined;
      outputs.push({
        satoshis: payoutSats,
        lockingBytecode: hunterLockingBytecode,
        token: hunterToken,
        cashTokenPrefixHex: encodeCashTokenPrefix(hunterToken),
      });
    } else {
      // Final milestone drain: Output 0 pays directly to Hunter
      const hunterToken: CashTokenData | undefined =
        payoutTokens > 0n
          ? {
              categoryId: vaultUtxo.token.categoryId,
              amount: payoutTokens,
            }
          : undefined;
      outputs.push({
        satoshis: payoutSats + remainingSats,
        lockingBytecode: hunterLockingBytecode,
        token: hunterToken,
        cashTokenPrefixHex: encodeCashTokenPrefix(hunterToken),
      });
    }

    const rawHex = CashPulseVaultClient.serializeTransaction(2, locktime, vaultUtxo, outputs);
    const txid = crypto
      .createHash("sha256")
      .update(crypto.createHash("sha256").update(Buffer.from(rawHex, "hex")).digest())
      .digest()
      .reverse()
      .toString("hex");

    return {
      version: 2,
      locktime,
      inputs: [
        {
          txid: vaultUtxo.txid,
          vout: vaultUtxo.vout,
          sequence: 0xfffffffe,
          utxo: vaultUtxo,
        },
      ],
      outputs,
      rawHex,
      txid,
      nextCommitmentHex,
      nextState,
    };
  }

  /**
   * Simulate CashScript VM Native Introspection opcodes on a built transaction.
   */
  static verifyCovenantIntrospection(
    tx: BuiltCovenantTransaction,
    expectedHunterPkh: string,
    totalMilestones: number,
    minerFeeSats = 1000n,
  ): IntrospectionVerificationResult {
    const errors: string[] = [];
    const inputUtxo = tx.inputs[0].utxo;
    const prevCommitment = decodeVaultCommitment(inputUtxo.token.nft?.commitment ?? "0000000000000000");
    const expectedLookupScript = pkhToLockingBytecode(expectedHunterPkh);

    const isContinuation = tx.outputs.length === 2;
    const out0 = tx.outputs[0];
    const hunterOut = isContinuation ? tx.outputs[1] : tx.outputs[0];

    const covenantBytecodePreserved = isContinuation
      ? out0.lockingBytecode === inputUtxo.lockingBytecode.toLowerCase()
      : out0.lockingBytecode === expectedLookupScript;
    if (!covenantBytecodePreserved) errors.push("OP_OUTPUTBYTECODE mismatch on Output 0");

    const tokenCategoryPreserved = isContinuation
      ? out0.token?.categoryId === inputUtxo.token.categoryId &&
        (!hunterOut.token || hunterOut.token.categoryId === inputUtxo.token.categoryId)
      : !hunterOut.token || hunterOut.token.categoryId === inputUtxo.token.categoryId;
    if (!tokenCategoryPreserved) errors.push("OP_OUTPUTTOKENCATEGORY mismatch");

    const totalOutTokens = tx.outputs.reduce((acc, o) => acc + (o.token?.amount ?? 0n), 0n);
    const tokenBalanceConserved = isContinuation
      ? totalOutTokens === inputUtxo.token.amount
      : totalOutTokens <= inputUtxo.token.amount;
    if (!tokenBalanceConserved) errors.push("CashTokens fungible sum conservation violated");

    const totalOutSats = tx.outputs.reduce((acc, o) => acc + o.satoshis, 0n);
    const satoshiValueConserved = totalOutSats + minerFeeSats === inputUtxo.satoshis;
    if (!satoshiValueConserved) errors.push("BCH satoshi conservation violated");

    let commitmentIncremented = true;
    if (isContinuation) {
      const nextComm = decodeVaultCommitment(out0.token?.nft?.commitment ?? "0000000000000000");
      commitmentIncremented =
        nextComm.milestoneIndex === prevCommitment.milestoneIndex + 1 &&
        nextComm.milestoneIndex <= totalMilestones &&
        nextComm.totalReleasedSats === prevCommitment.totalReleasedSats + hunterOut.satoshis;
      if (!commitmentIncremented) errors.push("OP_OUTPUTTOKENCOMMITMENT state transition invalid");
    }

    const hunterP2pkhValid = hunterOut.lockingBytecode === expectedLookupScript;
    if (!hunterP2pkhValid) errors.push("Hunter P2PKH lockingBytecode invalid");

    const dustThresholdMet = tx.outputs.every((o) => o.satoshis >= 546n);
    if (!dustThresholdMet) errors.push("Output satoshis below 546 dust threshold");

    return {
      valid: errors.length === 0,
      checks: {
        covenantBytecodePreserved,
        tokenCategoryPreserved,
        tokenBalanceConserved,
        satoshiValueConserved,
        commitmentIncremented,
        hunterP2pkhValid,
        dustThresholdMet,
      },
      errors,
    };
  }

  /**
   * Build a WalletConnect v2 / WizardConnect `bch_signTransaction` JSON-RPC request payload.
   */
  static buildWizardConnectPayload(tx: BuiltCovenantTransaction, userPrompt = "Approve CashPulse Milestone Release") {
    return {
      method: "bch_signTransaction",
      params: {
        transaction: tx.rawHex,
        broadcast: true,
        userPrompt,
        sourceOutputs: tx.inputs.map((inp) => ({
          outpointTransactionHash: inp.txid,
          outpointIndex: inp.vout,
          sequenceNumber: inp.sequence,
          lockingBytecode: inp.utxo.lockingBytecode,
          valueSatoshis: inp.utxo.satoshis.toString(),
          token: {
            category: inp.utxo.token.categoryId,
            amount: inp.utxo.token.amount.toString(),
            nft: inp.utxo.token.nft,
          },
        })),
      },
    };
  }

  private static serializeTransaction(
    version: number,
    locktime: number,
    utxo: VaultUtxo,
    outputs: TxOutput[],
  ): string {
    const verBuf = Buffer.alloc(4);
    verBuf.writeUInt32LE(version, 0);

    const inCount = Buffer.from([1]);
    const prevTxidLE = Buffer.from(utxo.txid, "hex").reverse();
    const voutBuf = Buffer.alloc(4);
    voutBuf.writeUInt32LE(utxo.vout, 0);
    const placeholderSigScript = Buffer.from("41" + "aa".repeat(65), "hex");
    const scriptLen = encodeCompactSize(BigInt(placeholderSigScript.length));
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeUInt32LE(0xfffffffe, 0);

    const outCount = encodeCompactSize(BigInt(outputs.length));
    const outBufs: Buffer[] = [];
    for (const out of outputs) {
      const valBuf = Buffer.alloc(8);
      valBuf.writeBigUInt64LE(out.satoshis, 0);
      const fullLockingHex = `${out.cashTokenPrefixHex}${out.lockingBytecode}`;
      const lockBuf = Buffer.from(fullLockingHex, "hex");
      outBufs.push(valBuf, encodeCompactSize(BigInt(lockBuf.length)), lockBuf);
    }

    const locktimeBuf = Buffer.alloc(4);
    locktimeBuf.writeUInt32LE(locktime, 0);

    return Buffer.concat([
      verBuf,
      inCount,
      prevTxidLE,
      voutBuf,
      scriptLen,
      placeholderSigScript,
      seqBuf,
      outCount,
      ...outBufs,
      locktimeBuf,
    ]).toString("hex");
  }
}
