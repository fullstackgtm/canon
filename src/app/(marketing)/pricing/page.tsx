import type { Metadata } from "next";
import { CREDIT_PACKS, CREDIT_RATES, FREE_CREDITS_PER_MONTH, creditsPerRecord } from "../../../../convex/lib/creditPacks";
import { PAID_PROVIDERS } from "../../../../convex/lib/paidProviders";
import { CreditCalculator } from "@/components/marketing/credit-calculator";

export const metadata: Metadata = {
  title: { absolute: "Pricing: CanonCRM" },
  description: "Canon is free to use. Contacts from paid sources cost credits; every workspace gets free credits each month, and packs cover the rest.",
};

const freeCredits = FREE_CREDITS_PER_MONTH.toLocaleString("en-US");

const free = [
  ["Every seat.", "Invite the whole team. There is no per-seat price."],
  ["Every record.", "Accounts, contacts and deals have no cap."],
  ["Your market, filled.", "Canon fills your CRM from its built-in sources when you sign up."],
  ["Agents.", "They think on your own ChatGPT plan; what they do spends the workspace's credits, like anyone's."],
  ["Free credits.", `Your workspace gets ${freeCredits} a month, shared by your team and its agents.`],
];

const workspace = [
  ["Seats", "Unlimited"],
  ["Records", "Unlimited"],
  ["Agents", "Unlimited"],
  ["Built-in data", "Included"],
  ["Credits", `${freeCredits} free every month`],
  ["Price", "$0"],
];

/** The most a contact costs: the dearest paid source, priced from its cost (creditsPerRecord). */
const premiumContact = Math.max(...PAID_PROVIDERS.map((p) => creditsPerRecord(p.usdPerRecord)));

/** What credits buy today: a contact kept from a paid source, and research without a ChatGPT plan (the rest of CREDIT_RATES is not charged yet, docs/credits.md). */
const rates = [
  { label: "Contact from a paid source", credits: CREDIT_RATES.contact },
  ...(premiumContact > CREDIT_RATES.contact ? [{ label: "Contact from a premium source", credits: premiumContact }] : []),
  { label: "Research answer without a ChatGPT plan (free with one; no answer, no charge)", credits: CREDIT_RATES.accountResearch },
];

export default function PricingPage() {
  return (
    <>
      <section className="home-hero">
        <div className="container">
          <h1>Canon is free to use.</h1>
          <p className="home-hero-copy">
            Seats, records, agents and every CRM feature cost nothing. When you want more people than
            the built-in sources find, contacts from paid sources cost credits, and your workspace
            gets {freeCredits} of them free each month.
          </p>
        </div>
      </section>

      <div className="canon-sections">
        <section className="canon-section">
          <div className="container canon-receipt-grid">
            <div>
              <h2>What you get without paying</h2>
              <ul className="canon-proofs">
                {free.map(([title, body]) => (
                  <li key={title}>
                    <strong>{title}</strong> {body}
                  </li>
                ))}
              </ul>
            </div>
            <dl className="canon-receipt" aria-label="A free workspace">
              {workspace.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="canon-section" id="credits">
          <div className="container canon-receipt-grid">
            <div>
              <h2>What credits buy</h2>
              <p className="canon-lede">
                A paid search is charged only for the contacts it keeps: each one has a full name, a
                LinkedIn profile and the company&apos;s domain. Your team and its agents spend from
                the same balance. Free credits reset on the 1st and are spent first; credits you buy
                last 10 years.
              </p>
            </div>
            <dl className="canon-receipt canon-receipt--wide" aria-label="Credits per action">
              {rates.map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>
                    {r.credits} {r.credits === 1 ? "credit" : "credits"}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="canon-section" id="packs">
          <div className="container">
            <h2>Packs for more</h2>
            <p className="canon-lede">
              When the free credits run out, an admin buys a pack in Settings. The bigger packs add
              bonus credits.
            </p>
            <CreditCalculator packs={CREDIT_PACKS} rates={rates} />
          </div>
        </section>
      </div>
    </>
  );
}
