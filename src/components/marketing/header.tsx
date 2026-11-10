"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";

const navLinks = [
  { href: "/#data", label: "Built-in data" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#receipts", label: "Field sources" },
  { href: "/pricing", label: "Pricing" },
];

export function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="header-logo">
          <Image src="/logo.svg" alt="CanonCRM" width={32} height={32} />
          <span className="header-logo-text">CanonCRM</span>
        </Link>

        <nav className={`header-nav${menuOpen ? " open" : ""}`}>
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="header-nav-link"
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/sign-in"
            className="header-nav-link"
            onClick={() => setMenuOpen(false)}
          >
            Sign In
          </Link>
          <Link
            href="/#start"
            className="header-cta header-cta--signup"
            onClick={() => setMenuOpen(false)}
          >
            Get started
          </Link>
        </nav>

        <button
          className={`hamburger${menuOpen ? " open" : ""}`}
          aria-label="Toggle navigation"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((prev) => !prev)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>
    </header>
  );
}
