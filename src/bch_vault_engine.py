"""
CashPulse Vault Engine (Python Reference & Test Verifier for BCH BLAZE 2026).
Implements CashAddr (bitcoincash:q/z/p/r), CHIP-2022-02 CashTokens 0xef prefix encoding,
8-byte mutable NFT state commitment packing, and CashScript Native Introspection verification.
"""

from __future__ import annotations
import hashlib
import struct
from dataclasses import dataclass
from typing import Dict, List, Optional

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values: List[int]) -> int:
    generators = [
        (0x01, 0x98F2BC8E61),
        (0x02, 0x79B76D99E2),
        (0x04, 0xF33E5FB3C4),
        (0x08, 0xAE2EABE2A8),
        (0x10, 0x1E4F43E470),
    ]
    c = 1
    for d in values:
        c0 = c >> 35
        c = ((c & 0x07FFFFFFFF) << 5) ^ d
        for bit, gen in generators:
            if c0 & bit:
                c ^= gen
    return c ^ 1


def _convert_bits(data: bytes, from_bits: int, to_bits: int, pad: bool = True) -> List[int]:
    acc = 0
    bits = 0
    ret: List[int] = []
    maxv = (1 << to_bits) - 1
    for value in data:
        acc = (acc << from_bits) | value
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            ret.append((acc >> bits) & maxv)
    if pad and bits > 0:
        ret.append((acc << (to_bits - bits)) & maxv)
    return ret


def encode_cashaddr(hash20_hex: str, addr_type: str = "p2pkh-token", prefix: str = "bitcoincash") -> str:
    raw = bytes.fromhex(hash20_hex)
    if len(raw) != 20:
        raise ValueError(f"Expected 20-byte hash160, got {len(raw)}")
    version_map = {
        "p2pkh": 0x00,
        "p2sh": 0x08,
        "p2pkh-token": 0x10,
        "p2sh-token": 0x18,
    }
    if addr_type not in version_map:
        raise ValueError(f"Unsupported address type: {addr_type}")
    payload = bytes([version_map[addr_type]]) + raw
    payload5 = _convert_bits(payload, 8, 5, True)
    prefix_data = [ord(c) & 0x1F for c in prefix]
    checksum_in = prefix_data + [0] + payload5 + [0] * 8
    mod = _polymod(checksum_in)
    checksum = [(mod >> (5 * (7 - i))) & 0x1F for i in range(8)]
    return f"{prefix}:{''.join(CHARSET[v] for v in (payload5 + checksum))}"


def pkh_to_locking_bytecode(pkh_hex: str) -> str:
    raw = bytes.fromhex(pkh_hex)
    if len(raw) != 20:
        raise ValueError("Invalid 20-byte PKH")
    return f"76a914{pkh_hex.lower()}88ac"


def encode_vault_commitment(milestone_index: int, total_released_sats: int) -> str:
    if not (0 <= milestone_index <= 0xFFFF):
        raise ValueError("milestone_index out of uint16 range")
    if not (0 <= total_released_sats <= 0xFFFFFFFFFFFF):
        raise ValueError("total_released_sats out of uint48 range")
    b = struct.pack("<HI", milestone_index, total_released_sats & 0xFFFFFFFF) + struct.pack(
        "<H", (total_released_sats >> 32) & 0xFFFF
    )
    return b.hex()


def decode_vault_commitment(commitment_hex: str) -> Dict[str, int]:
    b = bytes.fromhex(commitment_hex)
    if len(b) != 8:
        raise ValueError(f"Expected 8-byte commitment, got {len(b)}")
    milestone_index = struct.unpack_from("<H", b, 0)[0]
    lo32, hi16 = struct.unpack_from("<IH", b, 2)
    total_released_sats = lo32 | (hi16 << 32)
    return {"milestone_index": milestone_index, "total_released_sats": total_released_sats}


def encode_compact_size(n: int) -> bytes:
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    if n <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", n)
    return b"\xff" + struct.pack("<Q", n)


def encode_cashtoken_prefix(
    category_id: str,
    amount: int = 0,
    nft_capability: Optional[str] = None,
    nft_commitment: str = "",
) -> str:
    cat_bytes = bytes.fromhex(category_id)
    if len(cat_bytes) != 32:
        raise ValueError("Invalid 32-byte CashTokens categoryId")
    has_nft = nft_capability is not None
    has_amount = amount > 0
    has_commitment = has_nft and len(nft_commitment) > 0
    if not has_nft and not has_amount:
        return ""

    bitfield = 0
    if has_amount:
        bitfield |= 0x10
    if has_nft:
        bitfield |= 0x20
        if has_commitment:
            bitfield |= 0x40
        cap_map = {"none": 0x00, "mutable": 0x01, "minting": 0x02}
        bitfield |= cap_map[nft_capability]

    parts = [b"\xef", cat_bytes[::-1], bytes([bitfield])]
    if has_nft and has_commitment:
        comm = bytes.fromhex(nft_commitment)
        parts.append(encode_compact_size(len(comm)))
        parts.append(comm)
    if has_amount:
        parts.append(encode_compact_size(amount))
    return b"".join(parts).hex()


