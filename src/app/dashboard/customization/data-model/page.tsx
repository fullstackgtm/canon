"use client";

import { DataModelTab } from "../data-model-editor";
import { RecipesSubpage } from "../workspace-page";

export default function DataModelPage() {
  return (
    <RecipesSubpage title="Data model" description="Each object's standard and custom fields, and the workspace's own objects. Admins add, rename, hide and archive fields and objects.">
      <DataModelTab />
    </RecipesSubpage>
  );
}
