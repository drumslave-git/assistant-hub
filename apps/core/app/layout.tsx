import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeScript } from "@/components/theme/theme-script";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "llm-tg-bot",
  description: "Telegram LLM bot control dashboard",
};

// This is a live, DB-backed dashboard: every page already opts into dynamic
// rendering. Declaring it here covers the whole tree — including Next's
// built-in /_not-found, which has no page.tsx of its own — so nothing is
// statically prerendered at build time, when DATABASE_URL is intentionally
// absent.
export const dynamic = "force-dynamic";

/**
 * Bare document shell: fonts, theme, global CSS. Everything dashboard-specific
 * (auth gate, nav shell, timezone context) lives in the `(dashboard)` route
 * group's layout, so the public `/login` and `/setup` pages render without the
 * app chrome — and without any data the operator has not signed in to see.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // Dark-first default; ThemeScript reconciles with the persisted choice
      // before hydration to prevent a flash.
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
