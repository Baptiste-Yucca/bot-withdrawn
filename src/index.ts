import "dotenv/config";
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, type Address, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";
import { isAddress } from "viem";
import { RMM_ADDRESS, TOKENS, SUPPLY_TOKENS, REPAY_EVENT_ABI, SUPPLY_EVENT_ABI, ERC20_BALANCE_OF_ABI, WITHDRAW_ABI, ERC20_TRANSFER_ABI } from "./config.js";

// Gas configuration from ENV
const GAS_PRICE_GWEI = parseFloat(process.env.GAS_PRICE_GWEI ?? "2");
const GAS_MAX_COST_USD = parseFloat(process.env.GAS_MAX_COST_USD ?? "0"); // 0 = no limit
const GAS_TRANSFER_DEST_GWEI = parseFloat(process.env.GAS_TRANSFER_DEST_GWEI ?? "2");

// Destination address for forwarding withdrawn funds (optional)
const DEST_ADDRESS: Address | null = (() => {
  const addr = process.env.DEST_ADDRESS;
  if (!addr || addr === "your_destination_address_here") return null;
  if (isAddress(addr)) return addr as Address;
  console.warn(`DEST_ADDRESS invalide: ${addr}`);
  return null;
})();

function getAccount() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return null;

  try {
    const formattedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return privateKeyToAccount(formattedKey as `0x${string}`);
  } catch {
    return null;
  }
}

const account = getAccount();
const USER_ADDR = account?.address ?? null;

const initialBalances: Record<Address, bigint> = {};
const poolLiquidity: Record<Address, bigint> = {};

const client = createPublicClient({
  chain: gnosis,
  transport: http(),
});

const walletClient = account
  ? createWalletClient({
      account,
      chain: gnosis,
      transport: http(),
    })
  : null;

function formatAmount(amount: bigint, reserve: Address): string {
  const token = TOKENS[reserve];
  if (token) {
    return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
  }
  return `${amount.toString()} (token inconnu: ${reserve})`;
}

function isStablecoin(reserve: Address): boolean {
  return reserve in TOKENS;
}

async function refreshAndWithdraw(): Promise<void> {
  if (!USER_ADDR) return;

  // Rafraichir les balances et liquidites
  await fetchAndStoreSupplyTokenBalances(USER_ADDR);
  await fetchAndStorePoolLiquidity();
  // Tenter le withdraw
  await withdrawAllAvailable();
}

async function handleRepayEvent(reserve: Address, user: Address, repayer: Address, amount: bigint, blockNumber: bigint | null) {
  if (!isStablecoin(reserve)) return;

  const formattedAmount = formatAmount(amount, reserve);

  console.log("---");
  console.log(`[Repay] Bloc: ${blockNumber}`);
  console.log(`  Token: ${reserve}`);
  console.log(`  Montant: ${formattedAmount}`);
  console.log(`  User: ${user}`);
  console.log(`  Repayer: ${repayer}`);

  // Un repay a libere de la liquidite, tenter un withdraw
  await refreshAndWithdraw();
}

async function handleSupplyEvent(reserve: Address, user: Address, onBehalfOf: Address, amount: bigint, blockNumber: bigint | null) {
  if (!isStablecoin(reserve)) return;

  const formattedAmount = formatAmount(amount, reserve);

  console.log("---");
  console.log(`[Supply] Bloc: ${blockNumber}`);
  console.log(`  Token: ${reserve}`);
  console.log(`  Montant: ${formattedAmount}`);
  console.log(`  User: ${user}`);
  console.log(`  OnBehalfOf: ${onBehalfOf}`);

  // Un supply a ajoute de la liquidite, tenter un withdraw
  await refreshAndWithdraw();
}

async function fetchAndStoreSupplyTokenBalances(address: Address) {
  console.log(`Balances initiales des Supply Tokens pour ${address}:`);

  for (const [tokenAddress, token] of Object.entries(SUPPLY_TOKENS)) {
    try {
      const balance = await client.readContract({
        address: tokenAddress as Address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [address],
      });
      initialBalances[tokenAddress as Address] = balance;
      const formattedBalance = formatUnits(balance, token.decimals);
      console.log(`  ${token.symbol}: ${formattedBalance}`);
    } catch (error) {
      console.error(`  Erreur lecture ${token.symbol}:`, (error as Error).message);
    }
  }
  console.log("---");
}

