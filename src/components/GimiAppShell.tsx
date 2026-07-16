"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PrivyProvider, useLogin, usePrivy, useToken } from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useCreateWallet,
  useSignMessage as usePrivySolanaSignMessage,
  useSignTransaction as usePrivySolanaSignTransaction,
  useWallets as useSolanaWallets,
  type ConnectedStandardSolanaWallet,
} from "@privy-io/react-auth/solana";
import { clusterApiUrl, Connection, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { StripeCardLink } from "./StripeCardLink";

const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const loginMethods = ["email", "wallet"] as const;

type WalletAction = "connect" | "send-transaction" | "sign-message" | "card-checkout";
type PendingTransaction = { transactionBase64: string; cluster: string; requiredSigner?: string };
type PendingMessage = { message: string; requiredSigner: string };
type PendingCardCheckout = { itemId: string; hours: number; renterWallet?: string };
type PrivySolanaSignMessage = ReturnType<typeof usePrivySolanaSignMessage>["signMessage"];
type PrivySolanaSignTransaction = ReturnType<typeof usePrivySolanaSignTransaction>["signTransaction"];

function signatureToBase58(signature: unknown) {
  if (!signature) return "";
  if (typeof signature === "string") return signature;
  if (signature instanceof Uint8Array) return bs58.encode(signature);
  if (Array.isArray(signature)) return bs58.encode(Uint8Array.from(signature));
  if (typeof signature === "object" && signature && "signature" in signature) {
    return signatureToBase58((signature as { signature?: unknown }).signature);
  }
  return "";
}

function base64ToUint8Array(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function getRequiredSigners(transactionBase64: string) {
  return Transaction.from(base64ToUint8Array(transactionBase64)).signatures.map(({ publicKey }) => publicKey.toBase58());
}

function validateRequiredSigner(pendingTx: PendingTransaction, walletAddress: string) {
  const requiredSigners = getRequiredSigners(pendingTx.transactionBase64);
  const expectedSigner = pendingTx.requiredSigner;

  if (expectedSigner && !new PublicKey(expectedSigner).equals(new PublicKey(walletAddress))) {
    throw new Error("Connected wallet does not match the required transaction signer");
  }

  if (!requiredSigners.some((signer) => new PublicKey(signer).equals(new PublicKey(walletAddress)))) {
    throw new Error("Connected wallet is not a required signer for this transaction");
  }

  if (expectedSigner && !requiredSigners.some((signer) => new PublicKey(signer).equals(new PublicKey(expectedSigner)))) {
    throw new Error("Transaction signer metadata does not match the serialized transaction");
  }
}

function clusterToChain(cluster: string) {
  return cluster === "solana:mainnet" || cluster === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";
}

function clusterToRpcUrl(cluster: string) {
  return cluster === "solana:mainnet" || cluster === "mainnet-beta"
    ? clusterApiUrl("mainnet-beta")
    : clusterApiUrl("devnet");
}

function buildSignInMessage(address: string) {
  return [
    "Sign in to Gimi",
    "",
    "This signature proves wallet ownership and does not start a transaction.",
    `Wallet: ${address}`,
    `Issued at: ${new Date().toISOString()}`,
  ].join("\n");
}

async function signWalletLogin(wallet: ConnectedStandardSolanaWallet, signMessage: PrivySolanaSignMessage) {
  const message = buildSignInMessage(wallet.address);
  const { signature } = await signMessage({
    message: new TextEncoder().encode(message),
    wallet,
    options: {
      uiOptions: {
        title: "Sign in to Gimi",
        description: "Confirm this wallet for rental checkout.",
        buttonText: "Sign in",
      },
    },
  });

  return { message, signature: signatureToBase58(signature) };
}

async function signAndSendTransaction(
  wallet: ConnectedStandardSolanaWallet,
  pendingTx: PendingTransaction,
  signTransaction: PrivySolanaSignTransaction
) {
  const transaction = base64ToUint8Array(pendingTx.transactionBase64);
  const chain = clusterToChain(pendingTx.cluster);

  try {
    const { signedTransaction } = await signTransaction({ transaction, wallet, chain });
    return new Connection(clusterToRpcUrl(pendingTx.cluster), "confirmed").sendRawTransaction(signedTransaction);
  } catch (error) {
    try {
      const result = await wallet.signAndSendTransaction({ transaction, chain });
      return signatureToBase58(result);
    } catch {
      throw error;
    }
  }
}

export function GimiAppShell({ partnerDemo = false }: { partnerDemo?: boolean }) {
  const solanaConnectors = useMemo<ReturnType<typeof toSolanaWalletConnectors> | undefined>(
    () => (typeof window === "undefined" ? undefined : toSolanaWalletConnectors()),
    []
  );

  if (!privyAppId) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#080a12] px-6 text-center text-white">
        <div className="max-w-md rounded-[28px] border border-white/10 bg-white/8 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-2xl">
          <p className="text-sm font-black uppercase tracking-[0.16em] text-[#c7ff00]">Privy setup needed</p>
          <h1 className="mt-3 text-3xl font-black">Add a valid Privy app id</h1>
          <p className="mt-3 text-sm font-bold leading-6 text-white/62">
            Set NEXT_PUBLIC_PRIVY_APP_ID in Vercel or .env.local, then reload Gimi.
          </p>
        </div>
      </main>
    );
  }

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        loginMethods: [...loginMethods],
        appearance: {
          theme: "light",
          accentColor: "#c7ff00",
          landingHeader: "Connect to Gimi",
          loginMessage: "Use email or an existing Solana wallet.",
          showWalletLoginFirst: false,
          walletChainType: "solana-only",
          walletList: ["detected_solana_wallets", "phantom", "solflare", "backpack"] as never,
        },
        embeddedWallets: {
          solana: { createOnLogin: "users-without-wallets" },
        },
        externalWallets: {
          solana: { connectors: solanaConnectors },
        },
      }}
    >
      <GimiShellFrame partnerDemo={partnerDemo} />
    </PrivyProvider>
  );
}

