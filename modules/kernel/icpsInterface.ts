/** Frozen interface fields. A shape change requires a new interface version. */
export const ICPS_V1_FIELDS = ["name", "description", "spec", "query", "active", "isDefault", "source", "pointOfView", "offer"] as const;
export const ICP_NODES_V1_FIELDS = ["icp", "parent", "kind", "name", "query", "role", "pointOfView", "offer"] as const;
