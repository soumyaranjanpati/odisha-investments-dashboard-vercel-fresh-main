// src/app/layout.tsx
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "State Investments Dashboard",
  description: "Real-time view of state-specific investment intents, MoUs, proposals, and expansions.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="page-bg">{children}</body>
    </html>
  );
}
