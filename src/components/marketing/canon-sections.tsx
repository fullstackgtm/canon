import { DomainStartForm } from "./domain-start-form";

const fillPoints = [
  ["Built from your website.", "Canon reads your public site and works out who you sell to: industries, company sizes, regions and buyer titles."],
  ["Accounts and the people at them.", "Companies that fit, ranked by fit, with the contacts at each and their titles."],
  ["Several sources, one record.", "Canon searches several data sources and merges what they find, so a person found twice is one contact."],
  ["No data vendor to sign.", "Filling your market doesn't need a separate data contract."],
];

const fillExample = [
  ["Website", "northwind.example"],
  ["Sells to", "Operations leaders at US logistics companies, 50 to 500 staff"],
  ["Sources searched", "4"],
  ["Accounts", "38,000"],
  ["Contacts", "205,000"],
];

const steps = [
  {
    title: "A source suggests a change",
    body: "An agent, an import or an enrichment tool sends it in, with the page or record it came from.",
  },
  {
    title: "Canon checks it",
    body: "It confirms the quote appears in the source, matches the change to the right company or person, and holds anything that disagrees with what it already has.",
  },
  {
    title: "You approve, then it's saved",
    body: "You approve the batch, or a rule you set does. The record keeps the source, so anyone can see why a field says what it says.",
  },
];

const receipt = [
  ["Field", "contact.employer"],
  ["Value", "Northwind Robotics"],
  ["Source", "northwind.example/team"],
  ["Quote", "“Priya Shah, VP Revenue Operations”"],
  ["Suggested by", "Research agent"],
  ["Approved by", "Rule: employer from team page"],
  ["Learned", "2026-09-12"],
  ["Last checked", "2026-10-05"],
];

const proofs = [
  ["Sources on every field.", "The quote, who suggested it, and when it was learned and last checked."],
  ["No direct writes from agents.", "They suggest changes in batches over MCP or the CLI, and a person or a rule approves them."],
  ["Conflicts wait for you.", "When two sources disagree, you see both values and pick one."],
  ["Duplicates caught first.", "Each company is keyed by its domain, so a second copy is matched before it's saved."],
];

export function CanonSections() {
  return (
    <div className="canon-sections">
      <section id="data" className="canon-section">
        <div className="container canon-receipt-grid">
          <div>
            <h2>Your CRM fills itself</h2>
            <p className="canon-lede">
              Most CRMs start empty, and filling them means buying from a data vendor. Canon comes
              with the data.
            </p>
            <ul className="canon-proofs">
              {fillPoints.map(([title, body]) => (
                <li key={title}>
                  <strong>{title}</strong> {body}
                </li>
              ))}
            </ul>
          </div>
                      <dl className="canon-receipt" aria-label="Example of a filled market">
              {fillExample.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
        </div>
      </section>

      <section id="how-it-works" className="canon-section">
        <div className="container">
          <h2>How a change gets into Canon</h2>
          <p className="canon-lede">
            Your CRM gets messy because every tool can overwrite it. In Canon, a change to data you already have is a suggestion until it's approved.
          </p>
          <ol className="canon-steps">
            {steps.map((step) => (
              <li key={step.title}>
                <strong>{step.title}</strong>
                <span>{step.body}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="receipts" className="canon-section">
        <div className="container canon-receipt-grid">
          <div>
            <h2>Every field shows where it came from</h2>
            <ul className="canon-proofs">
              {proofs.map(([title, body]) => (
                <li key={title}>
                  <strong>{title}</strong> {body}
                </li>
              ))}
            </ul>
          </div>
          <dl className="canon-receipt" aria-label="Example field history">
            {receipt.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="canon-section canon-cta">
        <div className="container">
          <h2>See your market in Canon</h2>
          <p className="canon-lede">
            Enter your website and Canon builds your CRM: the accounts that fit and the people at
            them, each with its sources.
          </p>
          <DomainStartForm />
        </div>
      </section>
    </div>
  );
}
