import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

import { RugShieldTelegramBot } from "../src/bot/telegram.js";

async function run() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("=========================================================");
    console.log("RUGSHIELD TELEGRAM BOT (STANDBY)");
    console.log("To activate the live Telegram bot, add to .env.local:");
    console.log("TELEGRAM_BOT_TOKEN=your_botfather_token_here");
    console.log("Then run: npx tsx scripts/start_telegram_bot.ts");
    console.log("=========================================================");
    return;
  }

  const bot = new RugShieldTelegramBot(token);
  await bot.startPolling();
}

run().catch(console.error);
