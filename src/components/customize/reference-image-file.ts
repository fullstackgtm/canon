import { MAX_REFERENCE_IMAGE_BYTES, REFERENCE_IMAGE_SIZE_ERROR, REFERENCE_IMAGE_TYPE_ERROR, REFERENCE_IMAGE_TYPES } from "../../../recipes/imageReferences.ts";

export function referenceImageDimensions(width: number, height: number) {
  const scale = Math.min(1, 1600 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function prepareReferenceImage(file: File): Promise<string> {
  if (!REFERENCE_IMAGE_TYPES.some((type) => type === file.type)) throw new Error(REFERENCE_IMAGE_TYPE_ERROR);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error("This image could not be opened.");
    }
    const { width, height } = referenceImageDimensions(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser could not prepare the image.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    for (const quality of [0.88, 0.72, 0.55, 0.38]) {
      const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (encoded && encoded.size <= MAX_REFERENCE_IMAGE_BYTES) {
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("This image could not be read."));
          reader.readAsDataURL(encoded);
        });
      }
    }
    throw new Error(REFERENCE_IMAGE_SIZE_ERROR);
  } finally {
    URL.revokeObjectURL(url);
  }
}