function GimiShellFrame({ partnerDemo }: { partnerDemo: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pendingAction = useRef<WalletAction | null>(null);
  const pendingTx = useRef<PendingTransaction | null>(null);
  const pendingMessage = useRef<PendingMessage | null>(null);
  const pendingCardCheckout = useRef<PendingCardCheckout | null>(null);
  const hasStartedSignIn = useRef(false);
  const hasStartedTransaction = useRef(false);
  const hasStartedCardCheckout = useRef(false);
  const hasTriedCreateWallet = useRef(false);
  const hasOpenedLogin = useRef(false);
  const [actionVersion, setActionVersion] = useState(0);
  const [cardLinkToken, setCardLinkToken] = useState<string>();
  const { ready, authenticated } = usePrivy();
  const { getAccessToken } = useToken();
  const { wallets, ready: walletsReady } = useSolanaWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = usePrivySolanaSignMessage();
  const { signTransaction } = usePrivySolanaSignTransaction();

  const postToShell = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);

  const fail = useCallback((message: string) => {
    pendingAction.current = null;
    pendingTx.current = null;
    pendingMessage.current = null;
    hasStartedSignIn.current = false;
    hasStartedTransaction.current = false;
    hasStartedCardCheckout.current = false;
    hasOpenedLogin.current = false;
    postToShell({ type: "gimi:privy-wallet-error", message });
  }, [postToShell]);

  const failCardCheckout = useCallback((message: string) => {
    pendingAction.current = null;
    pendingCardCheckout.current = null;
    hasStartedCardCheckout.current = false;
    hasOpenedLogin.current = false;
    setCardLinkToken(undefined);
    postToShell({ type: "gimi:card-checkout-error", message });
  }, [postToShell]);

  const { login } = useLogin({
    onComplete: () => {
      postToShell({
        type: "gimi:privy-status",
        message: pendingAction.current === "card-checkout" ? "Signed in. Checking saved card..." : "Wallet connected. Preparing signature...",
      });
    },
    onError: () => {
      if (pendingAction.current === "card-checkout") {
        failCardCheckout("Privy login was cancelled. Try again when ready.");
        return;
      }
      fail("Privy login was cancelled. Try again when ready.");
    },
  });

  const ensureWallet = useCallback(async () => {
    const existing = wallets[0] as ConnectedStandardSolanaWallet | undefined;
    if (existing) return existing;
    const created = await createWallet();
    return wallets.find((wallet) => wallet.address === created.wallet.address) as ConnectedStandardSolanaWallet | undefined;
  }, [createWallet, wallets]);

  const startAction = useCallback((action: WalletAction) => {
    pendingAction.current = action;
    hasStartedSignIn.current = false;
    hasStartedTransaction.current = false;
    hasStartedCardCheckout.current = false;
    hasTriedCreateWallet.current = false;
    hasOpenedLogin.current = false;

    if (action === "send-transaction") {
      try {
        const raw = window.localStorage.getItem("gimi.pendingPrivyTransaction");
        const parsed = raw ? JSON.parse(raw) as Partial<PendingTransaction> : {};
        if (!parsed.transactionBase64) {
          fail("Missing serialized transaction");
          return;
        }
        pendingTx.current = {
          transactionBase64: parsed.transactionBase64,
          cluster: parsed.cluster || "solana:devnet",
          requiredSigner: typeof parsed.requiredSigner === "string" ? parsed.requiredSigner : undefined,
        };
      } catch {
        fail("Missing serialized transaction");
        return;
      }
    }

    setActionVersion((version) => version + 1);

    if (!ready) {
      postToShell({ type: "gimi:privy-status", message: "Loading wallet login..." });
      return;
    }

    if (!authenticated) {
      postToShell({ type: "gimi:privy-status", message: "Opening Privy..." });
      hasOpenedLogin.current = true;
      login({ loginMethods: [...loginMethods] });
      return;
    }

    postToShell({ type: "gimi:privy-status", message: "Preparing wallet signature..." });
  }, [authenticated, fail, login, postToShell, ready]);

  const authorizeCardCheckout = useCallback(async (accessToken: string) => {
    const pending = pendingCardCheckout.current;
    if (!pending) throw new Error("Missing card rental terms");
    const wallet = wallets[0] as ConnectedStandardSolanaWallet | undefined;
    const response = await fetch("/api/payments/stripe/authorize", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...pending, renterWallet: wallet?.address || pending.renterWallet }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Stripe authorization failed");

    pendingAction.current = null;
    pendingCardCheckout.current = null;
    hasStartedCardCheckout.current = false;
    hasOpenedLogin.current = false;
    setCardLinkToken(undefined);
    setActionVersion((version) => version + 1);
    postToShell({ type: "gimi:card-checkout-complete", intent: data.intent, authorization: data.authorization });
  }, [postToShell, wallets]);

  const startCardCheckout = useCallback((input: Partial<PendingCardCheckout>) => {
    const itemId = typeof input.itemId === "string" ? input.itemId.trim() : "";
    const hours = Number(input.hours);
    if (!itemId || !Number.isFinite(hours) || hours < 1 || hours > 24 * 7) {
      failCardCheckout("Invalid card rental terms");
      return;
    }
    pendingCardCheckout.current = {
      itemId,
      hours,
      renterWallet: typeof input.renterWallet === "string" ? input.renterWallet : undefined,
    };
    pendingAction.current = "card-checkout";
    hasStartedCardCheckout.current = false;
    hasOpenedLogin.current = false;
    setActionVersion((version) => version + 1);

    if (!ready) {
      postToShell({ type: "gimi:privy-status", message: "Loading secure card checkout..." });
      return;
    }
    if (!authenticated) {
      hasOpenedLogin.current = true;
      postToShell({ type: "gimi:privy-status", message: "Sign in before linking a rental card..." });
      login({ loginMethods: [...loginMethods] });
    }
  }, [authenticated, failCardCheckout, login, postToShell, ready]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;

      const type = event.data?.type;
      if (type === "gimi:request-privy-connect") {
        startAction("connect");
      }
      if (type === "gimi:request-privy-transaction") {
        startAction("send-transaction");
      }
      if (type === "gimi:request-privy-message") {
        const message = typeof event.data?.message === "string" ? event.data.message : "";
        const requiredSigner = typeof event.data?.requiredSigner === "string" ? event.data.requiredSigner : "";
        try {
          if (!message || message.length > 1000) throw new Error("Invalid owner action message");
          new PublicKey(requiredSigner);
          pendingMessage.current = { message, requiredSigner };
          startAction("sign-message");
        } catch (error) {
          fail(error instanceof Error ? error.message : "Invalid owner action request");
        }
      }
      if (type === "gimi:request-card-checkout") {
        startCardCheckout(event.data || {});
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fail, startAction, startCardCheckout]);

  useEffect(() => {
    if (!pendingAction.current || !ready || authenticated || hasOpenedLogin.current) return;
    hasOpenedLogin.current = true;
    postToShell({ type: "gimi:privy-status", message: "Opening Privy..." });
    login({ loginMethods: [...loginMethods] });
  }, [authenticated, login, postToShell, ready]);

  useEffect(() => {
    const action = pendingAction.current;
    if (!action || !ready || !authenticated) return;

    if (action === "card-checkout") {
      if (hasStartedCardCheckout.current || cardLinkToken) return;
      hasStartedCardCheckout.current = true;
      getAccessToken()
        .then(async (accessToken) => {
          if (!accessToken) throw new Error("Privy session token is unavailable");
          const response = await fetch("/api/payments/stripe/card/status", {
            headers: { authorization: `Bearer ${accessToken}` },
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not check saved card");
          if (!data.configured) {
            pendingAction.current = null;
            pendingCardCheckout.current = null;
            hasStartedCardCheckout.current = false;
            postToShell({ type: "gimi:card-checkout-unavailable" });
            return;
          }
          if (!data.linked) {
            setCardLinkToken(accessToken);
            return;
          }
          await authorizeCardCheckout(accessToken);
        })
        .catch((error) => failCardCheckout(error instanceof Error ? error.message : "Card checkout failed"));
      return;
    }

    if (!walletsReady) return;

    const requiredSigner =
      action === "sign-message" ? pendingMessage.current?.requiredSigner :
      action === "send-transaction" ? pendingTx.current?.requiredSigner : undefined;
    const wallet = (requiredSigner
      ? wallets.find((candidate) => candidate.address === requiredSigner)
      : wallets[0]) as ConnectedStandardSolanaWallet | undefined;
    if (!wallet) {
      if (requiredSigner && wallets.length) {
        fail("Connect the wallet required for this rental action");
        return;
      }
      if (hasTriedCreateWallet.current) return;
      hasTriedCreateWallet.current = true;
      postToShell({ type: "gimi:privy-status", message: "Creating your Solana wallet..." });
      ensureWallet()
        .then(() => {
          postToShell({ type: "gimi:privy-status", message: "Wallet ready. Preparing signature..." });
        })
        .catch(() => fail("Could not create Solana wallet"));
      return;
    }

    if (action === "connect") {
      if (hasStartedSignIn.current) return;
      hasStartedSignIn.current = true;
      postToShell({ type: "gimi:privy-status", message: "Awaiting wallet sign-in message..." });
      signWalletLogin(wallet, signMessage)
        .then((auth) => {
          pendingAction.current = null;
          hasOpenedLogin.current = false;
          setActionVersion((version) => version + 1);
          postToShell({ type: "gimi:privy-wallet-connected", address: wallet.address, auth });
        })
        .catch(() => {
          hasStartedSignIn.current = false;
          fail("Could not sign wallet login message");
        });
      return;
    }

    if (action === "sign-message") {
      const pending = pendingMessage.current;
      if (!pending || hasStartedSignIn.current) return;
      if (wallet.address !== pending.requiredSigner) {
        fail("Connected wallet does not match the rental owner");
        return;
      }
      hasStartedSignIn.current = true;
      postToShell({ type: "gimi:privy-status", message: "Awaiting owner approval..." });
      signMessage({
        message: new TextEncoder().encode(pending.message),
        wallet,
        options: {
          uiOptions: {
            title: "Approve rental action",
            description: "Sign this message to confirm the selected owner action.",
            buttonText: "Approve",
          },
        },
      })
        .then(({ signature }) => {
          pendingAction.current = null;
          pendingMessage.current = null;
          hasOpenedLogin.current = false;
          setActionVersion((version) => version + 1);
          postToShell({
            type: "gimi:privy-message-signed",
            address: wallet.address,
            message: pending.message,
            signature: signatureToBase58(signature),
          });
        })
        .catch(() => {
          hasStartedSignIn.current = false;
          fail("Could not approve owner action");
        });
      return;
    }

    if (action === "send-transaction") {
      const transaction = pendingTx.current;
      if (!transaction || hasStartedTransaction.current) return;
      try {
        validateRequiredSigner(transaction, wallet.address);
      } catch (error) {
        fail(error instanceof Error ? error.message : "Could not verify transaction signer");
        return;
      }
      hasStartedTransaction.current = true;
      postToShell({ type: "gimi:privy-status", message: "Awaiting wallet approval..." });
      signAndSendTransaction(wallet, transaction, signTransaction)
        .then((signature) => {
          pendingAction.current = null;
          pendingTx.current = null;
          hasOpenedLogin.current = false;
          setActionVersion((version) => version + 1);
          try {
            window.localStorage.removeItem("gimi.pendingPrivyTransaction");
          } catch {}
          postToShell({ type: "gimi:privy-transaction-sent", signature });
        })
        .catch(() => {
          hasStartedTransaction.current = false;
          fail("Could not sign rental transaction");
        });
    }
  }, [actionVersion, authenticated, authorizeCardCheckout, cardLinkToken, ensureWallet, fail, failCardCheckout, getAccessToken, postToShell, ready, signMessage, signTransaction, wallets, walletsReady]);

  return (
    <main className="h-screen overflow-hidden bg-[#080a12]">
      <iframe
        ref={frameRef}
        src={`/gimi.html?embedded=1${partnerDemo ? "&demo=partner" : ""}`}
        title="Gimi"
        className="block h-full w-full border-0"
        allow="clipboard-read; clipboard-write; publickey-credentials-get"
      />
      {cardLinkToken ? (
        <StripeCardLink
          accessToken={cardLinkToken}
          onLinked={() => {
            hasStartedCardCheckout.current = true;
            authorizeCardCheckout(cardLinkToken).catch((error) =>
              failCardCheckout(error instanceof Error ? error.message : "Card checkout failed")
            );
          }}
          onCancel={() => failCardCheckout("Card checkout cancelled")}
        />
      ) : null}
    </main>
  );
}
