import assert from "node:assert/strict";
import { test } from "node:test";
import { formatQuery, parseQuery, queryToSpec, specToQuery } from "../convex/lib/icpQuery.ts";
import { DEPARTMENTS } from "../convex/lib/addRecords.ts";
import { INDUSTRIES } from "../services/record-service/src/industries.ts";
import { countIcpTree } from "../convex/lib/icpGates.ts";
import { treeRequest } from "../convex/lib/icpTree.ts";
import type { IcpSpec } from "../convex/lib/icpSpec.ts";
import { defaultModel } from "../recipes/index.ts";

const SPEC: IcpSpec = {
  market: { industries: ["software development", "it services and it consulting"], employeeBands: ["201-500", "501-1000"], countries: ["us", "gb"] },
  persona: { levels: ["vp", "head"], departments: ["Revenue operations"], titles: ["Chief Revenue Officer"], countries: [] },
  exclude: { industries: ["staffing and recruiting"], countries: [], titles: ["intern"] },
  custom: [{ slug: "business-model", values: ["saas"] }, { slug: "arr", min: 5 }],
};

test("an ICP's spec is its query line and back, unchanged", () => {
  const q = specToQuery(SPEC);
  assert.equal(q, 'industry:software-development,it-services-and-it-consulting size:201-500,501-1000 country:us,gb -industry:staffing-and-recruiting '
    + 'field.business-model:saas field.arr:5.. has(level:vp,head dept:revenue-operations title:"Chief Revenue Officer" -title:intern)');
  const { query, errors } = parseQuery(q, "icp");
  assert.deepEqual(errors, []);
  assert.deepEqual(queryToSpec(query), SPEC);
  assert.equal(formatQuery(query), q);
  // No buyer named: no has(…), and none comes back.
  assert.equal(specToQuery({ ...SPEC, persona: { levels: [], departments: [], titles: [], countries: [] }, exclude: { ...SPEC.exclude, titles: [] }, custom: undefined }),
    "industry:software-development,it-services-and-it-consulting size:201-500,501-1000 country:us,gb -industry:staffing-and-recruiting");
});

test("every canonical industry and department survives its query spelling", () => {
  for (const { key } of INDUSTRIES) {
    const { query, errors } = parseQuery(specToQuery({ ...SPEC, market: { ...SPEC.market, industries: [key] }, custom: undefined }), "icp");
    assert.deepEqual([errors, queryToSpec(query).market.industries], [[], [key]], key);
  }
  for (const d of DEPARTMENTS) assert.deepEqual(queryToSpec(parseQuery(`has(dept:${d.replace(/ /g, "-")})`, "icp").query).persona.departments, [d]);
  assert.deepEqual(parseQuery("has(dept:revops)", "icp").query.has[0].clauses, [{ key: "dept", neg: false, values: ["Revenue operations"] }]);
});

test("each kind of node takes only its own keys", () => {
  const errs = (text: string, kind: "icp" | "segment" | "persona") => parseQuery(text, kind).errors.length;
  assert.equal(errs("size:51-200 has(level:vp) -has(dept:sales)", "segment"), 0);
  assert.equal(errs("level:manager dept:revenue-operations -title:intern", "persona"), 0);
  for (const [text, kind] of [
    ["level:vp", "icp"], // a person key outside has(…)
    ["has(level:vp) has(dept:sales)", "icp"], // an ICP has one buyer
    ["-has(dept:sales)", "icp"],
    ["industry:banking", "persona"],
    ["has(level:vp)", "persona"],
    ["-size:51-200", "segment"],
    ["industry:not-an-industry", "segment"],
    ["size:51-200 size:201-500", "segment"],
    ["has(level:vp", "segment"],
  ] as const) assert.ok(errs(text, kind) > 0, `${kind}: ${text}`);
});

