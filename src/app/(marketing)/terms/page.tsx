import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: { absolute: "Terms of Service | CanonCRM" },
  description: "The terms that govern your use of CanonCRM.",
  alternates: { canonical: "/terms" },
};

const CONTACT = "support@canoncrm.com";

export default function TermsPage() {
  return (
    <article className="legal">
      <div className="container--narrow">
        <h1>Terms of Service</h1>
        <p className="legal-meta">Effective October 10, 2026</p>

        <p>
          These Terms of Service (the &ldquo;Terms&rdquo;) are an agreement between you and Full Stack
          GTM LLC (&ldquo;Full Stack GTM&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). They govern
          your use of CanonCRM, including the website at canoncrm.com, the web application, the API,
          the MCP server, the command-line tools and any related services (together, the
          &ldquo;Service&rdquo;). If you use the Service for an organization, you accept these Terms
          for that organization and confirm that you have authority to do so. In that case,
          &ldquo;you&rdquo; means the organization.
        </p>
        <p>
          If you do not agree to these Terms, do not use the Service. Our{" "}
          <Link href="/privacy">Privacy Policy</Link> explains how we handle personal information.
        </p>

        <h2>1. The Service</h2>
        <p>
          CanonCRM is a customer relationship management system. It builds and maintains account and
          contact records from your website, public sources, licensed data providers, integrations
          you connect and AI agents you authorize. It records where each field came from. We may
          change, add or remove features over time. If we remove a material paid feature, we will
          give you reasonable notice.
        </p>

        <h2>2. Accounts</h2>
        <ul>
          <li>You must be at least 18 and able to form a binding contract.</li>
          <li>
            You must give accurate account information. You are responsible for everything done
            under your account, including by members you invite and by agents, API tokens and CLI
            sessions you authorize.
          </li>
          <li>
            Keep your credentials and tokens secure. Tell us promptly at{" "}
            <a href={`mailto:${CONTACT}`}>{CONTACT}</a> if you suspect unauthorized access.
          </li>
        </ul>

        <h2>3. Your data</h2>
        <p>
          &ldquo;Customer Data&rdquo; means the data you or your users, agents and integrations put
          into the Service, and the records the Service creates for your workspace. As between you
          and us, you own Customer Data. You grant us a worldwide, non-exclusive licence to host,
          copy, process and display Customer Data only as needed to provide, secure and support the
          Service, and as described in the Privacy Policy.
        </p>
        <p>
          You are responsible for having the rights and legal basis to put Customer Data into the
          Service, and for how you use the contact data in it. That includes complying with
          anti-spam, telemarketing, data protection and privacy laws (for example CAN-SPAM, the TCPA,
          the CCPA and, where they apply, the GDPR and UK GDPR) when you contact anyone.
        </p>
        <p>
          We may use aggregated or de-identified data that does not identify you, your users or any
          person to operate and improve the Service. We do not sell Customer Data, and we do not use
          it to train AI models that are offered to anyone else.
        </p>

        <h2>4. Data from public sources and providers</h2>
        <p>
          The Service can add company and contact data from public websites and from third-party
          data providers. That data comes from sources we do not control. It can be incomplete,
          outdated or wrong, and the Service shows its source so you can judge it. Third-party data
          is licensed to you only for your internal business use within the Service. You may not
          resell it, redistribute it in bulk or use it to build a competing dataset. Providers may
          require us to remove or correct records, and we may do so in your workspace when they do.
        </p>
        <p>
          Company data includes the{" "}
          <a href="https://www.peopledatalabs.com/company-dataset">People Data Labs free company dataset</a>.
          Occupation data comes from O*NET 31.0 by the U.S. Department of Labor, Employment and
          Training Administration (USDOL/ETA), and from the BLS Occupational Employment and Wage
          Statistics. The People Data Labs and O*NET data are used under the{" "}
          <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> license.
        </p>

        <h2>5. AI features and agents</h2>
        <ul>
          <li>
            AI output can be inaccurate. Review it before you rely on it or act on it, especially
            before anything is sent to another person.
          </li>
          <li>
            Some features run on an AI account you connect, such as your own ChatGPT plan. Your use
            of that account is also governed by its provider&rsquo;s terms, and its provider bills
            you directly.
          </li>
          <li>
            You control which agents can access your workspace and what they may write. Actions an
            agent takes under a grant you gave are your actions under these Terms.
          </li>
        </ul>

        <h2>6. Integrations and third-party services</h2>
        <p>
          You can connect services such as HubSpot, Salesforce, Slack, Google, Microsoft, LinkedIn
          and email inboxes. When you do, you authorize us to access and act in those services on
          your behalf, within the permissions you grant. Your use of them stays subject to their own
          terms. Some platforms restrict automated activity. If you choose to automate actions on a
          third-party platform through the Service, for example LinkedIn invitations or messages,
          you accept the risk that the platform may limit or suspend your account. We are not
          responsible for third-party services or for changes that break an integration.
        </p>

        <h2>7. Acceptable use</h2>
        <p>You will not, and will not let anyone else:</p>
        <ul>
          <li>
            send spam or unlawful messages, or contact anyone who has opted out, through the Service;
          </li>
          <li>
            use the Service to harass, discriminate, or make decisions about anyone&rsquo;s
            eligibility for employment, credit, insurance or housing;
          </li>
          <li>upload malware or content that infringes someone else&rsquo;s rights;</li>
          <li>
            probe, scan or test the Service&rsquo;s security, or get around its limits or access
            controls, except through a disclosure we have authorized in writing;
          </li>
          <li>
            scrape the Service, overload it, or reverse engineer it except where the law allows
            despite this restriction;
          </li>
          <li>resell the Service or use it to build a competing product; or</li>
          <li>use the Service in violation of law or sanctions.</li>
        </ul>
        <p>
          We may suspend access that violates this section or that threatens the Service or other
          customers. Where it is practical, we will tell you first and give you a chance to fix the
          problem.
        </p>

        <h2>8. Plans, payment and credits</h2>
        <ul>
          <li>
            Paid plans are billed in advance through Stripe, monthly or annually, and renew
            automatically until cancelled. You can cancel at any time. Cancellation takes effect at
            the end of the current billing period.
          </li>
          <li>
            Some work is metered and paid from prepaid credits, such as verified emails and deep
            research. The Service shows a run&rsquo;s cost before you start it. Credits are not cash,
            cannot be transferred, and may expire as stated when you buy them.
          </li>
          <li>
            Fees exclude taxes. You pay applicable taxes, which we collect where required.
          </li>
          <li>
            Except where the law requires otherwise, fees and credits are non-refundable. If a
            charge is wrong, tell us within 60 days.
          </li>
          <li>
            We may change prices with at least 30 days&rsquo; notice. The change applies from your
            next billing period.
          </li>
          <li>We may suspend paid features if an invoice is more than 15 days overdue.</li>
        </ul>
        <p>
          Free trials last for the period shown at sign-up. At the end of a trial, you need a paid
          plan to keep using paid features.
        </p>

        <h2>9. Our property and feedback</h2>
        <p>
          We and our licensors own the Service, including its software, design and documentation.
          These Terms give you only the right to use the Service as described here. If you send us
          feedback or suggestions, we may use them without any obligation to you.
        </p>

        <h2>10. Confidentiality and security</h2>
        <p>
          Each of us will protect the other&rsquo;s non-public information with reasonable care and
          use it only to perform under these Terms. We use administrative, technical and physical
          safeguards designed to protect Customer Data. They are described in the Privacy Policy.
        </p>

        <h2>11. Term, termination and export</h2>
        <p>
          You may stop using the Service and close your workspace at any time. We may terminate these
          Terms if you materially breach them and do not cure the breach within 15 days of notice, or
          immediately for a serious violation of section 7. After termination, you can export
          Customer Data for 30 days. After that, we delete it within a reasonable period, except
          where the law requires us to keep it, and except for backups that expire on their normal
          schedule. Sections 3, 4, 9, 12 to 15 and any unpaid fees survive termination.
        </p>

        <h2>12. Disclaimers</h2>
        <p>
          THE SERVICE, ITS DATA AND ITS AI OUTPUT ARE PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
          AVAILABLE&rdquo;. TO THE EXTENT THE LAW ALLOWS, WE DISCLAIM ALL WARRANTIES, EXPRESS OR
          IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY AND
          NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED OR ERROR-FREE.
        </p>

        <h2>13. Limitation of liability</h2>
        <p>
          TO THE EXTENT THE LAW ALLOWS: (A) NEITHER PARTY IS LIABLE FOR INDIRECT, INCIDENTAL,
          SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE OR DATA, EVEN IF
          IT WAS ADVISED THEY WERE POSSIBLE; AND (B) EACH PARTY&rsquo;S TOTAL LIABILITY ARISING OUT
          OF OR RELATING TO THESE TERMS IS LIMITED TO THE AMOUNTS YOU PAID US IN THE 12 MONTHS BEFORE
          THE EVENT THAT GAVE RISE TO THE CLAIM, OR US$100 IF THAT AMOUNT IS GREATER. THESE LIMITS
          DO NOT APPLY TO YOUR PAYMENT OBLIGATIONS, YOUR BREACH OF SECTION 7, OR EITHER PARTY&rsquo;S
          INDEMNITY OBLIGATIONS.
        </p>

        <h2>14. Indemnity</h2>
        <p>
          You will defend and indemnify Full Stack GTM against third-party claims arising from
          Customer Data, your outreach to anyone using the Service, or your breach of section 7. We
          will defend and indemnify you against third-party claims that the Service, as we provide
          it, infringes their intellectual property rights. The party seeking indemnity must give
          prompt notice, give reasonable cooperation and let the other party control the defence.
        </p>

        <h2>15. Governing law and disputes</h2>
        <p>
          These Terms are governed by the laws of the State of California, without regard to its
          conflict-of-laws rules. The state and federal courts located in California have exclusive
          jurisdiction, and each party consents to them. Either party may seek injunctive relief in
          any court of competent jurisdiction to protect its intellectual property or confidential
          information.
        </p>

        <h2>16. Changes to these Terms</h2>
        <p>
          We may update these Terms. If a change is material, we will tell you by email or in the
          Service at least 30 days before it takes effect, unless the change is required by law. If
          you keep using the Service after a change takes effect, you accept the change.
        </p>

        <h2>17. General</h2>
        <p>
          These Terms, the Privacy Policy and any order form or plan you accept are the entire
          agreement between us about the Service. If a written agreement signed by both parties
          conflicts with these Terms, that agreement controls. You may not assign these Terms without
          our consent. We may assign them in connection with a merger, acquisition or sale of
          assets. If any part of these Terms is unenforceable, the rest remains in effect. A failure
          to enforce a provision is not a waiver. Neither party is liable for delays caused by events
          beyond its reasonable control.
        </p>

        <h2>18. Contact</h2>
        <p>
          Full Stack GTM LLC
          <br />
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
        </p>
      </div>
    </article>
  );
}
