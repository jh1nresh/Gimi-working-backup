export interface RentalItem {
  id: string;
  name: string;
  brand: string;
  model: string;
  condition: number; // 1-10
  description: string;
  imageUrl: string;
  ratePerHour: number; // USDC
  minimumFee: number; // USDC
  buyoutCap: number; // USDC refundable escrow / auto-buyout cap
  expectedHours: number;
  status: "available" | "paused" | "rented" | "return_requested" | "buyout" | "disputed";
  owner: string; // wallet address
  ownerName: string;
  locationLabel: string;
  renter?: string;
  rentalStart?: number; // unix timestamp
  rentalHours?: number;
  category: string;
  ownerScore: number;
  returnedOkCount: number;
  autoBuyoutCount: number;
  disputeCount: number;
  createdAt: number;
}

export interface ChatMessage {
  role: "agent" | "user";
  content: string;
  options?: string[];
  tools?: ToolCall[];
}

export interface ToolCall {
  name: string;
  status: "pending" | "running" | "done";
  detail?: string;
}

export interface TrustProfile {
  address: string;
  score: number;
  totalRentals: number;
  onTimeReturns: number;
  avgRating: number;
}

export interface RentalDraft {
  id: string;
  itemId: string;
  itemName: string;
  durationHours: number;
  expectedFee: number;
  refundableEscrow: number;
  sourceChain: "base" | "arbitrum" | "ethereum" | "solana";
  targetChain: "solana";
}

export interface RentalReceipt {
  id: string;
  sessionId: string;
  itemId: string;
  outcome: "returned_ok" | "auto_buyout" | "disputed";
  grossFee: number;
  platformFee: number;
  ownerPayout: number;
  renterRefund: number;
  rentalTokenStatus: "burned";
  createdAt: number;
}
