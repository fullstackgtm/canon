import Image from "next/image";
import Link from "next/link";

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <Link href="/" className="footer-logo">
            <Image src="/logo.svg" alt="CanonCRM" width={32} height={32} />
            <span>CanonCRM</span>
          </Link>
          <p className="footer-tagline">A CRM that fills itself and stays clean.</p>
        </div>

        <div className="footer-links">
          <div className="footer-col">
            <p className="footer-heading">Product</p>
            <Link href="/#data">Built-in data</Link>
            <Link href="/#how-it-works">How it works</Link>
            <Link href="/#receipts">Field sources</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/llms.txt">For agents</Link>
          </div>
          <div className="footer-col">
            <p className="footer-heading">Account</p>
            <Link href="/sign-in">Sign in</Link>
            <Link href="/#start">Get started</Link>
          </div>
          <div className="footer-col">
            <p className="footer-heading">Legal</p>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </div>
        </div>

        <div className="footer-bottom">
          <p>&copy; {year} CanonCRM. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