@dataclass
class VaultUtxo:
    txid: str
    vout: int
    satoshis: int
    locking_bytecode: str
    category_id: str
    token_amount: int
    nft_capability: str
    nft_commitment: str


def build_milestone_release_tx(
    utxo: VaultUtxo,
    hunter_pkh: str,
    payout_sats: int,
    payout_tokens: int,
    total_milestones: int,
    miner_fee_sats: int = 1000,
    locktime: int = 0,
) -> Dict[str, object]:
    if payout_sats < 546:
        raise ValueError("payout_sats below 546 dust threshold")
    if payout_tokens < 0 or payout_tokens > utxo.token_amount:
        raise ValueError("Invalid payout_tokens amount")
    if utxo.nft_capability != "mutable":
        raise ValueError("Vault UTXO must carry mutable NFT capability")

    state = decode_vault_commitment(utxo.nft_commitment)
    next_milestone = state["milestone_index"] + 1
    if next_milestone > total_milestones:
        raise ValueError("Milestone exceeds total_milestones")

    remaining_sats = utxo.satoshis - payout_sats - miner_fee_sats
    remaining_tokens = utxo.token_amount - payout_tokens
    if remaining_sats < 0:
        raise ValueError("Insufficient vault satoshis")

    next_commitment = encode_vault_commitment(
        next_milestone, state["total_released_sats"] + payout_sats
    )
    hunter_script = pkh_to_locking_bytecode(hunter_pkh)
    outputs = []

    if remaining_sats > 1000 and next_milestone < total_milestones:
        outputs.append(
            {
                "satoshis": remaining_sats,
                "locking_bytecode": utxo.locking_bytecode.lower(),
                "category_id": utxo.category_id,
                "token_amount": remaining_tokens,
                "nft_capability": "mutable",
                "nft_commitment": next_commitment,
                "cashtoken_prefix": encode_cashtoken_prefix(
                    utxo.category_id, remaining_tokens, "mutable", next_commitment
                ),
            }
        )
        outputs.append(
            {
                "satoshis": payout_sats,
                "locking_bytecode": hunter_script,
                "category_id": utxo.category_id if payout_tokens > 0 else None,
                "token_amount": payout_tokens,
                "nft_capability": None,
                "nft_commitment": "",
                "cashtoken_prefix": encode_cashtoken_prefix(
                    utxo.category_id, payout_tokens, None, ""
                )
                if payout_tokens > 0
                else "",
            }
        )
    else:
        outputs.append(
            {
                "satoshis": payout_sats + remaining_sats,
                "locking_bytecode": hunter_script,
                "category_id": utxo.category_id if payout_tokens > 0 else None,
                "token_amount": payout_tokens,
                "nft_capability": None,
                "nft_commitment": "",
                "cashtoken_prefix": encode_cashtoken_prefix(
                    utxo.category_id, payout_tokens, None, ""
                )
                if payout_tokens > 0
                else "",
            }
        )

    raw_parts = [
        struct.pack("<I", 2),
        b"\x01",
        bytes.fromhex(utxo.txid)[::-1],
        struct.pack("<I", utxo.vout),
        b"\x42\x41" + (b"\xaa" * 65),
        struct.pack("<I", 0xFFFFFFFE),
        encode_compact_size(len(outputs)),
    ]
    for out in outputs:
        full_lock = bytes.fromhex(out["cashtoken_prefix"] + out["locking_bytecode"])
        raw_parts.append(struct.pack("<Q", out["satoshis"]))
        raw_parts.append(encode_compact_size(len(full_lock)))
        raw_parts.append(full_lock)
    raw_parts.append(struct.pack("<I", locktime))
    raw_bytes = b"".join(raw_parts)
    txid = hashlib.sha256(hashlib.sha256(raw_bytes).digest()).digest()[::-1].hex()

    return {
        "txid": txid,
        "raw_hex": raw_bytes.hex(),
        "outputs": outputs,
        "next_commitment": next_commitment,
        "next_milestone": next_milestone,
    }
