import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { Shell } from "./shell";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--sans",
});
/** Section headings only. The one voice on the board that is not data. */
const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--serif",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--mono",
});

/**
 * Declaring the scheme is what stops Dark Reader (and similar) from re-tinting
 * a UI that is already dark. Without it the extension rewrites every inline
 * style before React hydrates, which both breaks hydration and means the
 * colours on screen are not the colours in this file.
 */
export const viewport = { colorScheme: "dark" as const };

export const metadata: Metadata = {
  title: "Cloudgeng Finance Tracker",
  description: "What is running out across the portfolio, and what it costs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: Dark Reader and similar extensions stamp
    // data-darkreader-* onto <html> before React hydrates, so the server
    // markup can never match. The warning is about the extension, not us.
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
