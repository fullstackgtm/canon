/**
 * Write docs/openapi.json, the record API's OpenAPI document for the standard
 * objects (src/app/api/v1/_openapi.ts). tests/openapiSpec.test.ts fails while
 * the file is stale.
 *
 * It refuses to write a document that breaks a stable operation of the one it
 * replaces: a stable operation, a schema or one of its properties removed, a
 * property newly required, or an enum value removed. A breaking change belongs
 * under a new API version; `--allow-breaking` writes it anyway.
 *
 *   node --experimental-strip-types scripts/build-openapi.ts                   write the document
 *   node --experimental-strip-types scripts/build-openapi.ts --check           exit 1 if it is stale
 *   node --experimental-strip-types scripts/build-openapi.ts --allow-breaking  write it despite a breaking change
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi, standardObjects, type OpenApiDocument } from "../src/app/api/v1/_openapi.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_FILE = join(ROOT, "docs/openapi.json");

export const expectedSpec = (): string => `${JSON.stringify(buildOpenApi(standardObjects(), { server: "{origin}/api/v1" }), null, 2)}\n`;

type Node = Record<string, unknown>;
const isNode = (x: unknown): x is Node => typeof x === "object" && x !== null && !Array.isArray(x);

/** What `next` breaks of `prev`'s stable operations and the schemas they use, as readable lines. */
export function breakingChanges(prev: OpenApiDocument, next: OpenApiDocument): string[] {
  const out: string[] = [];
  for (const [path, methods] of Object.entries(prev.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op["x-stability"] === "stable" && !next.paths[path]?.[method]) out.push(`${method.toUpperCase()} ${path} was removed`);
    }
  }
  const compare = (where: string, a: unknown, b: unknown) => {
    if (!isNode(a)) return;
    if (!isNode(b)) return out.push(`${where} was removed`);
    for (const value of (Array.isArray(a.enum) ? a.enum : [])) if (!(Array.isArray(b.enum) ? b.enum : []).includes(value)) out.push(`${where} no longer takes ${JSON.stringify(value)}`);
    const required = new Set(Array.isArray(a.required) ? a.required : []);
    for (const name of Array.isArray(b.required) ? b.required : []) if (!required.has(name)) out.push(`${where}.${name} is newly required`);
    if (isNode(a.properties)) for (const [name, s] of Object.entries(a.properties)) compare(`${where}.${name}`, s, isNode(b.properties) ? b.properties[name] : undefined);
    if (isNode(a.items)) compare(`${where}[]`, a.items, b.items);
  };
  for (const [name, schema] of Object.entries(prev.components.schemas)) compare(name, schema, next.components.schemas[name]);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const expected = expectedSpec();
  const current = existsSync(SPEC_FILE) ? readFileSync(SPEC_FILE, "utf8") : null;
  if (process.argv.includes("--check")) {
    if (current !== expected) {
      console.error("docs/openapi.json is stale. Run: node --experimental-strip-types scripts/build-openapi.ts");
      process.exit(1);
    }
  } else {
    const broken = current ? breakingChanges(JSON.parse(current), JSON.parse(expected)) : [];
    if (broken.length && !process.argv.includes("--allow-breaking")) {
      console.error(`The record API would break for existing callers:\n  ${broken.join("\n  ")}\nKeep the old shape, or pass --allow-breaking with the owner's agreement and a new API version.`);
      process.exit(1);
    }
    writeFileSync(SPEC_FILE, expected);
    console.log(`wrote docs/openapi.json (${Object.keys(JSON.parse(expected).paths).length} paths)`);
  }
}
