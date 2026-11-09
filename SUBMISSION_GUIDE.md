# DoraHacks Submission Guide — BCH BLAZE 2026

- **Hackathon URL**: `https://dorahacks.io/hackathon/bchblaze2026`
- **Eligible Pools**:
  1. **Mainnet Track ($5,750 Pool)** — CashScript Covenant (`contracts/CashPulseVault.cash`) + CashTokens `0xef` UTXO state machine + WizardConnect dApp (`public/index.html`).
  2. **Media Track ($1,000 PUSD Pool)** — High-resolution 4-panel technical comic (`media/bch_blaze_comic.png`) + 1080p animated MP4 showcase (`media/bch_blaze_showcase.mp4`).
  3. **TokenHunt $250 Completion Pool Split** — Automatic split among all completed, valid BCH Blaze 2026 submissions.

---

## Submission Checklist

1. **Mandatory BCH BLAZE 2026 Banner**: Included at the top of `public/index.html`, `media/bch_blaze_comic.png`, and `media/bch_blaze_showcase.mp4`.
2. **GitHub Repository**: Push `/home/jeff/.gemini/antigravity/scratch/freelancework/pool-contests/bch-blaze-2026/` to a public GitHub repository.
3. **Demo Video & Media Track Assets**:
   - Upload `media/bch_blaze_showcase.mp4` (`1920x1080`, H.264 MP4) as the BUIDL demo video.
   - Attach `media/bch_blaze_comic.png` (`1920x1080` 4-panel comic infographic) in the BUIDL gallery and Media Track submission field.
4. **DoraHacks BUIDL Description**:
   ```markdown
   CashPulse is a trustless, sub-cent micro-bounty and streaming escrow protocol built on Bitcoin Cash Mainnet using CashScript Native Introspection (`contracts/CashPulseVault.cash`) and CHIP-2022-02 CashTokens (`0xef` UTXO prefix). Each Vault UTXO stores its milestone progress on-chain inside an 8-byte mutable NFT commitment (`[milestoneIndex(2B), totalReleasedSats(6B)]`) while enforcing atomic BCH + fungible CashTokens payouts to bounty hunters via `OP_OUTPUTBYTECODE` and `OP_OUTPUTTOKENCOMMITMENT`. Includes a full TypeScript & Python transaction builder/verifier, an interactive WizardConnect (`bch_signTransaction`) web dApp (`public/index.html`), and Media Track educational assets (`media/bch_blaze_comic.png` & `media/bch_blaze_showcase.mp4`).
   ```
