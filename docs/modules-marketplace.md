# Module marketplace

Canon ships open modules in its public AGPL repository to seed the module marketplace.
Open modules cover CRM table stakes or give module authors a reference implementation.
Private modules contain deep domain IP, require agency delivery or hosted services,
or carry terms-of-service risk. Their source stays in the private repository.

Each module's `module.json` declares `visibility` as `open` or `private`.
The public exporter reads that field and omits private module source and bundles.

Open modules are reports, forecast, work, monthly-goals, audiences, icps, ai-fields,
customer-success, win-loss, deal-rooms, notetaker, sequences, and dialer.

Private modules are commissions, sales-planning, attribution, conversation-intelligence,
enablement, field-visits, pull, rep-desk, agents, and linkedin.
The agency sells or delivers these modules. Later, customers will install them into
a self-hosted Canon from a private registry. Revenue sharing remains to be decided.
