/**
 * Anti-Cold-Start Heartbeat Daemon
 * Automatically pings the service health check every 9 minutes
 * to prevent free-tier cloud containers from sleeping.
 */

let heartbeatTimer: NodeJS.Timeout | null = null;

export function startHeartbeat(targetUrl: string, intervalMs = 9 * 60 * 1000): void {
  if (heartbeatTimer) return;

  const healthEndpoint = `${targetUrl.replace(/\/$/, "")}/health`;

  // First ping after 1 minute, then recurring every 9 minutes
  heartbeatTimer = setInterval(async () => {
    try {
      const res = await fetch(healthEndpoint, {
        headers: { "User-Agent": "RugShield-Heartbeat/1.0" },
      });
      const data = await res.json().catch(() => ({}));
      console.log(`[heartbeat] Pinged ${healthEndpoint} - Status ${res.status}`);
    } catch (err: any) {
      console.warn(`[heartbeat] Ping failed: ${err.message}`);
    }
  }, intervalMs);

  // Allow process to exit cleanly if needed
  if (heartbeatTimer.unref) {
    heartbeatTimer.unref();
  }
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
