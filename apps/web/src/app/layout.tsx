import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "XLRrank",
  description:
    "Platform-agnostic social, audience, relationship, content, and network intelligence platform.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            XLR<span className="brand-accent">rank</span>
          </Link>
          <nav className="primary-nav">
            <Link href="/">Dashboard</Link>
            <Link href="/discover">Discover</Link>
            <Link href="/relationships">Relationships</Link>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <span>© {new Date().getFullYear()} XLRrank</span>
        </footer>
      </body>
    </html>
  );
}
