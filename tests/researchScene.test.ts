import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildResearchScene,
  availableDraft,
  circleAnchor,
  layoutLabels,
  ringChips,
  sceneCamera,
  type SceneStep,
} from "../src/app/start/research-scene-model.ts";
import { layoutMap } from "../src/lib/icp-map.ts";
import type { ResearchSession } from "../src/app/start/research-content";

const session = {
  tamTotal: 120,
  segments: [
    { id: "seg-computer-software-smb", name: "Software teams", count: 12 },
    { id: "seg-retail-ent", name: "Retail · Enterprise", count: 5 },
  ],
  icp: { persona: { titleKeywords: ["Revenue Operations"] } },
  preview: [
    {
      name: "Example Account",
      domain: "account.example",
      industry: "computer software",
      employees: 100,
    },
  ],
  brief: {
    drafts: [
      {
        persona: "Revenue Operations",
        account: { name: "Example Account", domain: "account.example" },
      },
    ],
  },
} as ResearchSession;

test("the scene packs counted segments with the ICP map geometry, rings each with unmeasured buyer roles, and zooms in at every stage", () => {
  const scene = buildResearchScene(session);
  const expected = layoutMap(
    scene.nodes.map((n) =>
      n.kind === "icp" ? { ...n, kind: "segment" as const } : n,
    ),
    {
      nodes: session.segments!.map((s) => ({ id: s.id, accounts: s.count })),
      overlaps: [],
    },
  );
  assert.deepEqual(
    scene.circles.map(({ x, y, r }) => ({ x, y, r })),
    expected.circles.map(({ x, y, r }) => ({ x, y, r })),
  );
  assert.equal(scene.rings.length, 2);
  assert.equal(scene.target?.inPersona, true);
  assert.ok(
    Math.hypot(
      scene.target!.x - scene.focusRing!.x,
      scene.target!.y - scene.focusRing!.y,
    ) < scene.focusRing!.r,
  );
  const steps: SceneStep[] = [
    "market",
    "segment",
    "accounts",
    "persona",
    "outreach",
  ];
  const radii = steps.map((step) => sceneCamera(scene, step).r);
  assert.ok(
    radii.every((r, i) => !i || r < radii[i - 1]),
    radii.join(),
  );
  assert.deepEqual(
    sceneCamera(buildResearchScene(session), "persona"),
    sceneCamera(scene, "persona"),
  );
});

test("missing counts and unmatched outreach targets never create a guessed account or persona association", () => {
  const empty = buildResearchScene(undefined);
  assert.equal(empty.nodes[0].count, null);
  assert.deepEqual(empty.accounts, []);
  assert.equal(empty.target, undefined);
  const unmatched = buildResearchScene({
    ...session,
    brief: {
      drafts: [{ ...session.brief!.drafts[0], persona: "Unmatched role" }],
    },
  } as ResearchSession);
  assert.equal(unmatched.target?.inPersona, false);
  const zero = buildResearchScene({
    ...session,
    tamTotal: 0,
    segments: [],
    preview: [],
  });
  assert.equal(zero.nodes[0].count, 0);
  assert.ok(Number.isFinite(sceneCamera(zero, "outreach").r));
  assert.equal(availableDraft(2, 1), 0);
  assert.equal(availableDraft(2, 3), 2);
  assert.equal(availableDraft(NaN, 3), 0);
});

test("labels stack beside the map without overlapping, stay in the frame, and drop the lowest priority first", () => {
  const item = (id: string, y: number) => ({
    id,
    title: "Marketing and Advertising",
    detail: "Enterprise, 46 in the sample",
    anchor: { x: 100, y },
  });
  const placed = layoutLabels([item("a", 40), item("b", 42), item("c", 44)], {
    width: 160,
    height: 300,
  });
  for (let i = 1; i < placed.length; i++)
    assert.ok(placed[i].y >= placed[i - 1].y + placed[i - 1].height);
  assert.ok(
    placed.every((label) => label.y >= 0 && label.y + label.height <= 300),
  );
  const crowded = layoutLabels(
    [item("first", 10), item("second", 20), item("third", 30)],
    {
      width: 120,
      height: 150,
    },
  );
  assert.deepEqual(
    crowded.map((label) => label.id),
    ["first"],
  );
  const anchor = circleAnchor({ x: 290, y: 150, r: 200 }, 300);
  assert.ok(anchor.x > 0 && anchor.x < 300 && anchor.y > 0 && anchor.y < 300);
});

test("a zoomed segment fills with its sample: a dot per unnamed account clear of the ring, and logos that never overlap", () => {
  const scene = buildResearchScene({
    ...session,
    preview: [
      ...session.preview!,
      ...["b", "c", "d"].map((id, i) => ({
        name: `Account ${id}`,
        domain: `${id}.example`,
        industry: "computer software",
        employees: 100,
        fit: 0.5 + i * 0.2,
      })),
    ],
  } as ResearchSession);
  const ring = scene.focusRing!;
  const logos = scene.accounts.filter((a) => a.segment === scene.focus.id);
  assert.equal(logos.length, 4);
  assert.equal(scene.sample.length, 12 - logos.length);
  for (const dot of scene.sample)
    assert.ok(Math.hypot(dot.x - ring.x, dot.y - ring.y) > ring.r);
  for (const [i, a] of logos.entries()) {
    assert.ok(
      Math.hypot(a.x - scene.focus.x, a.y - scene.focus.y) + a.size <=
        scene.focus.r,
    );
    for (const b of logos.slice(i + 1))
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.size + b.size, a.name);
  }
  // Fit sizes the logo; an unscored account keeps the smallest size.
  const [low, high] = [logos[1], logos[3]];
  assert.ok(high.size > low.size);
});

test("buyer-role chips sit on the ring without overlapping, leave the connector clear, and fold the rest into +N", () => {
  const ring = { x: 260, y: 150, r: 120 };
  const node = { x: 235, y: 125, width: 50, height: 50 };
  const titles = [
    "VP Marketing",
    "Head of Media",
    "Director of Creative Strategy",
    "Head of Brand",
  ];
  const place = (box: { width: number; height: number }) => ({
    box,
    chips: ringChips(titles, ring, { box, avoid: [node], blocked: [-30, 30] }),
  });
  const roomy = place({ width: 520, height: 300 });
  assert.deepEqual(roomy.chips.map((c) => c.text).sort(), [...titles].sort());
  const tight = place({ width: 260, height: 220 });
  const more = tight.chips.at(-1)!;
  assert.match(more.text, /^\+\d$/);
  assert.equal(tight.chips.length - 1 + more.rest.length, titles.length);
  for (const { box, chips } of [roomy, tight])
    for (const [i, a] of chips.entries()) {
      assert.ok(
        a.x >= 0 &&
          a.y >= 0 &&
          a.x + a.width <= box.width &&
          a.y + a.height <= box.height,
      );
      for (const b of [...chips.slice(i + 1), node])
        assert.ok(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
        );
      // Nothing sits on the connector's exit to the right of the ring.
      assert.ok(
        !(
          a.x + a.width > ring.x + ring.r - 1 &&
          a.y < ring.y &&
          a.y + a.height > ring.y
        ),
      );
    }
});
