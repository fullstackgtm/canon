import { useCallback, useRef, useState } from "react";
import { MAX_REFERENCE_IMAGES } from "../../../recipes/imageReferences.ts";
import { prepareReferenceImage } from "./reference-image-file";

type ReferenceImage = { id: string; name: string; url: string };

export function useReferenceImages() {
  const [images, setImages] = useState<ReferenceImage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const activeBatch = useRef<symbol | null>(null);

  async function add(files: File[]) {
    if (!files.length || activeBatch.current) return;
    const available = MAX_REFERENCE_IMAGES - images.length;
    if (files.length > available) {
      setError(`Attach up to ${MAX_REFERENCE_IMAGES} images.`);
      return;
    }
    const batch = Symbol();
    activeBatch.current = batch;
    setPending(true);
    setError("");
    for (const file of files) {
      try {
        const image = { id: crypto.randomUUID(), name: file.name || "Pasted image", url: await prepareReferenceImage(file) };
        if (activeBatch.current !== batch) return;
        setImages((current) => [...current, image]);
      } catch (e) {
        if (activeBatch.current !== batch) return;
        setError(e instanceof Error ? e.message : "This image could not be attached.");
      }
    }
    activeBatch.current = null;
    setPending(false);
  }

  const clear = useCallback(() => {
    activeBatch.current = null;
    setPending(false);
    setImages([]);
    setError("");
  }, []);

  return {
    images, pending, error, add, clear,
    remove(id: string) {
      setImages((current) => current.filter((image) => image.id !== id));
      setError("");
    },
  };
}
