import { readFileSync } from "node:fs";
import { Connection, Keypair, Transaction } from "@solana/web3.js";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ownerPath = process.env.RENT_PROOF_OWNER_KEYPAIR ?? "/tmp/rentchain-anchor/owner.json";
const renterPath = process.env.RENT_PROOF_RENTER_KEYPAIR ?? "/tmp/rentchain-anchor/renter.json";

function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function jsonFetch(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function signSimulateSend(connection, transactionBase64, signer, label) {
  const transaction = Transaction.from(Buffer.from(transactionBase64, "base64"));
  transaction.partialSign(signer);

  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)} logs=${JSON.stringify(simulation.value.logs)}`);
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    {
      signature,
      blockhash: transaction.recentBlockhash,
      lastValidBlockHeight: Number.MAX_SAFE_INTEGER,
    },
    "confirmed"
  );
  return signature;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishListing(connection, owner, unique, overrides = {}) {
  const preparedListing = await jsonFetch("/api/solana-pay/initialize-item", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ownerWallet: owner.publicKey.toBase58(),
      name: overrides.name ?? `E2E Power Bank ${unique}`,
      brand: "Anker",
      model: "Devnet Smoke",
      category: "Power",
      condition: 9,
      description: "End-to-end devnet listing created by the Tably smoke test.",
      imageUrl: "https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?w=900&h=700&fit=crop",
      locationLabel: "Devnet table",
      included: ["USB-C cable"],
      ratePerHour: overrides.ratePerHour ?? 2,
      minimumFee: overrides.minimumFee ?? 3,
      buyoutCap: overrides.buyoutCap ?? 30,
      autoBuyoutGraceSeconds: overrides.autoBuyoutGraceSeconds ?? 3600,
    }),
  });

  const initializeSignature = await signSimulateSend(
    connection,
    preparedListing.transaction,
    owner,
    "initialize_item"
  );
  console.log(`initialize_item_signature=${initializeSignature}`);

  const published = await jsonFetch("/api/listings/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      draftId: preparedListing.draftId,
      initializeSignature,
      listingPreview: preparedListing.listingPreview,
    }),
  });
  console.log(`published_item=${published.listing.id}`);
  console.log(`item_pda=${published.listing.itemPda}`);

  return published.listing;
}

async function startRental(connection, renter, listing, hours) {
  const preparedRental = await jsonFetch("/api/solana-pay/start-rental", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemId: listing.id,
      renterWallet: renter.publicKey.toBase58(),
      hours,
    }),
  });
  if (!preparedRental.preflight?.ok) throw new Error(`Rental preflight was not ok: ${JSON.stringify(preparedRental.preflight)}`);
  console.log(`rental_preflight_ok=${preparedRental.preflight.ok}`);
  console.log(`renter_usdc=${preparedRental.preflight.tokenAccounts.renter.uiAmount}`);

  const startSignature = await signSimulateSend(
    connection,
    preparedRental.transaction,
    renter,
    "start_rental"
  );
  console.log(`start_rental_signature=${startSignature}`);
  console.log(`explorer_start=https://explorer.solana.com/tx/${startSignature}?cluster=devnet`);

  const recordedRental = await jsonFetch("/api/rentals/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemId: listing.id,
      rentalId: preparedRental.draftId,
      renterWallet: renter.publicKey.toBase58(),
      startSignature,
    }),
  });
  console.log(`recorded_session=${recordedRental.rentalSession.sessionPda}`);
  console.log(`listing_status=${recordedRental.listing?.status}`);

  return { preparedRental, recordedRental, startSignature };
}

