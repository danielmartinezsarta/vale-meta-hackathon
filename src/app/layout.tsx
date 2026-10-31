import type { Metadata } from "next";
import {
  Cormorant_Garamond,
  Hanken_Grotesk,
  Josefin_Sans,
} from "next/font/google";
import "./globals.css";

const wordmark = Josefin_Sans({
  weight: ["300"],
  subsets: ["latin"],
  variable: "--font-word",
});

const slogan = Cormorant_Garamond({
  weight: ["300"],
  style: ["italic"],
  subsets: ["latin"],
  variable: "--font-slogan",
});

const ui = Hanken_Grotesk({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-ui",
});

export const metadata: Metadata = {
  title: "Vale — hands-free voice assistant",
  description:
    "Voice-first assistant for entrepreneurs who work with their hands.",
};

const themeScript = `
(function () {
  try {
    var saved = localStorage.getItem("vale-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.dataset.theme = saved;
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${wordmark.variable} ${slogan.variable} ${ui.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
