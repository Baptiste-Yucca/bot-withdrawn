import "dotenv/config";
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, type Address, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";
import { isAddress } from "viem";
import { RMM_ADDRESS, TOKENS, SUPPLY_TOKENS, REPAY_EVENT_ABI, SUPPLY_EVENT_ABI, WITHDRAW_EVENT_ABI, ERC20_BALANCE_OF_ABI, WITHDRAW_ABI, ERC20_TRANSFER_ABI } from "./config.js";

// Withdraw configuration from ENV
const MIN_WITHDRAW_USD = parseFloat(process.env.MIN_WITHDRAW_USD ?? "0.01");
const REFRESH_INTERVAL_MIN = parseFloat(process.env.REFRESH_INTERVAL_MIN ?? "5");
const CHECK_LIQUIDITY_BEFORE = process.env.CHECK_LIQUIDITY_BEFORE === "1";

// Gas configuration from ENV (USD-based strategy)
// gasPrice is computed so that: gasPrice × gasLimit ≤ GAS_MAX_COST_USD
const GAS_LIMIT_WITHDRAW = BigInt(process.env.GAS_LIMIT_WITHDRAW ?? "300000");
const GAS_MAX_COST_USD = parseFloat(process.env.GAS_MAX_COST_USD ?? "0.01");
const GAS_MIN_PRICE_GWEI = parseFloat(process.env.GAS_MIN_PRICE_GWEI ?? "1"); // Skip if derived price < min

// Transfer config (simple Gwei-based)
const GAS_TRANSFER_PRICE_GWEI = parseFloat(process.env.GAS_TRANSFER_PRICE_GWEI ?? "1");

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

// Balances suivies localement (fetch 1x au demarrage, puis mises a jour apres withdraw)
const userBalances: Record<Address, bigint> = {};
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