async function settleRental(connection, owner, listing, rentalId, renterWallet, kind) {
  const endpoint = kind === "return" ? "/api/solana-pay/confirm-return" : "/api/solana-pay/auto-buyout";
  const preparedSettlement = await jsonFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemId: listing.id,
      rentalId,
      renterWallet,
    }),
  });

  const settlementSignature = await signSimulateSend(
    connection,
    preparedSettlement.transaction,
    owner,
    kind === "return" ? "confirm_return" : "auto_buyout"
  );
  console.log(`${kind}_signature=${settlementSignature}`);
  console.log(`explorer_${kind}=https://explorer.solana.com/tx/${settlementSignature}?cluster=devnet`);

  const settlement = await jsonFetch("/api/rentals/settle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind,
      itemId: listing.id,
      rentalId,
      renterWallet,
      settlementSignature,
    }),
  });
  console.log(`${kind}_session_status=${settlement.rentalSession.status}`);
  console.log(`${kind}_listing_status=${settlement.listing?.status}`);
  console.log(`${kind}_receipt_outcome=${settlement.receipt.outcome}`);

  return { settlementSignature, settlement };
}

async function main() {
  const connection = new Connection(rpcUrl, "confirmed");
  const owner = loadKeypair(ownerPath);
  const renter = loadKeypair(renterPath);
  const unique = Date.now().toString(36);

  console.log(`baseUrl=${baseUrl}`);
  console.log(`rpc=${rpcUrl}`);
  console.log(`owner=${owner.publicKey.toBase58()}`);
  console.log(`renter=${renter.publicKey.toBase58()}`);

  const returnListing = await publishListing(connection, owner, `${unique}-return`);

  const listings = await jsonFetch("/api/listings");
  const listedItem = listings.inventory.find((item) => item.id === returnListing.id);
  if (!listedItem) throw new Error("Published listing did not appear in renter inventory.");
  console.log(`inventory_storage=${listings.storage}`);
  console.log(`inventory_match=${listedItem.name}`);

  const returnRental = await startRental(connection, renter, returnListing, 1);

  const inventoryAfterStart = await jsonFetch("/api/listings");
  const stillAvailable = inventoryAfterStart.inventory.some((item) => item.id === returnListing.id && item.status === "available");
  if (stillAvailable) throw new Error("Started rental is still available in renter inventory.");
  console.log(`inventory_after_start_storage=${inventoryAfterStart.storage}`);
  console.log("inventory_removed_after_start=true");

  const returned = await settleRental(
    connection,
    owner,
    returnListing,
    returnRental.preparedRental.draftId,
    renter.publicKey.toBase58(),
    "return"
  );
  if (returned.settlement.rentalSession.status !== "returned") throw new Error("Return session was not marked returned.");
  if (returned.settlement.listing?.status !== "available") throw new Error("Returned listing was not marked available.");
  if (returned.settlement.receipt.outcome !== "returned_ok") throw new Error("Return receipt was not persisted.");

  const inventoryAfterReturn = await jsonFetch("/api/listings");
  const availableAgain = inventoryAfterReturn.inventory.some((item) => item.id === returnListing.id && item.status === "available");
  if (!availableAgain) throw new Error("Returned listing did not reappear in available inventory.");
  console.log("inventory_available_after_return=true");

  const buyoutListing = await publishListing(connection, owner, `${unique}-buyout`, {
    name: `E2E Buyout Cable ${unique}`,
    ratePerHour: 1,
    minimumFee: 1,
    buyoutCap: 5,
    autoBuyoutGraceSeconds: 0,
  });
  const buyoutRental = await startRental(connection, renter, buyoutListing, 0.0003);
  const dueAtMs = Number(buyoutRental.recordedRental.rentalSession.dueTs) * 1000;
  const waitMs = Math.max(0, dueAtMs - Date.now() + 2500);
  console.log(`auto_buyout_wait_ms=${waitMs}`);
  if (waitMs > 0) await sleep(waitMs);

  const boughtOut = await settleRental(
    connection,
    owner,
    buyoutListing,
    buyoutRental.preparedRental.draftId,
    renter.publicKey.toBase58(),
    "buyout"
  );
  if (boughtOut.settlement.rentalSession.status !== "buyout") throw new Error("Buyout session was not marked buyout.");
  if (boughtOut.settlement.listing?.status !== "buyout") throw new Error("Bought-out listing was not marked buyout.");
  if (boughtOut.settlement.receipt.outcome !== "auto_buyout") throw new Error("Buyout receipt was not persisted.");
  console.log("auto_buyout_receipt_persisted=true");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
