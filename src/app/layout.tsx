import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gimi — Agentic Rentals",
  description: "AI rental agent for communities with Solana escrow, receipts, and reputation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-white text-black">
        {children}
      </body>
    </html>
  );
}
