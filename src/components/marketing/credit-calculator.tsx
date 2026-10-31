"use client";

import { useState } from "react";

export type Pack = { price: number; credits: number };
export type Rate = { label: string; credits: number };

const STEPS = [2_500, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000, 50_000, 75_000, 100_000];

/** The cheapest mix of packs that gives at least `need` credits. */
export function cheapestPacks(packs: readonly Pack[], need: number): { price: number; credits: number; counts: number[] } {
  const [small, mid, big] = packs;
  let best = { price: Infinity, credits: 0, counts: [0, 0, 0] };
  for (let c = 0; c <= Math.ceil(need / big.credits); c++) {
    for (let b = 0; b <= 1; b++) {
      const left = need - c * big.credits - b * mid.credits;
      const a = Math.max(0, Math.ceil(left / small.credits));
      const price = a * small.price + b * mid.price + c * big.price;
      const credits = a * small.credits + b * mid.credits + c * big.credits;
      if (price < best.price || (price === best.price && credits > best.credits)) best = { price, credits, counts: [a, b, c] };
    }
  }
  return best;
}

const num = (n: number) => Math.floor(n).toLocaleString("en-US");
const bonus = (p: Pack, base: Pack) => Math.round((p.credits / p.price / (base.credits / base.price) - 1) * 100);
const cents = (usd: number) => (usd < 0.1 ? `${(usd * 100).toFixed(1)}¢` : `$${usd.toFixed(2)}`);

export function CreditCalculator({ packs, rates }: { packs: readonly Pack[]; rates: readonly Rate[] }) {
  const [step, setStep] = useState(3);
  const need = STEPS[step];
  const mix = cheapestPacks(packs, need);
  const perCredit = mix.price / mix.credits;
  const label = mix.counts
    .map((n, i) => (n ? `${n > 1 ? `${n} × ` : ""}$${packs[i].price}` : null))
    .filter(Boolean)
    .join(" + ");

  return (
    <div className="credit-calc">
      <div>
        <ul className="credit-calc-tiers">
          {packs.map((p) => (
            <li key={p.price}>
              <strong>${p.price}</strong>
              <span>{num(p.credits)} credits</span>
              <em>{bonus(p, packs[0]) ? `${bonus(p, packs[0])}% bonus` : "Per-use rate"}</em>
            </li>
          ))}
        </ul>
        <label className="credit-calc-volume">
          <span>
            Credits you need <strong>{num(need)}</strong>
          </span>
          <input
            type="range"
            min={0}
            max={STEPS.length - 1}
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
            aria-valuetext={`${num(need)} credits`}
          />
        </label>
      </div>

      <div className="credit-calc-result" aria-live="polite">
        <p className="credit-calc-total">${num(mix.price)}</p>
        <p className="credit-calc-sub">
          {label} gets you {num(mix.credits)} credits
          {mix.counts[1] || mix.counts[2] ? `, ${num(mix.credits - mix.price * (packs[0].credits / packs[0].price))} of them bonus.` : "."}
        </p>
        <table className="credit-calc-packs">
          <thead>
            <tr>
              <th scope="col">Spent on</th>
              <th scope="col">You get up to</th>
              <th scope="col">Each</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{num(mix.credits / r.credits)}</td>
                <td>{cents(r.credits * perCredit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
