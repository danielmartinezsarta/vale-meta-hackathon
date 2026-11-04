import type { Metadata } from "next";
import {
  Cormorant_Garamond,
  Hanken_Grotesk,
  Josefin_Sans,
} from "next/font/google";
import "./globals.css";
import "../components/vale-sheets.css";

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
  var saved = null;
  try {
    saved = localStorage.getItem("vale-theme");
  } catch (e) {}
  document.documentElement.dataset.theme = saved === "light" ? "light" : "dark";
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