async function fetchAndStorePoolLiquidity() {
  console.log("Liquidite disponible dans les pools:");

  for (const [supplyTokenAddress, supplyToken] of Object.entries(SUPPLY_TOKENS)) {
    const stablecoin = TOKENS[supplyToken.associatedReserve];
    if (!stablecoin) continue;

    try {
      const balance = await client.readContract({
        address: supplyToken.associatedReserve,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [supplyTokenAddress as Address],
      });
      poolLiquidity[supplyToken.associatedReserve] = balance;
      const formattedBalance = formatUnits(balance, stablecoin.decimals);
      console.log(`  ${stablecoin.symbol} dans ${supplyToken.symbol}: ${formattedBalance}`);
    } catch (error) {
      console.error(`  Erreur lecture liquidite ${stablecoin.symbol}:`, (error as Error).message);
    }
  }
  console.log("---");
}

function calculateWithdrawAmount(userBalance: bigint, poolLiquidity: bigint): bigint {
  // Retourne le minimum entre la balance user et la liquidite disponible
  return userBalance <= poolLiquidity ? userBalance : poolLiquidity;
}

/**
 * Calculate gas parameters for withdraw transaction.
 * Returns:
 * - GasParams object with configured gas price
 * - null if withdraw should be skipped (gas cost exceeds limit)
 *
 * Configuration (ENV):
 * - GAS_PRICE_GWEI: Gas price in Gwei (default 2)
 * - GAS_MAX_COST_USD: Max gas cost in USD/xDAI, skip if exceeded (0 = no limit)
 */
async function calculateGasParams(
  reserveAddress: Address,
  amount: bigint
): Promise<{ gasPrice: bigint; gas: bigint } | null> {
  if (!USER_ADDR) return null;

  try {
    const gasPrice = parseUnits(GAS_PRICE_GWEI.toString(), 9);

    // Estimate gas limit
    const gasEstimate = await client.estimateContractGas({
      address: RMM_ADDRESS,
      abi: WITHDRAW_ABI,
      functionName: "withdraw",
      args: [reserveAddress, amount, USER_ADDR],
      account: USER_ADDR,
    });

    // Add 20% buffer to gas estimate for safety
    const gasLimit = (gasEstimate * 120n) / 100n;

    // Calculate estimated gas cost in xDAI (18 decimals, ~1 USD)
    const gasCostWei = gasLimit * gasPrice;
    const gasCostUSD = parseFloat(formatUnits(gasCostWei, 18));

    console.log(`  [Gas] Price: ${GAS_PRICE_GWEI} Gwei, Estimate: ${gasEstimate}, Limit: ${gasLimit}`);
    console.log(`  [Gas] Cout estime: ${gasCostUSD.toFixed(6)} xDAI`);

    // Check against max cost limit if set
    if (GAS_MAX_COST_USD > 0 && gasCostUSD > GAS_MAX_COST_USD) {
      console.log(`  [SKIP] Frais de gas (${gasCostUSD.toFixed(6)} xDAI) > limite (${GAS_MAX_COST_USD} USD)`);
      return null;
    }

    return {
      gasPrice,
      gas: gasLimit,
    };
  } catch (error) {
    console.error(`  Erreur calcul gas:`, (error as Error).message);
    return null;
  }
}

async function executeWithdraw(
  supplyTokenAddress: Address,
  reserveAddress: Address,
  amount: bigint
): Promise<boolean> {
  if (!walletClient || !USER_ADDR) {
    console.error("Wallet non configure, impossible d'executer le withdraw");
    return false;
  }

  const supplyToken = SUPPLY_TOKENS[supplyTokenAddress];
  const stablecoin = TOKENS[reserveAddress];

  if (!supplyToken || !stablecoin) {
    console.error("Token non trouve");
    return false;
  }

  try {
    const amountDisplay = formatUnits(amount, stablecoin.decimals);

    console.log(`[Withdraw] Execution pour ${supplyToken.symbol}...`);
    console.log(`  Reserve: ${stablecoin.symbol}`);
    console.log(`  Montant: ${amountDisplay}`);

    // Calculer les parametres de gas
    const gasParams = await calculateGasParams(reserveAddress, amount);
    if (gasParams === null) {
      return false;
    }

    const hash = await walletClient.writeContract({
      address: RMM_ADDRESS,
      abi: WITHDRAW_ABI,
      functionName: "withdraw",
      args: [reserveAddress, amount, USER_ADDR],
      gasPrice: gasParams.gasPrice,
      gas: gasParams.gas,
    });

    console.log(`  Transaction envoyee: ${hash}`);

    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`  Transaction confirmee dans le bloc ${receipt.blockNumber}`);
    console.log(`  Status: ${receipt.status === "success" ? "Succes" : "Echec"}`);

    // If withdraw succeeded and DEST_ADDRESS is set, transfer funds
    if (receipt.status === "success" && DEST_ADDRESS) {
      await transferToDestination(reserveAddress, amount);
    }

    return receipt.status === "success";
  } catch (error) {
    console.error(`  Erreur withdraw ${supplyToken.symbol}:`, (error as Error).message);
    return false;
  }
}

