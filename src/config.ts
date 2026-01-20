import type { Address } from "viem";

export const RMM_ADDRESS = "0xFb9b496519fCa8473fba1af0850B6B8F476BFdB3" as const;

// stablecoins 
export const TOKENS: Record<Address, { symbol: string; decimals: number }> = {
  "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d": { symbol: "WXDAI", decimals: 18 },
  "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83": { symbol: "USDC", decimals: 6 },
};

// supply tokens associated to stablecoins
export const SUPPLY_TOKENS: Record<Address, { symbol: string; decimals: number; associatedReserve: Address }> = {
  "0x9908801dF7902675C3FEDD6Fea0294D18D5d5d34": { symbol: "sWXDAI", decimals: 18, associatedReserve: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d" },
  "0xeD56F76E9cBC6A64b821e9c016eAFbd3db5436D1": { symbol: "sUSDC", decimals: 6, associatedReserve: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83" },
};

export const REPAY_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "reserve", type: "address" },
      { indexed: true, name: "user", type: "address" },
      { indexed: true, name: "repayer", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "useATokens", type: "bool" },
    ],
    name: "Repay",
    type: "event",
  },
] as const;

export const SUPPLY_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "reserve", type: "address" },
      { indexed: false, name: "user", type: "address" },
      { indexed: true, name: "onBehalfOf", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: true, name: "referralCode", type: "uint16" },
    ],
    name: "Supply",
    type: "event",
  },
] as const;

export const ERC20_BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
