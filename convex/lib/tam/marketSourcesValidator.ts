import { v } from "convex/values";
export const sourceKind = v.union(v.literal("registry"), v.literal("directory"), v.literal("marketplace"), v.literal("award_list"), v.literal("license_board"), v.literal("association"));
export const sourceFactsFields = { key: v.string(), url: v.string(), title: v.string(), kind: sourceKind, listedCount: v.optional(v.number()), filterable: v.optional(v.boolean()), exportable: v.optional(v.boolean()), markets: v.array(v.string()) };
export const sourceMatch = v.object({ sourceKey: v.string(), seedDomain: v.string(), quote: v.string(), query: v.string() });
export const sourceSeed = v.object({ domain: v.string(), name: v.string() });