/**
 * Transfer stablecoins (USDC or WXDAI) to DEST_ADDRESS.
 * Uses a fixed low gas price (2 gwei) for the transfer.
 */
async function transferToDestination(
  tokenAddress: Address,
  amount: bigint
): Promise<boolean> {
  if (!walletClient || !USER_ADDR || !DEST_ADDRESS) {
    return false;
  }

  const token = TOKENS[tokenAddress];
  if (!token) {
    console.error(`[Transfer] Token inconnu: ${tokenAddress}`);
    return false;
  }

  try {
    const amountDisplay = formatUnits(amount, token.decimals);
    console.log(`[Transfer] Envoi de ${amountDisplay} ${token.symbol} vers ${DEST_ADDRESS}...`);

    const gasPrice = parseUnits(GAS_TRANSFER_DEST_GWEI.toString(), 9);

    const hash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [DEST_ADDRESS, amount],
      gasPrice,
    });

    console.log(`  Transaction envoyee: ${hash}`);

    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`  Transaction confirmee dans le bloc ${receipt.blockNumber}`);
    console.log(`  Status: ${receipt.status === "success" ? "Succes" : "Echec"}`);

    return receipt.status === "success";
  } catch (error) {
    console.error(`  Erreur transfer ${token.symbol}:`, (error as Error).message);
    return false;
  }
}

async function withdrawAllAvailable(): Promise<void> {
  if (!USER_ADDR) {
    console.log("Pas d'adresse utilisateur, skip withdraw");
    return;
  }

  console.log("---");
  console.log("[Withdraw] Verification des positions a retirer...");

  for (const [supplyTokenAddress, supplyToken] of Object.entries(SUPPLY_TOKENS)) {
    const userBalance = initialBalances[supplyTokenAddress as Address] ?? 0n;
    const liquidity = poolLiquidity[supplyToken.associatedReserve] ?? 0n;
    const stablecoin = TOKENS[supplyToken.associatedReserve];

    if (!stablecoin) continue;

    if (userBalance === 0n) {
      console.log(`  ${supplyToken.symbol}: Pas de position`);
      continue;
    }

    if (liquidity === 0n) {
      console.log(`  ${supplyToken.symbol}: Pas de liquidite disponible`);
      continue;
    }

    const withdrawAmount = calculateWithdrawAmount(userBalance, liquidity);

    console.log(`  ${supplyToken.symbol}: Balance ${formatUnits(userBalance, supplyToken.decimals)}, Liquidite ${formatUnits(liquidity, stablecoin.decimals)}`);
    console.log(`    -> Retrait: ${formatUnits(withdrawAmount, stablecoin.decimals)} ${stablecoin.symbol}`);

    await executeWithdraw(
      supplyTokenAddress as Address,
      supplyToken.associatedReserve,
      withdrawAmount
    );
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
    onLogs: (logs) => {
      for (const log of logs) {
        const { reserve, user, repayer, amount } = log.args;
        if (reserve && user && repayer && amount !== undefined) {
          handleRepayEvent(reserve, user, repayer, amount, log.blockNumber);
        }
      }
    },
    onError: (error) => console.error("Erreur Repay:", error.message),
  });

  client.watchContractEvent({
    address: RMM_ADDRESS,
    abi: SUPPLY_EVENT_ABI,
    eventName: "Supply",
    onLogs: (logs) => {
      for (const log of logs) {
        const { reserve, user, onBehalfOf, amount } = log.args;
        if (reserve && user && onBehalfOf && amount !== undefined) {
          handleSupplyEvent(reserve, user, onBehalfOf, amount, log.blockNumber);
        }
      }
    },
    onError: (error) => console.error("Erreur Supply:", error.message),
  });
}

function displayConfig() {
  console.log("Configuration:");
  console.log(`  Gas price:          ${GAS_PRICE_GWEI} Gwei`);
  console.log(`  Gas max cost:       ${GAS_MAX_COST_USD > 0 ? `${GAS_MAX_COST_USD} $` : "no limit"}`);
  console.log(`  DEST_ADDRESS:       ${DEST_ADDRESS ?? "disabled"}`);
  if (DEST_ADDRESS) {
    console.log(`  Gas transfer dest:  ${GAS_TRANSFER_DEST_GWEI} Gwei`);
  }
  console.log("---");
}

async function main() {
  displayConfig();

  if (USER_ADDR) {
    await fetchAndStoreSupplyTokenBalances(USER_ADDR);
  } else if (process.env.PRIVATE_KEY) {
    console.log("Cle privee invalide, impossible de deriver l'adresse");
    console.log("---");
  }
  await fetchAndStorePoolLiquidity();

  // Tenter un withdraw au demarrage si l'user a des positions
  if (USER_ADDR && walletClient) {
    await withdrawAllAvailable();
  }

  watchRMMEvents();
}

main();