function timestamp(): string {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

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

async function tryWithdraw(): Promise<void> {
  if (!USER_ADDR) return;
  // Pas de fetch RPC - on utilise les balances suivies localement
  await withdrawAllAvailable();
}

async function handleRepayEvent(reserve: Address, user: Address, repayer: Address, amount: bigint, useATokens: boolean, blockNumber: bigint | null) {
  if (!isStablecoin(reserve)) return;

  const formattedAmount = formatAmount(amount, reserve);

  console.log("---");
  console.log(`${timestamp()} [Repay] Bloc: ${blockNumber}`);
  console.log(`  Token: ${reserve}`);
  console.log(`  Montant: ${formattedAmount}`);
  console.log(`  User: ${user}`);
  console.log(`  Repayer: ${repayer}`);
  console.log(`  UseATokens: ${useATokens}`);

  // Skip si repay avec aTokens - pas de nouvelle liquidite ajoutee au pool
  if (useATokens) {
    console.log(`  [SKIP] Repay avec aTokens, pas de liquidite ajoutee`);
    return;
  }

  // Mise a jour locale de la liquidite (+amount car repay ajoute de la liquidite)
  poolLiquidity[reserve] = (poolLiquidity[reserve] ?? 0n) + amount;
  console.log(`  Liquidite ${TOKENS[reserve]?.symbol}: ${formatAmount(poolLiquidity[reserve], reserve)}`);

  await tryWithdraw();
}

async function handleSupplyEvent(reserve: Address, user: Address, onBehalfOf: Address, amount: bigint, blockNumber: bigint | null) {
  if (!isStablecoin(reserve)) return;

  const formattedAmount = formatAmount(amount, reserve);

  console.log("---");
  console.log(`${timestamp()} [Supply] Bloc: ${blockNumber}`);
  console.log(`  Token: ${reserve}`);
  console.log(`  Montant: ${formattedAmount}`);
  console.log(`  User: ${user}`);
  console.log(`  OnBehalfOf: ${onBehalfOf}`);

  // Mise a jour locale de la liquidite (+amount car supply ajoute de la liquidite)
  poolLiquidity[reserve] = (poolLiquidity[reserve] ?? 0n) + amount;
  console.log(`  Liquidite ${TOKENS[reserve]?.symbol}: ${formatAmount(poolLiquidity[reserve], reserve)}`);

  await tryWithdraw();
}

function handleWithdrawEvent(reserve: Address, user: Address, to: Address, amount: bigint, blockNumber: bigint | null) {
  if (!isStablecoin(reserve)) return;

  // Ignorer nos propres withdraws (deja geres localement dans executeWithdraw)
  if (USER_ADDR && (user.toLowerCase() === USER_ADDR.toLowerCase())) {
    return;
  }

  const formattedAmount = formatAmount(amount, reserve);

  console.log("---");
  console.log(`${timestamp()} [Withdraw] Bloc: ${blockNumber}`);
  console.log(`  Token: ${reserve}`);
  console.log(`  Montant: ${formattedAmount}`);
  console.log(`  User: ${user}`);

  // Mise a jour locale de la liquidite (-amount car withdraw retire de la liquidite)
  const before = poolLiquidity[reserve] ?? 0n;
  poolLiquidity[reserve] = before > amount ? before - amount : 0n;
  console.log(`  Liquidite ${TOKENS[reserve]?.symbol}: ${formatAmount(poolLiquidity[reserve], reserve)}`);
}

async function fetchAndStoreSupplyTokenBalances(address: Address) {
  console.log(`Balances des Supply Tokens pour ${address}:`);

  for (const [tokenAddress, token] of Object.entries(SUPPLY_TOKENS)) {
    try {
      const balance = await client.readContract({
        address: tokenAddress as Address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [address],
      });
      userBalances[tokenAddress as Address] = balance;
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
 * Fetch real liquidity from RPC (stablecoin balance in aToken contract)
 */
async function fetchRealLiquidity(supplyTokenAddress: Address, reserveAddress: Address): Promise<bigint> {
  try {
    const balance = await client.readContract({
      address: reserveAddress,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [supplyTokenAddress],
    });
    return balance;
  } catch (error) {
    console.error(`  [RPC] Erreur fetch liquidite:`, (error as Error).message);
    return 0n;
  }
}

/**
 * Check if withdraw amount meets minimum threshold.
 * Protection against bots adding small amounts to drain gas fees.
 */
function checkMinWithdrawAmount(amount: bigint, decimals: number): boolean {
  const amountUSD = parseFloat(formatUnits(amount, decimals));
  if (amountUSD < MIN_WITHDRAW_USD) {
    console.log(`  [SKIP] Montant (${amountUSD.toFixed(2)} USD) < minimum (${MIN_WITHDRAW_USD} USD)`);
    return false;
  }
  return true;
}

/**
 * Calculate gas parameters using USD-based strategy.
 * gasPrice is derived from: gasPrice = maxCostUSD / gasLimit
 * Skip if derived gasPrice < GAS_MIN_PRICE_GWEI (tx wouldn't be accepted)
 */
function calculateGasParamsFromUSD(
  maxCostUSD: number,
  gasLimit: bigint,
  minPriceGwei: number
): { gasPrice: bigint; gas: bigint } | null {
  // maxCostWei = maxCostUSD * 10^18 (xDAI has 18 decimals)
  const maxCostWei = parseUnits(maxCostUSD.toString(), 18);

  // gasPrice = maxCostWei / gasLimit
  const gasPrice = maxCostWei / gasLimit;

  // Check against minimum acceptable gas price
  const minPriceWei = parseUnits(minPriceGwei.toString(), 9);
  const gasPriceGwei = parseFloat(formatUnits(gasPrice, 9));

  console.log(`  [Gas] Limit: ${gasLimit}, Max cost: ${maxCostUSD} USD`);
  console.log(`  [Gas] Derived price: ${gasPriceGwei.toFixed(4)} Gwei (min: ${minPriceGwei} Gwei)`);

  if (gasPrice < minPriceWei) {
    console.log(`  [SKIP] Gas price (${gasPriceGwei.toFixed(4)} Gwei) < minimum (${minPriceGwei} Gwei)`);
    return null;
  }

  return { gasPrice, gas: gasLimit };
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

    console.log(`${timestamp()} [Withdraw] Execution pour ${supplyToken.symbol}...`);
    console.log(`  Reserve: ${stablecoin.symbol}`);
    console.log(`  Montant: ${amountDisplay}`);

    // Verifier le montant minimum
    if (!checkMinWithdrawAmount(amount, stablecoin.decimals)) {
      return false;
    }

    // Verifier la liquidite reelle via RPC (si active)
    if (CHECK_LIQUIDITY_BEFORE) {
      const realLiquidity = await fetchRealLiquidity(supplyTokenAddress, reserveAddress);
      if (realLiquidity === 0n) {
        console.log(`  [SKIP] Liquidite reelle = 0 (RPC check)`);
        poolLiquidity[reserveAddress] = 0n; // Sync local state
        return false;
      }
      if (realLiquidity < amount) {
        console.log(`  [SKIP] Liquidite reelle (${formatUnits(realLiquidity, stablecoin.decimals)}) < montant demande`);
        poolLiquidity[reserveAddress] = realLiquidity; // Sync local state
        return false;
      }
      console.log(`  [RPC] Liquidite reelle: ${formatUnits(realLiquidity, stablecoin.decimals)} ${stablecoin.symbol}`);
    }

    // Calculer les parametres de gas (USD-based)
    const gasParams = calculateGasParamsFromUSD(GAS_MAX_COST_USD, GAS_LIMIT_WITHDRAW, GAS_MIN_PRICE_GWEI);
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

    if (receipt.status === "success") {
      // Mise a jour locale des balances apres withdraw reussi
      userBalances[supplyTokenAddress] = (userBalances[supplyTokenAddress] ?? 0n) - amount;
      poolLiquidity[reserveAddress] = (poolLiquidity[reserveAddress] ?? 0n) - amount;
      console.log(`  [Local] Balance ${supplyToken.symbol}: ${formatUnits(userBalances[supplyTokenAddress], supplyToken.decimals)}`);
      console.log(`  [Local] Liquidite ${stablecoin.symbol}: ${formatUnits(poolLiquidity[reserveAddress], stablecoin.decimals)}`);

      // Transfer to destination if configured
      if (DEST_ADDRESS) {
        await transferToDestination(reserveAddress, amount);
      }
    }

    return receipt.status === "success";
  } catch (error) {
    console.error(`  Erreur withdraw ${supplyToken.symbol}:`, (error as Error).message);
    return false;
  }
}

/**
 * Transfer stablecoins (USDC or WXDAI) to DEST_ADDRESS.
 * Uses fixed gas price in Gwei.
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
    console.log(`${timestamp()} [Transfer] Envoi de ${amountDisplay} ${token.symbol} vers ${DEST_ADDRESS}...`);

    const gasPrice = parseUnits(GAS_TRANSFER_PRICE_GWEI.toString(), 9);

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
  console.log(`${timestamp()} [Withdraw] Verification des positions a retirer...`);

  for (const [supplyTokenAddress, supplyToken] of Object.entries(SUPPLY_TOKENS)) {
    const userBalance = userBalances[supplyTokenAddress as Address] ?? 0n;
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

    // Skip si montant nul (securite supplementaire)
    if (withdrawAmount === 0n) {
      console.log(`    [SKIP] Montant de retrait nul`);
      continue;
    }

    await executeWithdraw(
      supplyTokenAddress as Address,
      supplyToken.associatedReserve,
      withdrawAmount
    );
  }
  console.log("---");
}

async function watchRMMEvents() {
  console.log(`Ecoute des evenements Repay, Supply et Withdraw sur RMM (${RMM_ADDRESS})...`);
  console.log(`Chain: Gnosis (${gnosis.id})`);
  console.log("---");

  client.watchContractEvent({
    address: RMM_ADDRESS,
    abi: REPAY_EVENT_ABI,
    eventName: "Repay",
    onLogs: (logs) => {
      for (const log of logs) {
        const { reserve, user, repayer, amount, useATokens } = log.args;
        if (reserve && user && repayer && amount !== undefined && useATokens !== undefined) {
          handleRepayEvent(reserve, user, repayer, amount, useATokens, log.blockNumber);
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

  client.watchContractEvent({
    address: RMM_ADDRESS,
    abi: WITHDRAW_EVENT_ABI,
    eventName: "Withdraw",
    onLogs: (logs) => {
      for (const log of logs) {
        const { reserve, user, to, amount } = log.args;
        if (reserve && user && to && amount !== undefined) {
          handleWithdrawEvent(reserve, user, to, amount, log.blockNumber);
        }
      }
    },
    onError: (error) => console.error("Erreur Withdraw:", error.message),
  });
}

function displayConfig() {
  console.log("Configuration:");
  console.log(`  Min withdraw:        ${MIN_WITHDRAW_USD} $`);
  console.log(`  Refresh interval:    ${REFRESH_INTERVAL_MIN} min`);
  console.log(`  Check liquidity RPC: ${CHECK_LIQUIDITY_BEFORE ? "enabled" : "disabled"}`);
  console.log(`  Withdraw gas limit:  ${GAS_LIMIT_WITHDRAW}`);
  console.log(`  Withdraw max cost:   ${GAS_MAX_COST_USD} $`);
  console.log(`  Min gas price:       ${GAS_MIN_PRICE_GWEI} Gwei`);
  console.log(`  DEST_ADDRESS:        ${DEST_ADDRESS ?? "disabled"}`);
  if (DEST_ADDRESS) {
    console.log(`  Transfer gas price:  ${GAS_TRANSFER_PRICE_GWEI} Gwei`);
  }
  console.log("---");
}

async function displayGasInfo(address: Address) {
  try {
    const balance = await client.getBalance({ address });
    const balanceXDAI = parseFloat(formatUnits(balance, 18));
    const maxWithdrawAttempts = Math.floor(balanceXDAI / GAS_MAX_COST_USD);

    console.log("Gas Info:");
    console.log(`  Address:             ${address}`);
    console.log(`  Balance:             ${balanceXDAI.toFixed(4)} xDAI`);
    console.log(`  Cost per withdraw:   ${GAS_MAX_COST_USD} xDAI`);
    console.log(`  Min withdraw attempts: ${maxWithdrawAttempts}`);
    console.log("---");
  } catch (error) {
    console.error("Erreur fetch gas balance:", (error as Error).message);
  }
}

async function main() {
  displayConfig();

  if (USER_ADDR) {
    await displayGasInfo(USER_ADDR);
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

  // Refresh periodique des balances aToken pour avoir des donnees fiables
  if (USER_ADDR && REFRESH_INTERVAL_MIN > 0) {
    const intervalMs = REFRESH_INTERVAL_MIN * 60 * 1000;
    setInterval(async () => {
      console.log("---");
      console.log(`${timestamp()} [Refresh] Mise a jour periodique des balances...`);
      await fetchAndStoreSupplyTokenBalances(USER_ADDR);
      await displayGasInfo(USER_ADDR);
    }, intervalMs);

  }
}

main();
