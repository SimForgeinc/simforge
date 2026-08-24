import type { Metadata } from "next";
import { Bricolage_Grotesque, Barlow, Chakra_Petch } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const body = Barlow({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
  display: "swap",
});

const heavy = Chakra_Petch({
  subsets: ["latin"],
  variable: "--font-heavy",
  weight: ["600", "700"],
  display: "swap",
});

const SITE_URL = "https://simforge.ai";
const SITE_TITLE = "SimForge — Data Infrastructure for Physical AI";
const SITE_DESCRIPTION =
  "SimForge turns real-world streets into simulation-ready digital twins. Compose scenarios, render multi-sensor synthetic data, and validate autonomous systems in CARLA and Unreal Engine — all from the browser.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: "%s | SimForge",
  },
  description: SITE_DESCRIPTION,
  applicationName: "SimForge",
  keywords: [
    "digital twin",
    "physical AI",
    "autonomous vehicle simulation",
    "CARLA simulator",
    "synthetic data generation",
    "scenario generation",
    "HD maps",
    "robotics simulation",
    "sensor simulation",
    "Cosmos Transfer",
  ],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "SimForge",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${display.variable} ${body.variable} ${heavy.variable}`}>
      <body className="min-h-svh">
        {children}
        <Toaster theme="dark" richColors position="bottom-right" />
      </body>
    </html>
  );
}
