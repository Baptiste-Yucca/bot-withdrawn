import type { Address } from "viem";

export const RMM_ADDRESS = "0xFb9b496519fCa8473fba1af0850B6B8F476BFdB3" as const;

export const TOKENS: Record<Address, { symbol: string; decimals: number }> = {
  "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d": { symbol: "WXDAI", decimals: 18 },
  "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83": { symbol: "USDC", decimals: 6 },
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
