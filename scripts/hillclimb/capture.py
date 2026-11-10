"""Capture one hill-climb round: screenshots plus the programmatic gates, against this worktree's own stack.

  ~/.cache/canoncrm-hillclimb/venv/bin/python -I scripts/hillclimb/capture.py <round> [surface ...]

Reads the app port from .devstack/ports.env, drives the installed Chrome (channel="chrome", so no browser
download), and writes .hillclimb/rounds/<round>/<surface>-<width>.png plus manifest.json. The gates run before any
model sees a screenshot: console errors, axe serious/critical violations, native <select> and uppercase mono labels
(docs/ui-style.md). Plan: docs/ui-hillclimb-plan.md.
"""
import asyncio, json, pathlib, sys
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
AXE = (ROOT / "node_modules/axe-core/axe.min.js").read_text()
WIDTHS = [1440, 1024]

# name, path, Twenty reference (manifest key) or None. A path of "detail:<list path>" opens that list's first record.
SURFACES = [
    ("accounts", "/dashboard/accounts", "companies-list"),
    ("deals", "/dashboard/deals", "opportunities-kanban"),
    ("account-detail", "detail:/dashboard/accounts", None),
    ("contacts", "/dashboard/contacts", "people-list"),
    ("home", "/dashboard", None),
    ("tasks", "/dashboard/tasks", "tasks-kanban-empty"),
    ("reports", "/dashboard/dashboards", "dashboards"),
    ("runs", "/dashboard/runs", "workflow-runs-empty"),
    ("agents", "/dashboard/agents", "workflows"),
    ("audiences", "/dashboard/audiences", "campaigns-empty"),
    ("integrations", "/dashboard/integrations", "settings-apps"),
    ("data-model", "/dashboard/customization/data-model", "settings-data-model"),
    ("settings", "/dashboard/settings", "settings-profile"),
    ("team", "/dashboard/settings/team", "settings-members"),
    ("billing", "/dashboard/settings/billing", "settings-billing"),
    ("canon-fields", "/dashboard/canon-fields", None),
    ("icps", "/dashboard/icps", None),
]

AXE_RUN = """async () => {
  const context = { exclude: [['label:has(> select[aria-label="Signed in as"])']] };
  const { violations } = await axe.run(context, { resultTypes: ['violations'] });
  return violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
}"""

LINT = """() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // The "Signed in as" select is the local stack's dev member switcher (Clerk's user button in production).
  const selects = [...document.querySelectorAll('select:not([aria-label="Signed in as"])')].filter(visible).length;
  const upperMono = [...document.querySelectorAll('body *')].filter((el) => {
    if (!visible(el) || !el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
    const s = getComputedStyle(el);
    return s.textTransform === 'uppercase' && /mono/i.test(s.fontFamily);
  }).length;
  return { nativeSelects: selects, uppercaseMonoLabels: upperMono };
}"""


def app_url():
    env = dict(l.split("=", 1) for l in (ROOT / ".devstack/ports.env").read_text().splitlines() if "=" in l)
    port = env.get("DEVSTACK_NEXT_PORT") or env.get("NEXT_PORT")
    if not port:
        sys.exit(f"no next port in .devstack/ports.env: {sorted(env)}")
    return f"http://localhost:{port}"


async def settle(page):
    await page.wait_for_load_state("domcontentloaded")
    for _ in range(60):  # Convex keeps a socket open, so wait for the loading text to clear instead of network idle
        busy = await page.evaluate("() => /\\bLoading\\b|Loading…/.test(document.body.innerText)")
        if not busy:
            break
        await page.wait_for_timeout(500)
    await page.add_style_tag(content="nextjs-portal { display: none !important; }")  # next dev's indicator, not app UI
    await page.wait_for_timeout(1500)


async def capture(browser, base, out, name, path, ref):
    shots, errors = [], []
    ctx = await browser.new_context(viewport={"width": WIDTHS[0], "height": 900}, device_scale_factor=1)
    page = await ctx.new_page()
    page.on("console", lambda m: errors.append(m.text[:300]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:300]))
    if path.startswith("detail:"):
        await page.goto(base + path[7:], timeout=120_000)
        await settle(page)
        prefix = path[7:] + "/"
        href = await page.evaluate("(p) => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).find(h => h.startsWith(p) && h.length > p.length)", prefix)
        if not href:
            await ctx.close()
            return {"surface": name, "error": f"no record link under {prefix}"}
        path = href
    await page.goto(base + path, timeout=120_000)
    await settle(page)
    for w in WIDTHS:
        await page.set_viewport_size({"width": w, "height": 900})
        await page.wait_for_timeout(600)
        f = out / f"{name}-{w}.png"
        await page.screenshot(path=str(f), full_page=False)
        shots.append(f.name)
    await page.set_viewport_size({"width": WIDTHS[0], "height": 900})
    await page.add_script_tag(content=AXE)
    axe = await page.evaluate(AXE_RUN)
    lint = await page.evaluate(LINT)
    await ctx.close()
    serious = [v for v in axe if v["impact"] in ("serious", "critical")]
    return {"surface": name, "path": path, "ref": ref, "shots": shots, "consoleErrors": errors,
            "axeSerious": sum(v["nodes"] for v in serious), "axe": axe, **lint}


async def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    rnd, only = sys.argv[1], set(sys.argv[2:])
    out = ROOT / ".hillclimb/rounds" / rnd
    out.mkdir(parents=True, exist_ok=True)
    base = app_url()
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True)
        results = []
        for name, path, ref in SURFACES:
            if only and name not in only:
                continue
            r = await capture(browser, base, out, name, path, ref)
            print(json.dumps({k: r.get(k) for k in ("surface", "path", "axeSerious", "nativeSelects", "uppercaseMonoLabels", "error")} | {"consoleErrors": len(r.get("consoleErrors", []))}))
            results.append(r)
        await browser.close()
    (out / "manifest.json").write_text(json.dumps({"round": rnd, "base": base, "surfaces": results}, indent=2))


asyncio.run(main())
