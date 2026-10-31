// Minimal Prometheus text-format metrics (no dependency).

class Counter {
  private values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Record<string, string> = {}, by = 1) {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k} ${v}`);
    return lines.join("\n");
  }
}

class Gauge {
  private value = 0;
  readonly name: string;
  readonly help: string;
  private fn?: () => number;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  set(v: number) {
    this.value = v;
  }
  render() {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${this.fn ? this.fn() : this.value}`].join("\n");
  }
  bind(fn: () => number) {
    this.fn = fn;
  }
}

class Histogram {
  private series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  readonly name: string;
  readonly help: string;
  readonly bounds: number[];
  constructor(name: string, help: string, bounds: number[]) {
    this.name = name;
    this.help = help;
    this.bounds = bounds;
  }
  observe(v: number, labels: Record<string, string> = {}) {
    const k = labelKey(labels);
    let s = this.series.get(k);
    if (!s) this.series.set(k, (s = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 }));
    this.bounds.forEach((b, i) => {
      if (v <= b) s.buckets[i]++;
    });
    s.sum += v;
    s.count++;
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const inner = k ? k.slice(1, -1) + "," : "";
      this.bounds.forEach((b, i) => lines.push(`${this.name}_bucket{${inner}le="${b}"} ${s.buckets[i]}`));
      lines.push(`${this.name}_bucket{${inner}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k} ${s.sum}`, `${this.name}_count${k} ${s.count}`);
    }
    return lines.join("\n");
  }
}

function labelKey(labels: Record<string, string>) {
  const e = Object.entries(labels);
  return e.length ? `{${e.map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`).join(",")}}` : "";
}

const MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

export const metrics = {
  requests: new Counter("record_service_requests_total", "HTTP requests by route and status"),
  latencyMs: new Histogram("record_service_request_ms", "Server-side request latency in ms", MS),
  queueWaitMs: new Histogram("record_service_write_queue_wait_ms", "Time a write waited for the single writer", MS),
  groupSize: new Histogram("record_service_write_group_size", "Writes committed per group transaction", [1, 2, 4, 8, 16, 32, 64, 128]),
  queueDepth: new Gauge("record_service_write_queue_depth", "Writes waiting in the most recently touched workspace queue"),
  openWorkspaces: new Gauge("record_service_open_workspaces", "Workspace files currently open"),
  evictions: new Counter("record_service_workspace_evictions_total", "Workspaces closed by the LRU"),
  checkpoints: new Counter("record_service_checkpoints_total", "CHECKPOINTs run"),
  backups: new Counter("record_service_backups_total", "Workspace backups by result"),
  projectorCatchUpMs: new Histogram("record_service_projector_catchup_ms", "One projector catch-up of a workspace, from start to last page applied", MS),
  projectorTailMs: new Histogram("record_service_projector_tail_ms", "One GET /ledger/tail round trip to Convex", MS),
  projectorApplyMs: new Histogram("record_service_projector_apply_ms", "Folding and committing one tail page", MS),
  projectorEntries: new Counter("record_service_projector_entries_total", "Ledger entries the projector applied"),
};

export function renderMetrics() {
  return Object.values(metrics).map((m) => m.render()).join("\n") + "\n";
}
