import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("AVL316tYxrg8MhEeWtaxbwdShMWybzRAH1zNQWvX355K");
const PLATFORM_AUTHORITY = new PublicKey("7Fmr5t2h2SZ55n4w3dkgWTjaXRafDnBLLy1RhdmPJk6b");
const FEE_AUTHORITY = new PublicKey("AWesFzR3x97q5QWk6MBxLU8kRGZcuobtKuoABtMiHWH1");
const USDC_DECIMALS = 6;
const PLATFORM_FEE_BPS = 500;
const AUTO_BUYOUT_GRACE_SECONDS = 60 * 60;
const DEMO_ITEMS = [
  { id: "power_bank_18", ratePerHour: 2, minimumFee: 3, buyoutCap: 30 },
  { id: "charger_07", ratePerHour: 1, minimumFee: 2, buyoutCap: 20 },
  { id: "adapter_03", ratePerHour: 1, minimumFee: 2, buyoutCap: 15 },
  { id: "mic_11", ratePerHour: 3, minimumFee: 6, buyoutCap: 70 },
  { id: "camera_04", ratePerHour: 8, minimumFee: 16, buyoutCap: 420 },
  { id: "tripod_09", ratePerHour: 1, minimumFee: 3, buyoutCap: 45 },
  { id: "keyboard_15", ratePerHour: 1, minimumFee: 2, buyoutCap: 55 },
  { id: "monitor_22", ratePerHour: 4, minimumFee: 8, buyoutCap: 180 },
  { id: "router_06", ratePerHour: 2, minimumFee: 4, buyoutCap: 90 },
  { id: "projector_13", ratePerHour: 5, minimumFee: 10, buyoutCap: 240 },
];

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const payerPath = process.env.PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
const ownerPath = process.env.RENT_PROOF_OWNER_KEYPAIR ?? "/tmp/rentchain-anchor/owner.json";
const renterPath = process.env.RENT_PROOF_RENTER_KEYPAIR ?? "/tmp/rentchain-anchor/renter.json";
const mintPath = process.env.RENT_PROOF_MINT_KEYPAIR ?? "/tmp/rentchain-anchor/mint.json";

function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function bytes32(value) {
  return createHash("sha256").update(value).digest();
}

function anchorDiscriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u16Le(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u64Le(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function i64Le(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(BigInt(value));
  return buffer;
}

function usdcBaseUnits(amount) {
  return Math.round(amount * 10 ** USDC_DECIMALS);
}

function ratePerSecondBaseUnits(ratePerHour) {
  return Math.max(1, Math.ceil(usdcBaseUnits(ratePerHour) / 3600));
}

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

function initializeConfigIx({ authority, config }) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: FEE_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([anchorDiscriminator("initialize_config"), u16Le(PLATFORM_FEE_BPS)]),
  });
}

function initializeItemIx({ owner, item, paymentMint, itemId, rentalItem }) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: item, isSigner: false, isWritable: true },
      { pubkey: paymentMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator("initialize_item"),
      bytes32(itemId),
      bytes32(itemId),
      u64Le(ratePerSecondBaseUnits(rentalItem.ratePerHour)),
      u64Le(usdcBaseUnits(rentalItem.minimumFee)),
      u64Le(usdcBaseUnits(rentalItem.buyoutCap)),
      i64Le(AUTO_BUYOUT_GRACE_SECONDS),
    ]),
  });
}

async function main() {
  const connection = new Connection(rpcUrl, "confirmed");
  const payer = loadKeypair(payerPath);
  const owner = loadKeypair(ownerPath);
  const renter = loadKeypair(renterPath);
  const mint = loadKeypair(mintPath);

  console.log(`rpc=${rpcUrl}`);
  console.log(`payer=${payer.publicKey.toBase58()}`);
  console.log(`owner=${owner.publicKey.toBase58()}`);
  console.log(`renter=${renter.publicKey.toBase58()}`);
  console.log(`mint=${mint.publicKey.toBase58()}`);

  if (!owner.publicKey.equals(PLATFORM_AUTHORITY)) {
    throw new Error(
      `Owner keypair ${owner.publicKey.toBase58()} does not match required platform authority ${PLATFORM_AUTHORITY.toBase58()}`
    );
  }

  const fundTx = new Transaction();
  for (const account of [owner.publicKey, renter.publicKey]) {
    const balance = await connection.getBalance(account, "confirmed");
    if (balance < 0.2 * 1_000_000_000) {
      fundTx.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: account,
          lamports: 0.5 * 1_000_000_000,
        })
      );
    }
  }
  if (fundTx.instructions.length) {
    const signature = await sendAndConfirmTransaction(connection, fundTx, [payer], {
      commitment: "confirmed",
    });
    console.log(`fund signature=${signature}`);
  }

  const setupTx = new Transaction();
  const setupSigners = [payer];
  const mintInfo = await connection.getAccountInfo(mint.publicKey);
  if (!mintInfo) {
    setupTx.add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: await getMinimumBalanceForRentExemptMint(connection),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mint.publicKey, USDC_DECIMALS, payer.publicKey, null)
    );
    setupSigners.push(mint);
  }

  const renterAta = getAssociatedTokenAddressSync(mint.publicKey, renter.publicKey);
  const ownerAta = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey);
  const platformAta = getAssociatedTokenAddressSync(mint.publicKey, FEE_AUTHORITY);
  setupTx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      renterAta,
      renter.publicKey,
      mint.publicKey
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      ownerAta,
      owner.publicKey,
      mint.publicKey
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      platformAta,
      FEE_AUTHORITY,
      mint.publicKey
    ),
    createMintToInstruction(mint.publicKey, renterAta, payer.publicKey, usdcBaseUnits(1000))
  );

  const config = pda([Buffer.from("config")]);
  if (!(await connection.getAccountInfo(config))) {
    setupTx.add(initializeConfigIx({ authority: owner.publicKey, config }));
    if (!setupSigners.some((signer) => signer.publicKey.equals(owner.publicKey))) {
      setupSigners.push(owner);
    }
  }

  if (setupTx.instructions.length) {
    const signature = await sendAndConfirmTransaction(connection, setupTx, setupSigners, {
      commitment: "confirmed",
    });
    console.log(`setup base signature=${signature}`);
  }

  for (const rentalItem of DEMO_ITEMS) {
    const item = pda([Buffer.from("item"), owner.publicKey.toBuffer(), bytes32(rentalItem.id)]);
    if (await connection.getAccountInfo(item)) continue;
    const itemTx = new Transaction().add(
      initializeItemIx({
        owner: owner.publicKey,
        item,
        paymentMint: mint.publicKey,
        itemId: rentalItem.id,
        rentalItem,
      })
    );
    const signature = await sendAndConfirmTransaction(connection, itemTx, [payer, owner], {
      commitment: "confirmed",
    });
    console.log(`item ${rentalItem.id} signature=${signature}`);
  }

  console.log(`renter_token_account=${renterAta.toBase58()}`);
  console.log(`owner_token_account=${ownerAta.toBase58()}`);
  console.log(`platform_fee_token_account=${platformAta.toBase58()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
