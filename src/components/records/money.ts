"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { formatMoney, moneyDecimals } from "../../../modules/kernel/text";

/** How a workspace shows money: its currency code and decimal places (Settings, Workspace). */
export type Money = { currency: string; decimals: number };

export const DEFAULT_MONEY: Money = { currency: "USD", decimals: 2 };

/** The signed-in workspace's money settings; the default until they load. */
export function useWorkspaceMoney(): Money {
  const org = useQuery(api.organizations.current);
  return org ? { currency: org.defaultCurrency || "USD", decimals: moneyDecimals(org.currencyDecimals) } : DEFAULT_MONEY;
}

/** Cents as money: in `currency` when the record names its own (a deal's), else the workspace's. */
export const moneyText = (cents: number, money: Money, currency?: string | null): string => formatMoney(cents, currency || money.currency, money.decimals);
