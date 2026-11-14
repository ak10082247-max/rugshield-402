import asyncio
import logging
import os
import httpx
from typing import Dict, Any
from apify import Actor

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("rugshield.apify")

LIVE_RUGSHIELD_URL = "https://rugshield-402.onrender.com/v1/scan"
PREVIEW_RUGSHIELD_URL = "https://rugshield-402.onrender.com/v1/scan/preview"

async def run_actor():
    """
    Apify Pay-Per-Event (PPE) Actor entrypoint for RugShield-402.
    Forwards inputs to live RugShield-402 and charges token_scan only after HTTP 200.
    """
    async with Actor:
        actor_input: Dict[str, Any] = await Actor.get_input() or {}
        token_addr = actor_input.get("token_address") or actor_input.get("token")
        if not isinstance(token_addr, str) or not token_addr.strip():
            await Actor.fail(status_message="Missing required string input: token_address")
            return
        token_addr = token_addr.strip()
        use_preview = bool(actor_input.get("use_free_preview", False))
        logger.info(f"RugShield-402 Apify Actor invoked for token: {token_addr}")

        try:
            service_key = os.environ.get("RUGSHIELD_SERVICE_API_KEY") or os.environ.get("SERVICE_API_KEY")
            payment_sig = actor_input.get("payment_signature")
            headers: Dict[str, str] = {}
            target_url = PREVIEW_RUGSHIELD_URL if use_preview else LIVE_RUGSHIELD_URL
            if service_key:
                headers["x-api-key"] = service_key
            if isinstance(payment_sig, str) and payment_sig.strip():
                headers["PAYMENT-SIGNATURE"] = payment_sig.strip()

            async with httpx.AsyncClient(timeout=25.0) as client:
                resp = await client.post(
                    target_url,
                    headers=headers,
                    json={"token_address": token_addr, "chain": actor_input.get("chain", "base")}
                )
                if resp.status_code != 200:
                    await Actor.fail(
                        status_message=f"RugShield live endpoint returned HTTP {resp.status_code}: {resp.text[:300]}"
                    )
                    return
                result = resp.json()

            if not use_preview:
                await Actor.charge(event_name="token_scan", count=1)

            await Actor.push_data(result)
            logger.info("Successfully pushed RugShield scan result to Apify dataset.")
        except Exception as e:
            logger.error(f"Error during RugShield scan: {e}")
            await Actor.fail(status_message=f"Simulation error: {str(e)}")

if __name__ == "__main__":
    asyncio.run(run_actor())
