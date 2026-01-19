import { createPublicClient, http, formatUnits, type Address, type Log } from "viem";
import { gnosis } from "viem/chains";
import { RMM_ADDRESS, TOKENS, REPAY_EVENT_ABI } from "./config.js";

const client = createPublicClient({
  chain: gnosis,
  transport: http(),
});

function formatAmount(amount: bigint, reserve: Address): string {
  const token = TOKENS[reserve];
  if (token) {
    return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
  }
  return `${amount.toString()} (token inconnu: ${reserve})`;
}

function logRepayEvent(log: Log<bigint, number, false, typeof REPAY_EVENT_ABI[0], true>) {
  const { reserve, user, repayer, amount } = log.args;
  const formattedAmount = formatAmount(amount, reserve);

  console.log("---");
  console.log(`[Repay] Bloc: ${log.blockNumber}`);
  console.log(`  Token: ${reserve}`);
  console.log(`  Montant: ${formattedAmount}`);
  console.log(`  User: ${user}`);
  console.log(`  Repayer: ${repayer}`);
}

async function watchRepayEvents() {
  console.log(`Ecoute des evenements Repay sur RMM (${RMM_ADDRESS})...`);
  console.log(`Chain: Gnosis (${gnosis.id})`);
  console.log("---");

  client.watchContractEvent({
    address: RMM_ADDRESS,
    abi: REPAY_EVENT_ABI,
    eventName: "Repay",
    onLogs: (logs) => logs.forEach(logRepayEvent),
    onError: (error) => console.error("Erreur:", error.message),
  });
}

watchRepayEvents();