test("a tree counts as the record service counts it: segments narrow, personas count people, siblings overlap", () => {
  const accounts = [
    { id: "a", industry: "Software", country: "United States", employees: 300 },
    { id: "b", industry: "Software", country: "United States", employees: 300 },
    { id: "c", industry: "Banking", country: "United States", employees: 300 },
  ];
  const contacts = [
    { accountId: "a", title: "VP RevOps" }, { accountId: "a", title: "RevOps Manager" }, { accountId: "a", title: "Sales Manager" },
    { accountId: "b", title: "VP of Sales" }, { accountId: "c", title: "VP RevOps" },
  ];
  const spec: IcpSpec = { ...SPEC, market: { industries: ["software development"], employeeBands: [], countries: ["us"] }, exclude: { industries: [], countries: [], titles: [] }, custom: undefined, persona: { levels: ["vp"], departments: [], titles: [], countries: [] } };
  const nodes = treeRequest({
    fit: defaultModel("scoring.fit"),
    icps: [{ id: "icp", spec }],
    nodes: [
      { id: "managers", icpId: "icp", parentId: "leader", kind: "persona", query: "level:manager" },
      { id: "leader", icpId: "icp", kind: "segment", query: "has(level:vp dept:revenue-operations)" },
      { id: "no-revops", icpId: "icp", kind: "segment", query: "-has(dept:revenue-operations)" },
      { id: "broken", icpId: "icp", kind: "segment", query: "industry:gone" },
    ],
  });
  assert.deepEqual(nodes.map((n) => n.id), ["icp", "leader", "no-revops", "managers"], "parents first; a query that no longer parses is left out");
  assert.deepEqual(countIcpTree(accounts, contacts, nodes), {
    nodes: [{ id: "icp", accounts: 2, people: 0 }, { id: "leader", accounts: 1, people: 0 }, { id: "no-revops", accounts: 1, people: 0 }, { id: "managers", accounts: 1, people: 2 }],
    overlaps: [{ a: "leader", b: "no-revops", accounts: 0 }],
  });
});

test("query documents round-trip verbatim while exposing company and nested person filters", async () => {
  const { serializeQuery } = await import("../convex/lib/icpQuery.ts");
  const examples = [
    'industry:advertising-services,retail,online-audio-and-video-media size:501-1000,1001-5000,5001-10000,10001+ country:us,ca,gb has(level:cxo,vp,director,head,manager dept:marketing,media title:"VP Marketing","Head of Media",CMO)',
    '  country:US  size:201-500\n has(dept:revops level:VP title:"Chief Revenue Officer")  ',
    'industry:software-development field.arr:5.. -has(dept:sales -title:intern) has(level:head dept:marketing)',
    'size:51-200 has(level:senior dept:Creative-Services)',
  ];
  const golden = parseQuery(examples[0], "icp");
  assert.deepEqual(golden.errors, []);
  assert.deepEqual(golden.query, { clauses: [
    { key: "industry", neg: false, values: ["advertising services", "retail", "online audio and video media"] },
    { key: "size", neg: false, values: ["501-1000", "1001-5000", "5001-10000", "10001+"] },
    { key: "country", neg: false, values: ["us", "ca", "gb"] },
  ], has: [{ neg: false, clauses: [
    { key: "level", neg: false, values: ["cxo", "vp", "director", "head", "manager"] },
    { key: "dept", neg: false, values: ["Marketing", "media"] },
    { key: "title", neg: false, values: ["VP Marketing", "Head of Media", "CMO"] },
  ] }] });
  for (const line of examples) {
    const parsed = parseQuery(line, "segment");
    assert.deepEqual(parsed.errors, []);
    assert.equal(serializeQuery(parsed), line);
    assert.deepEqual(parseQuery(formatQuery(parsed.query), "segment").query, parsed.query);
  }
  const abbreviated = 'industry:advertising-services,retail,... size:501-1000,1001-5000,5001-10000,10001+ country:us,ca,gb,... has(level:cxo,vp,director,head,manager dept:marketing,media,... title:"VP Marketing","Head of Media",CMO,...)';
  assert.equal(serializeQuery(parseQuery(abbreviated, "icp")), abbreviated);
  const edited = parseQuery(examples[1], "icp");
  edited.query.clauses[0].values = ["ca"];
  assert.equal(serializeQuery(edited), 'country:ca size:201-500 has(dept:revenue-operations level:vp title:"Chief Revenue Officer")');
});
