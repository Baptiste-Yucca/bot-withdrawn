import "dotenv/config";
import { createPublicClient, http, formatUnits, type Address, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";
import { RMM_ADDRESS, TOKENS, SUPPLY_TOKENS, REPAY_EVENT_ABI, SUPPLY_EVENT_ABI, ERC20_BALANCE_OF_ABI } from "./config.js";

function getUserAddress(): Address | null {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return null;

  try {
    const formattedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const account = privateKeyToAccount(formattedKey as `0x${string}`);
    return account.address;
  } catch {
    return null;
  }
}

const USER_ADDR = getUserAddress();

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

function logSupplyEvent(log: Log<bigint, number, false, typeof SUPPLY_EVENT_ABI[0], true>) {
  const { reserve, user, onBehalfOf, amount } = log.args;
  const formattedAmount = formatAmount(amount, reserve);

  console.log("---");
  console.log(`[Supply] Bloc: ${log.blockNumber}`);
  console.log(`  Token: ${reserve}`);
  console.log(`  Montant: ${formattedAmount}`);
  console.log(`  User: ${user}`);
  console.log(`  OnBehalfOf: ${onBehalfOf}`);
}

async function fetchSupplyTokenBalances(address: Address) {
  console.log(`Balances des Supply Tokens pour ${address}:`);

  for (const [tokenAddress, token] of Object.entries(SUPPLY_TOKENS)) {
    try {
      const balance = await client.readContract({
        address: tokenAddress as Address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [address],
      });
      const formattedBalance = formatUnits(balance, token.decimals);
      console.log(`  ${token.symbol}: ${formattedBalance}`);
    } catch (error) {
      console.error(`  Erreur lecture ${token.symbol}:`, (error as Error).message);
    }
  }
  console.log("---");
}

async function watchRMMEvents() {
  console.log(`Ecoute des evenements Repay et Supply sur RMM (${RMM_ADDRESS})...`);
  console.log(`Chain: Gnosis (${gnosis.id})`);
  console.log("---");

  client.watchContractEvent({
    address: RMM_ADDRESS,
    abi: REPAY_EVENT_ABI,
    eventName: "Repay",
    onLogs: (logs) => logs.forEach(logRepayEvent),
    onError: (error) => console.error("Erreur Repay:", error.message),
  });

  client.watchContractEvent({
    address: RMM_ADDRESS,
    abi: SUPPLY_EVENT_ABI,
    eventName: "Supply",
    onLogs: (logs) => logs.forEach(logSupplyEvent),
    onError: (error) => console.error("Erreur Supply:", error.message),
  });
}

async function main() {
  if (USER_ADDR) {
    await fetchSupplyTokenBalances(USER_ADDR);
  } else if (process.env.PRIVATE_KEY) {
    console.log("Cle privee invalide, impossible de deriver l'adresse");
    console.log("---");
  }

  watchRMMEvents();
}

main();
