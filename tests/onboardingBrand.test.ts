import assert from "node:assert/strict";
import test from "node:test";
import { discoverBrand } from "../convex/lib/onboardingBrand.ts";

test("brand discovery reuses homepage assets and isolates customer logos", async () => {
  const brand = await discoverBrand(
    {
      finalUrl: "https://acme.example/",
      text: `
    <meta name="theme-color" content="#197650"><meta property="og:image" content="/social.png">
    <link rel="apple-touch-icon" href="/touch.png">
    <header><img alt="Acme logo" src="/logo.svg"></header>
    <img alt="Unrelated" src="/hero.png">
    <section class="trusted-by"><img alt="Stripe logo" src="https://cdn.example/stripe.svg"><img alt="Bad" src="javascript:alert(1)"></section>`,
    },
    async () => {
      throw new Error("No extra request needed");
    },
  );
  assert.deepEqual(brand, {
    logoUrl: "https://acme.example/logo.svg",
    color: "#197650",
    sourceUrl: "https://acme.example/",
    customers: [{ name: "Stripe", logoUrl: "https://cdn.example/stripe.svg" }],
  });
});

test("brand discovery falls back through icon, manifest and social image without paid calls", async () => {
  for (const [html, expected] of [
    [
      '<link rel="apple-touch-icon" href="/touch.png">',
      "https://acme.example/touch.png",
    ],
    [
      '<link rel="manifest" href="/app.webmanifest">',
      "https://acme.example/icon.png",
    ],
    [
      '<meta property="og:image" content="/social.png">',
      "https://acme.example/social.png",
    ],
    ['<meta name="theme-color" content="url(evil)">', undefined],
  ] as const) {
    const brand = await discoverBrand(
      { finalUrl: "https://acme.example/", text: html },
      async (url) => {
        assert.equal(url, "https://acme.example/app.webmanifest");
        return {
          finalUrl: url,
          text: JSON.stringify({ icons: [{ src: "/icon.png" }] }),
        };
      },
    );
    assert.equal(brand.logoUrl, expected);
    assert.equal(brand.color, undefined);
    assert.deepEqual(brand.customers, []);
  }
});

test("customer logo walls retain nested logos, lazy sources and a bounded preview", async () => {
  const logos = Array.from(
    { length: 15 },
    (_, i) =>
      `<div><img alt="Buyer ${i} logo" data-src="/buyer-${i}.svg"></div>`,
  ).join("");
  const brand = await discoverBrand(
    {
      finalUrl: "https://acme.example/",
      text: `<div class="customer-logos"><div><img alt="customer" src="/generic.png"></div>${logos}</div>`,
    },
    async () => null,
  );
  assert.equal(brand.customers.length, 12);
  assert.deepEqual(brand.customers[11], {
    name: "Buyer 11",
    logoUrl: "https://acme.example/buyer-11.svg",
  });
  const fallback = await discoverBrand(
    {
      finalUrl: "https://acme.example/",
      text: '<link rel="manifest" href="/bad.webmanifest"><meta property="og:image" content="/social.png">',
    },
    async () => ({
      finalUrl: "https://acme.example/bad.webmanifest",
      text: "invalid",
    }),
  );
  assert.equal(fallback.logoUrl, "https://acme.example/social.png");
});
