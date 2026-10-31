import type { Metadata } from "next";
import localFont from "next/font/local";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Ledger type stack, one family: Plex Serif for headings and record names,
// Plex Sans for the interface, Plex Mono for IDs, sources and code.
// Self-hosted (src/app/fonts, OFL.txt) so builds never fetch Google Fonts.
// Files: official @ibm/plex-sans 1.1.0, plex-serif 2.0.0, plex-mono 2.5.0,
// subset to Google Fonts' latin + latin-ext ranges.
const plexSans = localFont({
  src: [
    { path: "./fonts/IBMPlexSans-Regular-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexSans-Medium-latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/IBMPlexSans-SemiBold-latin.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans",
  display: "swap",
  adjustFontFallback: "Arial",
});

const plexSerif = localFont({
  src: [
    { path: "./fonts/IBMPlexSerif-Regular-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexSerif-Medium-latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/IBMPlexSerif-SemiBold-latin.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-serif",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});

const plexMono = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-Regular-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexMono-Medium-latin.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  title: {
    default: "CanonCRM",
    template: "%s | CanonCRM",
  },
  description:
    "A CRM that fills itself and stays clean.",
  applicationName: "CanonCRM",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${plexSans.variable} ${plexSerif.variable} ${plexMono.variable} font-sans antialiased`}
      >
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  );
}
