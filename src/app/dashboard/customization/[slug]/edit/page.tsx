"use client";

import { useParams } from "next/navigation";
import { workspaceId } from "../../../../../../recipes/workspace";
import { RecipeEditor } from "../../recipe-editor";

export default function EditRecipePage() {
  const { slug } = useParams<{ slug: string }>();
  return <RecipeEditor recipeId={workspaceId(decodeURIComponent(slug))} />;
}
