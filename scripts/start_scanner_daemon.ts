import { startAutonomousScanner } from "../src/workers/autonomous_scanner.js";

console.log("=========================================================");
console.log("RUGSHIELD 402 - AUTONOMOUS BASE TOKEN SCANNER DAEMON");
console.log("Target: Live Base Mainnet DEX Pools (Aerodrome & Uniswap)");
console.log("=========================================================");

// Poll every 5 minutes
startAutonomousScanner(5 * 60 * 1000);
