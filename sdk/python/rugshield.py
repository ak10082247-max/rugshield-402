"""
RugShield 402 — Python Client for Autonomous AI Agents
Pre-swap token honeypot detection & DEX liquidity verification on Base.
Gated via HTTP 402 Payment Required ($0.010 USDC per scan).
Supports 100% gasless automated settlement on Base Mainnet (eip155:8453).
"""

import base64
import json
import os
import secrets
import time
from typing import Any, Dict, Optional
import requests

RUGSHIELD_DEFAULT_ENDPOINT = "https://rugshield-402.onrender.com"

class RugShieldClient:
    def __init__(self, endpoint: str = RUGSHIELD_DEFAULT_ENDPOINT, private_key: Optional[str] = None):
        self.endpoint = endpoint.rstrip("/")
        self.private_key = private_key or os.getenv("BUYER_PRIVATE_KEY") or os.getenv("WALLET_B_PRIVATE_KEY")

    def _sign_base_payment(self, x402_pr: Dict[str, Any], accepted: Dict[str, Any]) -> str:
        """
        Signs an EIP-712 TransferWithAuthorization payload for Base Mainnet (8453).
        Gasless: Zero ETH required, sponsored by Coinbase CDP Facilitator.
        """
        from eth_account import Account
        from eth_account.messages import encode_typed_data

        account = Account.from_key(self.private_key)
        now = int(time.time())
        nonce_bytes = secrets.token_bytes(32)
        nonce_hex = "0x" + nonce_bytes.hex()

        chain_id = 8453
        token_contract = accepted.get("asset", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
        pay_to = accepted["payTo"]
        amount = int(accepted["amount"])

        types = {
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ]
        }

        domain = {
            "name": "USD Coin",
            "version": "2",
            "chainId": chain_id,
            "verifyingContract": token_contract,
        }

        message = {
            "from": account.address,
            "to": pay_to,
            "value": amount,
            "validAfter": 0,
            "validBefore": now + 300,
            "nonce": nonce_bytes,
        }

        signable = encode_typed_data(domain_data=domain, message_types=types, message_data=message)
        signed = account.sign_message(signable)
        sig_hex = signed.signature.hex()
        if not sig_hex.startswith("0x"):
            sig_hex = "0x" + sig_hex

        payment_payload = {
            "x402Version": 2,
            "resource": x402_pr.get("resource"),
            "accepted": accepted,
            "payload": {
                "signature": sig_hex,
                "authorization": {
                    "from": account.address,
                    "to": pay_to,
                    "value": str(amount),
                    "validAfter": "0",
                    "validBefore": str(now + 300),
                    "nonce": nonce_hex,
                },
            },
        }

        return base64.b64encode(json.dumps(payment_payload).encode("utf-8")).decode("utf-8")

    def scan_token(
        self,
        token_address: str,
        chain_id: int = 8453,
        simulate_sell: bool = True
    ) -> Dict[str, Any]:
        """
        Scan a token address on Base for honeypot transfer locks, taxes, and liquidity.
        Automatically settles x402 challenge if private_key is configured.
        """
        payload = {
            "token_address": token_address,
            "chain_id": chain_id,
            "simulate_sell": simulate_sell
        }

        url = f"{self.endpoint}/v1/scan"
        res = requests.post(url, json=payload, headers={"Content-Type": "application/json"})

        if res.status_code == 200:
            return res.json()

        if res.status_code == 402:
            challenge_body = res.json()
            raw_pr = res.headers.get("PAYMENT-REQUIRED") or res.headers.get("X-Payment-Required")

            if self.private_key and raw_pr:
                try:
                    pr_json = json.loads(base64.b64decode(raw_pr).decode("utf-8"))
                    accepted = None
                    for opt in pr_json.get("accepts", []):
                        if str(opt.get("network", "")).startswith("eip155:8453"):
                            accepted = opt
                            break
                    if not accepted and pr_json.get("accepts"):
                        accepted = pr_json["accepts"][0]

                    if accepted:
                        payment_sig = self._sign_base_payment(pr_json, accepted)
                        paid_res = requests.post(
                            url,
                            json=payload,
                            headers={
                                "Content-Type": "application/json",
                                "PAYMENT-SIGNATURE": payment_sig,
                                "X-PAYMENT": payment_sig,
                            },
                        )
                        if paid_res.status_code == 200:
                            return paid_res.json()
                except Exception as exc:
                    print(f"[RugShield] Auto-settlement notice: {exc}")

            return challenge_body

        raise RuntimeError(f"Scan failed with status {res.status_code}: {res.text}")

    def is_safe_to_swap(self, token_address: str) -> bool:
        """
        Boolean pre-flight check for autonomous trading execution loops.
        """
        try:
            result = self.scan_token(token_address)
            is_honeypot = result.get("is_honeypot", False)
            sell_tax = result.get("sell_tax_bps", 0)
            return (not is_honeypot) and (sell_tax < 1000)
        except Exception:
            return False

if __name__ == "__main__":
    client = RugShieldClient()
    weth = "0x4200000000000000000000000000000000000006"
    print(f"Checking WETH ({weth})...")
    res = client.scan_token(weth)
    print(json.dumps(res, indent=2))
