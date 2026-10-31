"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

type GtmFindArgs = Record<string, unknown>;

export type GtmReadinessRow = {
  noun: string;
  required: boolean;
  relevant: boolean;
  configured: boolean;
  lifecycle: string;
  signals: Record<string, unknown>;
  nextActions: string[];
};

export type GtmReadinessSummary = {
  total: number;
  required: number;
  relevant: number;
  configured: number;
  missingRequired: number;
};

export type GtmReadiness = {
  nouns: Record<string, GtmReadinessRow>;
  summary: GtmReadinessSummary;
  required: string[];
  relevant: string[];
  missing: string[];
  missingRequired: string[];
};

export function useGtmFind<T = unknown>(resource: string, args: GtmFindArgs = {}) {
  return useQuery(api.gtm.find, { resource, args }) as T | undefined;
}

export function useGtmReadiness(nouns?: string[]) {
  return useGtmFind<GtmReadiness>("readiness", nouns ? { nouns } : {});
}
