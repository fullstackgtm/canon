// SQL for building the prospect index. Kept separate so tests can run the same
// statements against a small fixture.

// PDL size bands -> employee range. "10001+" has no upper bound.
export const SIZE_BANDS: Record<string, [number, number | null]> = {
  "1-10": [1, 10],
  "11-50": [11, 50],
  "51-200": [51, 200],
  "201-500": [201, 500],
  "501-1000": [501, 1000],
  "1001-5000": [1001, 5000],
  "5001-10000": [5001, 10000],
  "10001+": [10001, null],
};

const bandCase = (col: string, i: 0 | 1) =>
  `CASE ${col} ${Object.entries(SIZE_BANDS)
    .map(([band, range]) => `WHEN '${band}' THEN ${range[i] ?? "NULL"}`)
    .join(" ")} ELSE NULL END`;

// Company-name words that never identify a company on their own.
const STOPWORDS = [
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh", "sa", "sas", "srl",
  "bv", "ab", "ag", "plc", "pty", "the", "and", "of", "group", "holdings", "services", "solutions",
  "consulting", "international", "global", "partners", "technologies", "technology",
];

export function BUILD_SQL(source: string): Array<[string, string]> {
  return [
    ["normalize", `
      CREATE OR REPLACE TEMP TABLE staged AS
      WITH raw AS (
        SELECT * FROM ${source}
      ), cleaned AS (
        SELECT
          id AS pdlId,
          name,
          -- website -> bare hostname: drop scheme, www., path, port; lowercase.
          nullif(regexp_replace(regexp_replace(lower(trim(website)), '^(https?://)?(www\\.)?', ''), '[/:?#].*$', ''), '') AS domain,
          industry,
          size AS sizeBand,
          ${bandCase("size", 0)} AS employeeMin,
          ${bandCase("size", 1)} AS employeeMax,
          founded,
          country, region, locality,
          linkedin_url AS linkedinUrl
        FROM raw
      )
      SELECT * FROM cleaned
      -- Accounts in the CRM are keyed by domain, so rows without a usable one are dropped.
      WHERE domain IS NOT NULL AND regexp_matches(domain, '^[a-z0-9-]+(\\.[a-z0-9-]+)+$')`],
    ["domain confidence", `
      -- Flag websites that don't look like the company's own (the free dataset
      -- has rows like "calanar" -> shawatiinteriors.com). 'high' when a
      -- distinctive name word (3+ chars) or the name's initials appear in the
      -- domain's first label; otherwise 'low'. Low rows stay searchable but are
      -- ranked below high ones and labelled in the UI.
      CREATE OR REPLACE TEMP TABLE scored AS
      WITH words AS (
        SELECT pdlId, domain,
          split_part(domain, '.', 1) AS label,
          list_filter(
            string_split(regexp_replace(lower(name), '[^a-z0-9 ]', ' ', 'g'), ' '),
            w -> length(w) >= 3 AND NOT list_contains(${JSON.stringify(STOPWORDS).replace(/"/g, "'")}, w)
          ) AS tokens,
          string_split(regexp_replace(lower(name), '[^a-z0-9 ]', ' ', 'g'), ' ') AS allWords
        FROM staged
      )
      SELECT s.*,
        CASE
          WHEN len(list_filter(w.tokens, t -> contains(w.label, t))) > 0 THEN 'high'
          WHEN length(w.label) >= 2 AND w.label = array_to_string(list_transform(list_filter(w.allWords, x -> length(x) > 0), x -> x[1]), '') THEN 'high'
          ELSE 'low'
        END AS domainConfidence
      FROM staged s JOIN words w USING (pdlId)`],
    ["dedupe by domain", `
      -- One row per domain: prefer high confidence, then a LinkedIn URL, then
      -- the larger company, then the older founding year.
      CREATE OR REPLACE TABLE companies AS
      SELECT * EXCLUDE (rn), count(*) OVER (PARTITION BY domain) AS sourceRows
      FROM (
        SELECT *, row_number() OVER (
          PARTITION BY domain
          ORDER BY (domainConfidence = 'high') DESC, (linkedinUrl IS NOT NULL) DESC,
                   employeeMin DESC NULLS LAST, founded ASC NULLS LAST, pdlId
        ) AS rn
        FROM scored
      )
      WHERE rn = 1
      -- Sort so the common ICP filters (country, industry, size) prune row groups.
      ORDER BY country, industry, employeeMin, domain`],
    ["indexes", `
      CREATE UNIQUE INDEX companies_domain ON companies(domain);
      CREATE INDEX companies_pdlId ON companies(pdlId)`],
    ["metadata", `
      CREATE OR REPLACE TABLE index_meta AS
      SELECT 'pdl-free-company-dataset' AS source,
             'CC BY 4.0 — attribution: "Company data from People Data Labs"' AS license,
             now() AS builtAt,
             (SELECT count(*) FROM companies) AS companies`],
  ];
}
