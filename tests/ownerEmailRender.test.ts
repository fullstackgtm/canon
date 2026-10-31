import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ReactElement, ReactNode } from "react";
import type { OutboxRowView } from "../src/components/modules/module-outbox.tsx";

const require = createRequire(import.meta.url);
const states: unknown[] = [], calls: unknown[] = [];
let cursor = 0;
const source = readFileSync("src/components/modules/module-outbox.tsx", "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
const exports: { OutboxTable?: (props: { rows: OutboxRowView[]; actions: string[] }) => ReactNode } = {};
runInNewContext(outputText, { exports, require: (id: string) => {
  if (id === "react") return { useState: (initial: unknown) => {
    const index = cursor++; if (!(index in states)) states[index] = initial;
    return [states[index], (value: unknown) => { states[index] = value; }];
  } };
  if (id === "react/jsx-runtime") return require(id);
  if (id === "convex/react") return { useMutation: () => async (args: unknown) => { calls.push(args); } };
  if (id.endsWith("convex/_generated/api")) return { api: { outbound: { act: {} } } };
  if (id === "@/components/ui/dialog") return Object.fromEntries(["Dialog", "DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogTitle"].map((key) => [key, key]));
  if (id === "@/hooks/use-outbound-available") return {};
  if (id === "@/lib/utils") return { cn: (...args: string[]) => args.join(" "), getErrorMessage: String };
  if (id === "@/lib/toast") return { toast: { success() {}, error() {} } };
  throw new Error(`Unexpected consent dialog dependency ${id}`);
} });
function elements(value: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(elements);
  const element = value as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props?.children as ReactNode)];
}
const render = (rows: OutboxRowView[]) => { cursor = 0; return elements(exports.OutboxTable!({ rows, actions: ["approve", "cancel"] })); };
const button = (tree: ReturnType<typeof render>, label: string) => {
  const found = tree.find((e) => e.type === "button" && e.props.children === label);
  assert.ok(found, `Missing ${label} action`); return found.props.onClick as () => Promise<void> | void;
};

test("exact approval dialog retains the displayed full message and its CAS hash across live row updates", async () => {
  states.length = 0; calls.length = 0;
  const row = { id: "outbox", at: 0, module: "drafts", channel: "email", kind: "personal", to: "person@example.test", subject: "Frozen subject",
    text: "Full authored message\nEvery line\nFrozen footer", state: "awaiting_approval", actions: { approve: true, cancel: true, sendNow: false },
    ownerReview: { bindingHash: "displayed-binding", purpose: "manual_action", senderName: "Owner", senderAddress: "owner@example.test", recipientAddress: "person@example.test" } } as OutboxRowView;
  button(render([row]), "Review exact email")();
  const changed = { ...row, subject: "New subject", text: "New text", ownerReview: { ...row.ownerReview!, bindingHash: "new-binding" } };
  const tree = render([changed]);
  assert.equal(tree.some((e) => e.type === "dd" && e.props.children === "Frozen subject"), true);
  assert.equal(tree.some((e) => e.type === "pre" && e.props.children === "Full authored message\nEvery line\nFrozen footer"), true);
  const dialog = tree.find((e) => e.type === "Dialog"); assert.equal(dialog?.props.open, true);
  await button(tree, "Send personally")();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ id: "outbox", action: "approve", expectedBindingHash: "displayed-binding" }]);
});

test("automated confirmation stays explicit, other-owner rows offer no confirmation, and legacy approval remains", async () => {
  states.length = 0; calls.length = 0;
  const base = { id: "outbox", at: 0, channel: "email", kind: "automated", to: "to@example.test", text: "Full automated email\nPostal footer", subject: "Automation", state: "awaiting_approval",
    actions: { approve: true, cancel: true, sendNow: false }, ownerReview: { bindingHash: "automated-binding", purpose: "automated_outreach", senderName: "Owner", senderAddress: "owner@example.test", recipientAddress: "to@example.test" } } as OutboxRowView;
  button(render([base]), "Review exact email")(); await button(render([base]), "Approve automated email")();
  assert.equal((calls[0] as { expectedBindingHash: string }).expectedBindingHash, "automated-binding");
  states.length = 0;
  assert.equal(render([{ ...base, actions: { approve: false, cancel: true, sendNow: false } }]).some((e) => e.type === "button" && e.props.children === "Review exact email"), false);
  await button(render([{ ...base, ownerReview: null }]), "Approve")();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { id: "outbox", action: "approve" });
});
