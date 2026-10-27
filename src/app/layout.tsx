import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vale — hands-free voice assistant",
  description:
    "Voice-first assistant for entrepreneurs who work with their hands.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
