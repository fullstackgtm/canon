/**
 * FSGTM's own draft checks (docs/deal-prep-loop.md): the two that are Jen Abel's rather than plain writing. The
 * stage, keeper, prep and fan-out run on Canon's built-ins, which recipe.md names in its ```logic blocks.
 */
import { defineRecipe } from "../sdk.ts";

type Settings = { magicWandPhrases: string; closesCallPhrases: string };

export default defineRecipe<Settings>((canon) => {
  canon.check("draft", ({ channel, body }, s) => {
    const wand = new RegExp(s.magicWandPhrases, "i").exec(body);
    return [
      { key: "wand", label: "No magic-wand questions", ok: !wand, note: wand ? `“${wand[0]}”` : undefined },
      ...(channel === "call" ? [{ key: "close", label: "Ends by booking the next call", ok: new RegExp(s.closesCallPhrases, "i").test(body) }] : []),
    ];
  });
});
