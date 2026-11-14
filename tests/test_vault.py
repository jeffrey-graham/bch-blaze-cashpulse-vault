import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.bch_vault_engine import (
    VaultUtxo,
    build_milestone_release_tx,
    decode_vault_commitment,
    encode_cashaddr,
    encode_cashtoken_prefix,
    encode_vault_commitment,
    pkh_to_locking_bytecode,
)


class TestCashPulseVault(unittest.TestCase):
    def setUp(self) -> None:
        self.category_id = "7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e"
        self.hunter_pkh = "11223344556677889900aabbccddeeff00112233"
        self.vault_script = "aa20" + ("cc" * 32) + "87"

    def test_cashaddr_encoding(self) -> None:
        q_addr = encode_cashaddr(self.hunter_pkh, "p2pkh")
        z_addr = encode_cashaddr(self.hunter_pkh, "p2pkh-token")
        self.assertTrue(q_addr.startswith("bitcoincash:q"))
        self.assertTrue(z_addr.startswith("bitcoincash:z"))
        self.assertNotEqual(q_addr, z_addr)

    def test_commitment_roundtrip(self) -> None:
        comm = encode_vault_commitment(3, 450_000_000)
        self.assertEqual(len(comm), 16)
        decoded = decode_vault_commitment(comm)
        self.assertEqual(decoded["milestone_index"], 3)
        self.assertEqual(decoded["total_released_sats"], 450_000_000)

    def test_cashtoken_prefix_serialization(self) -> None:
        prefix = encode_cashtoken_prefix(
            self.category_id, amount=2500, nft_capability="mutable", nft_commitment="0100a08601000000"
        )
        self.assertTrue(prefix.startswith("ef"))
        self.assertEqual(prefix[66:68], "71")

    def test_milestone_continuation_and_final_drain(self) -> None:
        utxo = VaultUtxo(
            txid="a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
            vout=0,
            satoshis=500_000,
            locking_bytecode=self.vault_script,
            category_id=self.category_id,
            token_amount=10_000,
            nft_capability="mutable",
            nft_commitment=encode_vault_commitment(0, 0),
        )
        res = build_milestone_release_tx(
            utxo=utxo,
            hunter_pkh=self.hunter_pkh,
            payout_sats=150_000,
            payout_tokens=2_500,
            total_milestones=4,
            miner_fee_sats=1_000,
        )
        self.assertEqual(len(res["outputs"]), 2)
        self.assertEqual(res["outputs"][0]["satoshis"], 349_000)
        self.assertEqual(res["outputs"][0]["token_amount"], 7_500)
        self.assertEqual(res["outputs"][1]["satoshis"], 150_000)
        self.assertEqual(res["outputs"][1]["locking_bytecode"], pkh_to_locking_bytecode(self.hunter_pkh))
        self.assertEqual(len(res["txid"]), 64)

    def test_covenant_contract_preserves_cashtokens_on_refunds(self) -> None:
        cash_path = os.path.join(os.path.dirname(__file__), "..", "contracts", "CashPulseVault.cash")
        with open(cash_path, "r", encoding="utf-8") as f:
            source = f.read()
        self.assertEqual(source.count("require(tx.outputs[0].tokenCategory == fungibleCategory);"), 3)
        self.assertGreaterEqual(source.count("require(tx.outputs[0].tokenAmount >= inputTokens);"), 2)


if __name__ == "__main__":
    unittest.main()
