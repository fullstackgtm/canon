"""Render synthetic record-page references with WeasyPrint and pdftoppm."""
from pathlib import Path
from string import Template
import subprocess
from tempfile import TemporaryDirectory

THEMES = {
    "lightning-style-opportunity": {
        "css": "background:#eaf2fb;--accent:#0176d3;--band:#e5f1ff;--border:#cfdaea;--pad:13px;--radius:4px",
        "workspace": "Revenue workspace", "kind": "Opportunity", "title": "Northstar expansion",
        "company": "Northstar Workshop", "code": "OPP-024", "state": "Proposal",
        "stages": ["Qualify", "Discovery", "Proposal", "Negotiation", "Closed"],
        "fields": ["Amount", "$48,000", "Close date", "Oct 18", "Owner", "Avery Hill", "Lead source", "Referral"],
        "note": "Confirmed the rollout timeline.", "links": "Contacts (3)　　Opportunities (2)　　Notes (1)",
    },
    "hub-style-deal": {
        "css": "background:#f4f6fa;--accent:#b44724;--band:#fff1e9;--border:transparent;--pad:20px;--radius:9px;--shadow:0 3px 6px #252a3530",
        "workspace": "Sales workspace", "kind": "Deal", "title": "Juniper onboarding",
        "company": "Juniper Paper Co.", "code": "DL-086", "state": "Review",
        "stages": ["New", "Qualified", "Review", "Contract", "Won"],
        "fields": ["Deal value", "$16,500", "Target date", "Nov 12", "Deal owner", "Taylor Birch", "Source", "Inbound"],
        "note": "Shared the onboarding checklist.", "links": "Companies (1)　　Contacts (2)　　Notes (4)",
    },
    "attio-style-record": {
        "css": "background:#fff;--accent:#287358;--band:#fff;--border:transparent;--pad:20px;--radius:6px;--divider:#e7e9e8",
        "workspace": "Studio workspace", "kind": "Record", "title": "Orchard Fieldworks",
        "company": "Orchard Studio", "code": "REC-013", "state": "Active",
        "stages": ["Added", "Exploring", "Active", "Renewing", "Archived"],
        "fields": ["Relationship", "Partner", "Next review", "Dec 5", "Owner", "Morgan Lake", "Region", "West"],
        "note": "Added the partner brief.", "links": "People (2)　　Projects (3)　　Notes (2)",
    },
    "linear-style-issue": {
        "css": "background:#f6f6f9;--accent:#6957b6;--band:#fff;--border:#dedde6;--pad:13px;--radius:7px",
        "workspace": "Product workspace", "kind": "Issue", "title": "Refine export filters",
        "company": "Data Tools", "code": "DT-142", "state": "In progress",
        "stages": ["Backlog", "Ready", "In progress", "In review", "Done"],
        "fields": ["Priority", "Medium", "Due", "Oct 24", "Assignee", "Casey Reed", "Label", "Export"],
        "note": "Recorded the supported filter types.", "links": "Sub-issues (2)　　Links (3)　　Notes (1)",
    },
}

HTML = """<!doctype html><html lang="en"><meta charset="utf-8"><title>$title</title>
<style>
@page { size: 1120px 800px; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; color: #202633; font: 14px sans-serif; }
nav { padding: 13px 32px; background: #fff; border-bottom: 1px solid #e2e5ec; color: #505a69; }
nav strong { color: #202633; margin-right: 26px; }
main { padding: 22px 32px; }
.card { background: #fff; border: 1px solid var(--border); border-radius: var(--radius);
        padding: var(--pad); margin-bottom: 10px; box-shadow: var(--shadow, none); }
header { background: var(--band) !important; }
h1 { font-size: 25px; margin: 5px 0; }
h2 { font-size: 15px; margin: 0 0 12px; }
small, dt, .muted { color: #535e70; }
.actions { display: flex; align-items: center; gap: 8px; }
.actions span { border: 1px solid #e0e4eb; border-radius: 5px; padding: 5px 12px; font-weight: 600; }
.actions span:first-child { background: var(--accent); border-color: var(--accent); color: #fff; }
.path { display: flex; gap: 4px; }
.path span { flex: 1; background: #eef0f4; border-radius: 4px; text-align: center; padding: 7px 0; }
.path strong { display: block; flex: 1; background: var(--accent); color: #fff;
               border-radius: 4px; text-align: center; padding: 7px 0; }
.links { color: var(--accent); font-weight: 600; }
.columns { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; }
.tabs { border-bottom: 1px solid #e1e4eb; padding-bottom: 9px; margin-bottom: 12px; color: #535e70; }
.tabs strong { color: var(--accent); border-bottom: 2px solid var(--accent); padding: 0 6px 9px; margin-right: 20px; }
dl { display: grid; grid-template-columns: 1fr 1fr; margin: 0; }
dl div { padding: 8px 0; border-bottom: 1px solid var(--divider, #ebedf2); }
dd { margin: 3px 0 0; font-weight: 600; }
.latest { margin: 14px 0 0; padding: 9px 11px; background: #f3f5f8; border-radius: 5px; }
.person { color: var(--accent); font-weight: 600; }
.row { border-top: 1px solid #ebedf2; padding: 8px 0; }
</style>
<body style="$css">
<nav><strong>$workspace</strong> Records　/　$kind　/　$code</nav>
<main>
  <header class="card"><small>$kind · $code</small><h1>$title</h1><small>$company　·　$state</small></header>
  <div class="card actions"><span>Edit</span><span>Add note</span><span>Archive</span></div>
  <div class="card path">$path</div>
  <div class="card links">$links</div>
  <div class="columns">
    <article class="card">
      <div class="tabs"><strong>Details</strong> Activity (1)</div>
      <h2>$kind information</h2>
      <dl>$facts</dl>
      <p class="latest"><strong>Latest activity</strong>　<span class="muted">$note</span></p>
    </article>
    <aside>
      <section class="card"><h2>Parent record</h2><div class="person">$company</div><small>Primary relationship</small></section>
      <section class="card"><h2>Related records</h2><div class="row">Follow-up review</div><div class="row">Planning brief</div></section>
    </aside>
  </div>
</main></body></html>
"""

if __name__ == "__main__":
    destination = Path(__file__).resolve().parent
    with TemporaryDirectory() as folder:
        html_file = Path(folder) / "record.html"
        pdf_file = html_file.with_suffix(".pdf")
        for name, theme in THEMES.items():
            path = "".join(f"<strong>{stage}</strong>" if stage == theme["state"]
                           else f"<span>{stage}</span>" for stage in theme["stages"])
            fields = theme["fields"]
            facts = "".join(f"<div><dt>{key}</dt><dd>{value}</dd></div>"
                            for key, value in zip(fields[::2], fields[1::2]))
            html_file.write_text(Template(HTML).substitute(theme, path=path, facts=facts), encoding="utf8")
            subprocess.run(["weasyprint", str(html_file), str(pdf_file)], check=True)
            prefix = Path(folder) / name
            subprocess.run(["pdftoppm", "-r", "96", "-png", str(pdf_file), str(prefix)], check=True)
            pages = list(prefix.parent.glob(f"{prefix.name}-*.png"))
            if len(pages) != 1:
                raise RuntimeError(f"{name} rendered as {len(pages)} pages")
            (destination / f"{name}.png").write_bytes(pages[0].read_bytes())
