export const INTEGRATIONS_AVAILABLE = {
  billing: { label: "Stripe billing", keys: ["STRIPE_BILLING_KEY"] },
  chatgpt: { label: "ChatGPT", keys: ["TOKEN_ENCRYPTION_KEY"] },
  openrouter: { label: "OpenRouter AI", keys: ["OPENROUTER_API_KEY"] },
  treg: { label: "treg data", keys: ["TREG_TOKEN"] },
  unipile: { label: "Gmail and LinkedIn", keys: ["UNIPILE_API_KEY", "UNIPILE_DSN"] },
  dialer: { label: "Telnyx dialer", keys: ["TELNYX_API_KEY", "TELNYX_CONNECTION_ID"] },
  // Only the "Sign in with Salesforce" OAuth button; a workspace can always connect with its own app's key.
  salesforce: { label: "Salesforce sign-in", keys: ["SALESFORCE_CLIENT_ID"] },
  email: { label: "Postmark email", keys: ["POSTMARK_SERVER_TOKEN", "POSTMARK_FROM_ADDRESS"] },
  // convex/emailLog.ts: the domain whose mail reaches /email-log/*, and the secret its adapter sends.
  emailLog: { label: "Email logging by BCC", keys: ["EMAIL_LOG_DOMAIN", "EMAIL_LOG_SECRET"] },
  scrapingbee: { label: "ScrapingBee", keys: ["SCRAPINGBEE_API_KEY"] },
  jev: { label: "Jev", keys: ["JEV_API_KEY"] },
  metronome: { label: "Metronome credits", keys: ["METRONOME_API_KEY"] },
  pi: { label: "Pi research", keys: ["CANON_PI_URL", "CANON_PI_SECRET"], flag: "CANON_PI_RESEARCH_ENABLED", value: "true" },
  recipeRuntime: { label: "Recipe runtime", keys: ["RECIPE_RUNTIME_URL", "RECIPE_RUNTIME_SECRET"] },
  recordService: { label: "Record service", keys: ["RECORD_SERVICE_URL", "RECORD_SERVICE_TOKEN"] },
} as const satisfies Record<string, { label: string; keys: readonly string[]; flag?: string; value?: string }>;

export type IntegrationFeature = keyof typeof INTEGRATIONS_AVAILABLE;
export type IntegrationAvailability = Record<IntegrationFeature, boolean>;
export type IntegrationEnv = Readonly<Record<string, string | undefined>>;

export function integrationEnabled(feature: IntegrationFeature, env: IntegrationEnv = process.env): boolean {
  const definition: { keys: readonly string[]; flag?: string; value?: string } = INTEGRATIONS_AVAILABLE[feature];
  return definition.keys.every((key) => Boolean(env[key]?.trim())) &&
    (!definition.flag || env[definition.flag] === definition.value);
}

export function integrationsAvailable(env: IntegrationEnv = process.env): IntegrationAvailability {
  return Object.fromEntries(Object.keys(INTEGRATIONS_AVAILABLE).map((key) => {
    const feature = key as IntegrationFeature;
    return [feature, integrationEnabled(feature, env)];
  })) as IntegrationAvailability;
}

export function integrationNeeds(feature: IntegrationFeature): string {
  const definition: { keys: readonly string[]; flag?: string; value?: string } = INTEGRATIONS_AVAILABLE[feature];
  return `Needs ${[...definition.keys, ...(definition.flag ? [`${definition.flag}=${definition.value}`] : [])].join(" and ")}`;
}

export const ACTION_INTEGRATIONS: Readonly<Record<string, IntegrationFeature | readonly IntegrationFeature[]>> = {
  "kernel.researchAccount": ["chatgpt", "openrouter"],
  "kernel.researchPeople": ["chatgpt", "openrouter"],
  "kernel.firstTouches": "chatgpt",
  "kernel.firstTouch": "chatgpt",
  "kernel.draftStep": "chatgpt",
  "kernel.redraftStep": "chatgpt",
  "kernel.checkNow": "chatgpt",
  "kernel.sendEmail": "unipile",
  "kernel.saveGmailDraft": "unipile",
  "kernel.queueLinkedin": "unipile",
  "kernel.findEmail": "treg",
  "kernel.findPhone": "treg",
  "kernel.callContact": "dialer",
  "kernel.checkSignals": "treg",
  "kernel.toggleSignals": "treg",
};

export function moduleRuntimeAvailable(manifest: { server?: string }, env: IntegrationEnv = process.env): boolean {
  return !manifest.server || integrationEnabled("recipeRuntime", env);
}
