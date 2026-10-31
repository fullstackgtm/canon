function icps(value) {
  if (!Array.isArray(value)) throw new Error("ICPs are unavailable. Try again when their interface is available.");
  return value;
}
var calls = {
  icps(_ctx, reads) {
    return { value: { icps: icps(reads.icps).filter((d) => d.data.active === true).map((d) => ({ key: d.key, name: d.data.name })) } };
  },
  fromIcp(ctx, reads) {
    const selected = icps(reads.icps).find((d) => d.key === ctx.args.icp);
    if (!selected) throw new Error("That ICP is not available in this workspace.");
    if (selected.data.active !== true) throw new Error(`Switch ${selected.data.name} on before creating its audience.`);
    return {
      intents: [{ op: "op", name: "audiences.create", data: {
        name: `${String(selected.data.name).slice(0, 71)}: people`,
        filter: [{ field: "accountIcpIds", op: "hasAny", value: [selected.key] }]
      } }],
      value: "Audience created"
    };
  },
  count(ctx, reads) {
    const [counted] = reads.count;
    const customVariables = counted?.customVariables ?? [];
    return { value: { count: counted?.count ?? 0, withEmail: counted?.withEmail ?? 0, customVariables, customVariablesLabel: customVariables.join(", ") || "None", computedAt: counted?.computedAt ?? ctx.now } };
  }
};
export {
  calls
};
