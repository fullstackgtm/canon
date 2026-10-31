import type { Metadata } from "next";
import { CanonSections } from "@/components/marketing/canon-sections";
import { DomainStartForm } from "@/components/marketing/domain-start-form";

export const metadata: Metadata = {
  title: { absolute: "CanonCRM: a CRM that fills itself and stays clean" },
  description: "Canon builds your market from your website when you sign up, and every field shows where it came from.",
};

export default function HomePage() {
  return (
    <>
      <section className="home-hero" id="start">
        <div className="container">
          <h1>A CRM that fills itself and stays clean.</h1>
          <p className="home-hero-copy">
            Enter your website. Canon works out who you sell to and fills your CRM with the accounts
            and people that fit. After that, AI agents, imports and enrichment tools can only suggest
            changes, and every field shows where it came from.
          </p>
          <DomainStartForm />
        </div>
      </section>
      <CanonSections />
    </>
  );
}
