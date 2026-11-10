import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: { absolute: "Privacy Policy | CanonCRM" },
  description: "How CanonCRM collects, uses and protects personal information.",
  alternates: { canonical: "/privacy" },
};

const CONTACT = "support@canoncrm.com";

const PROCESSORS: Array<[string, string]> = [
  ["Clerk", "Sign-in, accounts and organizations"],
  ["Convex", "Application database and backend"],
  ["Amazon Web Services (virtual machine)", "Application hosting"],
  ["Cloudflare", "Network, security and access control"],
  ["Stripe", "Payments, invoicing and tax"],
  ["OpenRouter and TypeSafe", "AI inference and evidence checks that Canon runs"],
  ["ScrapingBee", "Fetching public web pages for research"],
  ["Licensed data providers", "Company and business contact data, and email verification"],
  ["Unipile", "LinkedIn actions you choose to automate, and email you send from a Gmail account you link"],
];

export default function PrivacyPage() {
  return (
    <article className="legal">
      <div className="container--narrow">
        <h1>Privacy Policy</h1>
        <p className="legal-meta">Effective October 10, 2026</p>

        <p>
          This policy explains how Full Stack GTM LLC (&ldquo;we&rdquo;, &ldquo;us&rdquo;) collects,
          uses and shares personal information through CanonCRM: the website at canoncrm.com, the web
          application, the API, the MCP server and the command-line tools (the &ldquo;Service&rdquo;).
          Our <Link href="/terms">Terms of Service</Link> govern use of the Service.
        </p>

        <h2>1. Two kinds of personal information</h2>
        <p>
          <strong>About our customers and visitors.</strong> This is information about people who
          visit our site, sign up or use the Service. For it, we decide why and how it is processed.
        </p>
        <p>
          <strong>Inside customer workspaces.</strong>{" "}
          Customers use Canon to keep records about the
          companies and business contacts they sell to. For those records, our customer decides what
          is kept and how it is used, and we process it on their behalf. If you are a contact in a
          customer&rsquo;s CRM, section 6 explains how to reach us, and we will pass your request to
          the right customer where needed.
        </p>

        <h2>2. What we collect</h2>
        <h3>Information you give us</h3>
        <ul>
          <li>Account details: name, email address, organization and role.</li>
          <li>
            Your company website domain, which Canon uses to work out who you sell to.
          </li>
          <li>
            Billing details. Stripe processes card details; we do not store full card numbers.
          </li>
          <li>Messages you send us, such as support requests and bug reports.</li>
        </ul>
        <h3>Information from services you connect</h3>
        <p>
          When you connect a service such as HubSpot, Salesforce, Slack, Google, Microsoft, LinkedIn
          or an AI account, we receive the data and tokens needed to provide the feature you enabled,
          within the permissions you grant. We encrypt stored access tokens.
        </p>
        <h3>Information collected automatically</h3>
        <ul>
          <li>
            Log and device data: IP address, browser, pages and API endpoints used, timestamps and
            errors. We use it to run, secure and debug the Service.
          </li>
          <li>
            Cookies: strictly necessary cookies for sign-in (set by Clerk) and a short-lived cookie
            that links an anonymous research preview to the account you create. We do not use
            advertising cookies or third-party ad trackers.
          </li>
        </ul>
        <h3>Business contact data from public sources and providers</h3>
        <p>
          To fill a customer&rsquo;s CRM, the Service collects information about companies and the
          people who work at them. This includes names, job titles, employers, business email
          addresses, professional profile URLs and company facts. The sources are public websites
          and licensed data providers, and the Service records the source of each field. Canon is
          designed for business-to-business use. It does not seek sensitive information, such as
          health, financial account, or government ID data.
        </p>

        <h2>3. How we use it</h2>
        <ul>
          <li>To provide, maintain and support the Service, including the features you turn on.</li>
          <li>To fill and maintain CRM records for customers, with sources attached.</li>
          <li>To bill you and to keep business and tax records.</li>
          <li>To secure the Service, prevent abuse and enforce our Terms.</li>
          <li>
            To send service messages, and product news that you can opt out of at any time.
          </li>
          <li>
            To improve the Service, using aggregated or de-identified data where we can.
          </li>
          <li>To comply with law and respond to lawful requests.</li>
        </ul>
        <p>
          We do not sell personal information, and we do not share it for cross-context behavioural
          advertising. We do not use customer workspace data to train AI models that are offered to
          anyone else.
        </p>
        <p>
          Where the GDPR or UK GDPR applies, our legal bases are: performance of our contract with
          you; our legitimate interests in running, securing and improving a B2B service, and in
          providing business contact data for B2B sales, balanced against your rights; your consent
          where we ask for it; and legal obligations.
        </p>

        <h2>4. AI processing</h2>
        <p>
          Some features send workspace data to AI models, for example to research an account or to
          check that a fact matches its cited source. Some of that runs on the AI account you connect,
          such as your own ChatGPT plan, under that provider&rsquo;s terms and privacy policy. The
          rest runs through the providers listed below, which process the data to return a result for
          us.
        </p>

        <h2>5. Who we share it with</h2>
        <p>
          We share personal information with service providers that process it for us under
          contracts that limit how they use it. The main ones are:
        </p>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            {PROCESSORS.map(([name, purpose]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          The marketing site also loads its typeface from Google Fonts, which receives your IP
          address. We also share information:
        </p>
        <ul>
          <li>with services you connect, when you ask us to sync or act in them;</li>
          <li>with other members of your organization&rsquo;s workspace;</li>
          <li>when the law requires it, or to protect rights, safety and the Service; and</li>
          <li>
            in a merger, acquisition or sale of assets. This policy continues to apply to the
            information transferred.
          </li>
        </ul>

        <h2>6. Your rights and choices</h2>
        <p>
          Depending on where you live, you may have the right to access, correct, delete or receive
          a copy of your personal information. You may also have the right to object to or restrict
          processing, to opt out of its use for marketing, and to withdraw consent. California
          residents have these rights under the CCPA, and we will not discriminate against you for
          using them. You may use an authorized agent; we may ask them to prove they act for you.
        </p>
        <p>
          <strong>If you are a business contact in our data</strong> and do not want to be in it,
          email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address in question, or tell us
          which address it is. We will stop the Service from adding you to workspaces and keep a
          record of your request so that you are not added again. We will also forward your request to any
          customer whose workspace holds your record, because they control their own copy.
        </p>
        <p>
          To make any request, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. We will verify your
          identity before acting, and we will respond within the time the law requires, usually 30
          to 45 days. If you are in the EEA or the UK, you can also complain to your local data
          protection authority.
        </p>

        <h2>7. Retention</h2>
        <p>
          We keep account information while your account is active. When a workspace is closed, the
          customer can export its data for 30 days. After that, we delete it within a reasonable
          period. Backups expire on their normal schedule. We keep billing records for as long as tax
          and accounting law requires, and security logs for a limited period. We keep suppression
          records for people who opted out so that they stay out.
        </p>

        <h2>8. Security</h2>
        <p>
          We protect data with access controls, encryption in transit, encryption of stored
          credentials, audit logs, and approval gates on writes to connected systems. No system is
          perfectly secure. If a breach affects your personal information, we will notify you as the
          law requires.
        </p>

        <h2>9. International transfers</h2>
        <p>
          We are based in the United States, and we and our providers process data there and in
          other countries. Where the law requires it, we use appropriate safeguards for transfers,
          such as the European Commission&rsquo;s Standard Contractual Clauses.
        </p>

        <h2>10. Children</h2>
        <p>
          The Service is for businesses. It is not directed to children under 16, and we do not
          knowingly collect their personal information.
        </p>

        <h2>11. Changes</h2>
        <p>
          We will post any update here and change the effective date. If a change is material, we
          will also tell customers by email or in the Service before it takes effect.
        </p>

        <h2>12. Contact</h2>
        <p>
          Full Stack GTM LLC
          <br />
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
        </p>
      </div>
    </article>
  );
}
