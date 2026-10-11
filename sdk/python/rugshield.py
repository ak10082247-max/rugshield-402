"""
RugShield 402 — Python Client for Autonomous AI Agents
Pre-swap token honeypot detection & DEX liquidity verification on Base.
Gated via HTTP 402 Payment Required ($0.005 USDC per scan).
"""

import json
import os
from typing import Any, Dict, Optional
import requests

RUGSHIELD_DEFAULT_ENDPOINT = "https://rugshield-402.onrender.com"

class RugShieldClient:
    def __init__(self, endpoint: str = RUGSHIELD_DEFAULT_ENDPOINT, private_key: Optional[str] = None):
        self.endpoint = endpoint.rstrip("/")
        self.private_key = private_key or os.getenv("BUYER_PRIVATE_KEY") or os.getenv("WALLET_B_PRIVATE_KEY")

    def scan_token(
        self,
        token_address: str,
        chain_id: int = 8453,
        simulate_sell: bool = True
    ) -> Dict[str, Any]:
        """
        Scan a token address on Base for honeypot transfer locks, taxes, and liquidity.
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
            challenge = res.json()
            # If agent has a payment signer configured, settle x402 challenge
            print(f"[RugShield] Received HTTP 402 Payment Required: {challenge.get('detail') or challenge.get('error')}")
            # Resubmit with authorization if available
            return challenge

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
