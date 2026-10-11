import "dotenv/config";
import { scanToken } from "../services/simulator.js";
import { CONFIG } from "../config.js";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}

export class RugShieldTelegramBot {
  private botToken: string;
  private offset = 0;
  private isRunning = false;

  constructor(token?: string) {
    this.botToken = token || process.env.TELEGRAM_BOT_TOKEN || "";
  }

  private get apiUrl(): string {
    return `https://api.telegram.org/bot${this.botToken}`;
  }

  async sendMessage(
    chatId: number,
    text: string,
    parseMode: "HTML" | "Markdown" = "HTML",
    replyMarkup?: any
  ): Promise<void> {
    try {
      const payload: any = {
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      };
      if (replyMarkup) {
        payload.reply_markup = replyMarkup;
      }
      await fetch(`${this.apiUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("[telegram-bot] Failed to send message:", err);
    }
  }

  async handleText(chatId: number, text: string): Promise<void> {
    const trimmed = text.trim();

    if (trimmed === "/start" || trimmed === "/help") {
      const welcome = `
🛡️ <b>RugShield 402 — Base Token Honeypot Firewall</b>

Paste any ERC-20 contract address on Base (0x...) or send <code>/scan 0x...</code> to simulate honeypots, buy/sell taxes, and liquidity before swapping.

<b>Features:</b>
• Real-time DEX buy/sell simulation
• 99% tax trap detection
• Aerodrome & Uniswap v3 pool depth
• x402 Protocol Gated ($0.005 USDC/scan)

<b>Merchant Payout Address:</b>
<code>${CONFIG.merchantAddress}</code>
`;
      const buttons = {
        inline_keyboard: [
          [
            { text: "🌐 Open Web Scanner", url: "https://rugshield-402.onrender.com/app" },
            { text: "📦 ElizaOS Plugin", url: "https://www.npmjs.com/package/@kurox_real/plugin-rugshield-402" },
          ],
          [
            { text: "🤖 Coinbase AgentKit", url: "https://www.npmjs.com/package/@kurox_real/agentkit-rugshield-402" },
            { text: "⚙️ API Docs (x402)", url: "https://rugshield-402.onrender.com/.well-known/x402.json" },
          ],
        ],
      };
      await this.sendMessage(chatId, welcome, "HTML", buttons);
      return;
    }

    // Extract address from command or direct paste
    const match = trimmed.match(/0x[a-fA-F0-9]{40}/);
    if (!match) {
      if (trimmed.startsWith("/")) {
        await this.sendMessage(chatId, "⚠️ Please provide a valid 42-character Base contract address: <code>/scan 0x...</code>");
      }
      return;
    }

    const tokenAddress = match[0];
    await this.sendMessage(chatId, `🔍 <i>Simulating DEX orders for <code>${tokenAddress}</code> on Base...</i>`);

    try {
      const result = await scanToken({
        token_address: tokenAddress,
        chain_id: 8453,
        simulate_sell: true,
      });

      const isSafe = !result.is_honeypot && result.sell_tax_bps < 1000;
      const statusIcon = isSafe ? "✅" : "🚨";
      const statusText = isSafe ? "SAFE TO SWAP" : "HIGH RISK / DRAINER TRAP";

      const report = `
🛡️ <b>RugShield 402 Audit Report</b>
━━━━━━━━━━━━━━━━━━━━
🏷️ <b>Token:</b> ${result.name} (<code>${result.symbol}</code>)
📍 <b>Address:</b> <code>${result.token}</code>

${statusIcon} <b>Status:</b> <b>${statusText}</b>
${result.is_honeypot ? "🚫 <b>HONEYPOT: YES (Transfers Disabled)</b>\n" : "🟢 <b>Honeypot:</b> None Detected\n"}
📊 <b>Buy Tax:</b> ${(result.buy_tax_bps / 100).toFixed(1)}%
📉 <b>Sell Tax:</b> ${(result.sell_tax_bps / 100).toFixed(1)}%
💧 <b>DEX Liquidity:</b> $${Number(result.liquidity_usd).toLocaleString()}
⚖️ <b>Risk Score:</b> ${(result.risk_score * 100).toFixed(0)} / 100

${(result.risk_factors?.length ?? 0) > 0 ? `⚠️ <b>Risk Factors:</b>\n• ${(result.risk_factors || []).join("\n• ")}\n` : ""}
🔒 <i>Attestation: <code>${result.attestation}</code></i>
⚡ <i>Protected by RugShield 402 on Base</i>
`;

      const scanButtons = {
        inline_keyboard: [
          [
            { text: "📊 DexScreener", url: `https://dexscreener.com/base/${result.token}` },
            { text: "🔍 BaseScan", url: `https://basescan.org/token/${result.token}` },
          ],
          [
            { text: "🌐 Open Web Scanner", url: "https://rugshield-402.onrender.com/app" },
            { text: "⚡ Integration API", url: "https://rugshield-402.onrender.com/.well-known/x402.json" },
          ],
        ],
      };

      await this.sendMessage(chatId, report, "HTML", scanButtons);
    } catch (err: any) {
      await this.sendMessage(chatId, `❌ <b>Scan Error:</b> ${err.message}`);
    }
  }

  async startPolling(): Promise<void> {
    if (!this.botToken) {
      console.warn("[telegram-bot] No TELEGRAM_BOT_TOKEN provided. Bot is in standby mode.");
      return;
    }

    this.isRunning = true;
    console.log("[telegram-bot] RugShield Telegram Bot polling started...");

    while (this.isRunning) {
      try {
        const res = await fetch(
          `${this.apiUrl}/getUpdates?offset=${this.offset}&timeout=30`
        );
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            this.offset = update.update_id + 1;
            if (update.message?.text && update.message.chat?.id) {
              await this.handleText(update.message.chat.id, update.message.text);
            }
          }
        }
      } catch (err) {
        console.error("[telegram-bot] Polling error:", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.isRunning = false;
  }
}
