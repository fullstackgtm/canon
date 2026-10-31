"use client";

import { PipelinesTab } from "../pipelines-editor";
import { RecipesSubpage } from "../workspace-page";

export default function PipelinesPage() {
  return (
    <RecipesSubpage title="Pipelines" description="The stages a deal moves through, in order, with each stage's forecast category.">
      <PipelinesTab />
    </RecipesSubpage>
  );
}
