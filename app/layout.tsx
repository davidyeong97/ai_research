import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Council",
  description: "Multi-agent council & consensus chat",
};

export const viewport: Viewport = { viewportFit: "cover", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
