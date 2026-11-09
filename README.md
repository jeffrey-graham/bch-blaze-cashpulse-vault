# CashPulse Escrow & Micro-Bounty Vault — BCH BLAZE 2026

> **Hackathon**: [BCH BLAZE 2026 (`https://dorahacks.io/hackathon/bchblaze2026`)](https://dorahacks.io/hackathon/bchblaze2026)  
> **Tracks Targeted**: **Mainnet Track ($5,750)** + **Media Track ($1,000 PUSD)** + **TokenHunt $250 Completion Pool Split**  
> **Stack**: CashScript (`^0.10.0`), CHIP-2022-02 CashTokens (`0xef` Prefix + Mutable NFT Commitments), TypeScript/Node.js, Python 3, WizardConnect / WalletConnect v2 (`bch_signTransaction`)

---

## Overview

**CashPulse** is a non-custodial, covenant-enforced micro-bounty and milestone escrow protocol built for **Bitcoin Cash Mainnet**. By combining **CashScript Native Introspection** (`tx.inputs[this.activeInputIndex]`, `tx.outputs[...]`) with **CHIP-2022-02 CashTokens**, CashPulse turns a single UTXO into an autonomous state machine that:

1. **Holds both BCH Satoshis and Fungible CashTokens** inside a self-enforcing P2SH32 covenant (`contracts/CashPulseVault.cash`).
2. **Tracks Milestone State On-Chain via an 8-Byte Mutable NFT Commitment**:
   - `bytes2 milestoneIndex` (`uint16` little-endian completed milestone counter)
   - `bytes6 totalReleasedSats` (`uint48` little-endian cumulative satoshis paid out)
3. **Atomically Enforces Partial Milestone Releases (`releaseMilestone`)**:
   - Verifies that `tx.outputs[0]` preserves the exact `lockingBytecode` and `tokenCategory` of the Vault while incrementing the mutable NFT commitment (`milestoneIndex + 1`).
   - Verifies that `tx.outputs[1]` pays the exact BCH satoshis and fungible CashTokens to the Bounty Hunter's P2PKH locking bytecode (`76a914<hunterPkh>88ac`).
4. **Protects Sponsors & Hunters**:
   - `reclaimExpired`: Uses `tx.time >= timeoutTimestamp` (`OP_CHECKLOCKTIMEVERIFY`) so bounty sponsors can recover unspent BCH + CashTokens if a bounty expires.
   - `arbiterRefund`: 2-of-3 dispute resolution without custodial middlemen.

---

## Repository Structure

```text
bch-blaze-2026/
├── contracts/
│   └── CashPulseVault.cash          # CashScript ^0.10.0 covenant contract (Native Introspection + CashTokens)
├── src/
│   ├── bchVaultClient.ts            # TypeScript BCH TX builder, 0xef prefix serializer, VM verifier & WizardConnect payload builder
│   └── bch_vault_engine.py          # Python reference engine for CashAddr, CashTokens 0xef & covenant state transitions
├── public/
│   └── index.html                   # Interactive BCH BLAZE 2026 Web dApp + Live Covenant State Inspector
├── scripts/
│   └── generate_bch_media.py        # PIL + ffmpeg generator for the Media Track comic PNG & 1080p MP4 showcase
├── media/
│   ├── bch_blaze_comic.png          # 1920x1080 4-panel technical comic & infographic (Media Track)
│   └── bch_blaze_showcase.mp4       # 1920x1080 30fps H.264 animated showcase video (Media Track + Demo)
├── tests/
│   ├── vault.test.ts                # Node/TypeScript unit & covenant introspection test suite
│   └── test_vault.py                # Python unittest suite
├── SUBMISSION_GUIDE.md              # Step-by-step DoraHacks submission & X/Twitter post guide
├── package.json
└── tsconfig.json
```

---

## Quickstart & Verification

### 1. Run TypeScript & Python Unit Tests
```bash
npm test
npm run test:py
```

### 2. Regenerate Media Track Deliverables (`media/bch_blaze_comic.png` & `media/bch_blaze_showcase.mp4`)
```bash
npm run media
```

### 3. Launch the Interactive Web dApp
Open `public/index.html` in any browser (or serve via `python3 -m http.server 8080`) to inspect the mandatory **BCH BLAZE 2026 Banner**, connect via WizardConnect / Cashonize, and build/verify live CashTokens covenant transactions.
