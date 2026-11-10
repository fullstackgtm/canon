function dialable(raw) {
  const text = (raw ?? "").trim();
  if (!text) return false;
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) return digits.length >= 8 && digits.length <= 15;
  if (digits.length === 10) return true;
  if (digits.length === 11 && digits.startsWith("1")) return true;
  return digits.startsWith("00") && digits.length >= 10 && digits.length <= 17;
}
var calls = {
  person(_ctx, reads) {
    return { value: reads.person };
  },
  audienceList(_ctx, reads) {
    return { value: { audiences: reads.audiences } };
  },
  /** Freeze the audience now and make it the caller's queue; the `fill` job reads its people in. */
  load(ctx, reads) {
    const snap = reads.snapshot[0];
    if (!snap) throw new Error("Canon couldn't read that audience.");
    const audience = reads.audiences.find((a) => a.id === ctx.args.audience);
    const data = { source: "audience", audience: String(ctx.args.audience), audienceName: audience?.name ?? "Audience", snapshot: snap.id, audienceSnapshot: snap.id, count: snap.count };
    const queue = reads.queue;
    const expect = [{ collection: "queues", key: ctx.caller.userId, version: queue?.version ?? null }];
    const intents = [queue ? { op: "op", name: "queues.reload", key: queue.key, data, expect } : { op: "op", name: "queues.create", data, expect }];
    return { intents, value: { count: snap.count } };
  },
  loadCallTasks(ctx, reads) {
    const tasks = reads.tasks;
    if (!Array.isArray(tasks)) {
      const reasons = {
        not_installed: "Sequences is not installed.",
        off: "Sequences is turned off.",
        not_provided: "This version of Sequences does not provide call tasks. Upgrade Sequences to 0.6 or later."
      };
      return { value: { loaded: false, message: `${reasons[tasks.missing]} Your queue is unchanged.` } };
    }
    if (!tasks.length) return { value: { loaded: false, message: "No open call tasks are due through today UTC. Your queue is unchanged." } };
    const people = new Map(reads.people.map((p) => [p.id, p]));
    const grouped = /* @__PURE__ */ new Map();
    let withoutPhone = 0, unavailable = 0;
    for (const task of [...tasks].sort((a, b) => a.data.dueDay.localeCompare(b.data.dueDay))) {
      const person = people.get(task.data.contact);
      if (!person) {
        unavailable++;
        continue;
      }
      if (!dialable(person.phone)) {
        withoutPhone++;
        continue;
      }
      const item = grouped.get(person.id) ?? { person, tasks: [] };
      item.tasks.push({ key: task.key, sequence: task.data.sequence, dueDay: task.data.dueDay });
      grouped.set(person.id, item);
    }
    const duplicateTasks = tasks.length - unavailable - withoutPhone - grouped.size;
    const cutoffDay = new Date(ctx.now).toISOString().slice(0, 10);
    const summary = `${tasks.length} due tasks read, ${grouped.size} distinct people with a dialable phone, ${withoutPhone} tasks without a dialable phone, ${unavailable} tasks with unavailable people, ${duplicateTasks} repeated tasks for queued people. First 500 tasks only, due through ${cutoffDay} UTC.${tasks.length === 500 ? " More due tasks may exist." : ""}`;
    if (!grouped.size) return { value: { loaded: false, message: `${summary} Your queue is unchanged.` } };
    const rep = ctx.caller.userId;
    const queue = reads.queue;
    const items = reads.items;
    const prior = new Map(items.map((item) => [String(item.data.person), item]));
    const snapshot = `callTasks:${rep}:${ctx.now}:${queue?.version ?? 0}`;
    const intents = [{
      op: "put",
      collection: "queues",
      key: rep,
      expect: [{ collection: "queues", key: rep, version: queue?.version ?? null }, ...items.map((item) => ({ collection: "items", key: item.key, version: item.version }))],
      data: {
        rep,
        source: "sequences",
        audienceName: "Due call tasks",
        snapshot,
        count: tasks.length,
        loadedAt: ctx.now,
        queued: grouped.size,
        withoutPhone,
        unavailable,
        duplicateTasks,
        cutoffDay,
        summary
      }
    }];
    let position = 0;
    for (const [personId, { person, tasks: sourceTasks }] of grouped) {
      const item = prior.get(personId);
      const key = `${rep}|${personId}`;
      intents.push({
        op: "put",
        collection: "items",
        key,
        expect: [{ collection: "items", key, version: item?.version ?? null }],
        data: { rep, person: personId, name: person.name || "Unnamed", phone: String(person.phone), queue: snapshot, position: ++position, source: "sequences", sourceTasks }
      });
      if (item && item.data.state !== "queued") intents.push({ op: "transition", machine: "item", name: "reload", key });
    }
    for (const item of items) if (!grouped.has(String(item.data.person))) intents.push({ op: "delete", collection: "items", key: item.key });
    return { intents, value: { loaded: true, count: grouped.size, message: `${summary} Queue replaced.` } };
  },
  /**
   * The queue's people, in the audience's order: those with a number Canon can dial, the first 500. A person queued
   * before keeps their place in the new queue as someone to call; people of an earlier queue are dropped.
   */
  fillQueue(ctx, reads) {
    const key = String(ctx.args.rep);
    const queue = reads.queue;
    if (!queue || !queue.data.audienceSnapshot || queue.data.source === "sequences") return { byKey: { [key]: [] } };
    const people = reads.people;
    const callable = people.filter((p) => dialable(p.phone));
    const snapshot = String(queue.data.snapshot);
    const intents = callable.map((p, position) => ({
      op: "put",
      collection: "items",
      key: `${key}|${p.id}`,
      data: { rep: key, person: p.id, name: p.name || "Unnamed", phone: String(p.phone), queue: snapshot, position: position + 1 }
    }));
    const kept = new Set(callable.map((p) => p.id));
    for (const item of reads.items) {
      if (!kept.has(String(item.data.person))) intents.push({ op: "delete", collection: "items", key: item.key });
      else if (item.data.state !== "queued") intents.push({ op: "transition", machine: "item", name: "requeue", key: item.key });
    }
    intents.push({
      op: "patch",
      collection: "queues",
      key: queue.key,
      expect: [{ collection: "queues", key: queue.key, version: queue.version }],
      data: { queued: callable.length, withoutPhone: people.length - callable.length }
    });
    return { byKey: { [key]: intents } };
  },
  /** A call Canon logged with a person: the rep who made it no longer has them to call. */
  onCalls(ctx) {
    const keys = /* @__PURE__ */ new Set();
    for (const change of ctx.args.changes) {
      const after = change.after;
      if (!after || after.kind !== "call" || change.before || typeof after.ownerId !== "string") continue;
      for (const person of /* @__PURE__ */ new Set([...change.targets?.people ?? [], ...typeof after.personId === "string" ? [after.personId] : []])) keys.add(`${after.ownerId}|${person}`);
    }
    return { intents: [...keys].map((key) => ({ op: "dirty", job: "mark", key })) };
  },
  markCalled(ctx, reads) {
    const key = `${String(ctx.args.rep)}|${String(ctx.args.person)}`;
    const [item] = reads.item;
    if (!item || item.data.state !== "queued") return { byKey: { [key]: [] } };
    return { byKey: { [key]: [{ op: "transition", machine: "item", name: "called", key: item.key }] } };
  }
};
export {
  calls,
  dialable
};
