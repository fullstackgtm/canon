import assert from "node:assert/strict";
import test from "node:test";
import { MAX_REFERENCE_IMAGE_BYTES, referenceImageError } from "../recipes/imageReferences.ts";
import { referenceImageDimensions } from "../src/components/customize/reference-image-file.ts";

const image = "data:image/png;base64,iVBORw0KGgo=";

test("reference images accept up to three supported base64 data URLs", () => {
  assert.equal(referenceImageError([]), null);
  assert.equal(referenceImageError([image, "data:image/jpeg;base64,/9j/", "data:image/webp;base64,UklGRg=="]), null);
  assert.equal(referenceImageError(["data:image/gif;base64,R0lGODlh"]), null);
  assert.match(referenceImageError([image, image, image, image]) ?? "", /up to 3/);
  assert.match(referenceImageError(["data:image/svg+xml;base64,AAAA"]) ?? "", /PNG, JPEG, WebP or GIF/);
  assert.match(referenceImageError(["https://example.com/image.png"]) ?? "", /PNG, JPEG, WebP or GIF/);
  for (const payload of ["", "AAAA\n", "A===", "AA-=", "AAA=AAAA"]) {
    assert.match(referenceImageError([`data:image/png;base64,${payload}`]) ?? "", /invalid base64/);
  }
});

test("reference image limit applies to decoded bytes", () => {
  const imageOfSize = (size: number) => `data:image/png;base64,${Buffer.alloc(size).toString("base64")}`;
  assert.equal(referenceImageError([imageOfSize(MAX_REFERENCE_IMAGE_BYTES)]), null);
  assert.match(referenceImageError([imageOfSize(MAX_REFERENCE_IMAGE_BYTES + 1)]) ?? "", /750 KB/);
});

test("image preparation scales the long edge without upscaling or rounding an edge to zero", () => {
  assert.deepEqual(referenceImageDimensions(3200, 1800), { width: 1600, height: 900 });
  assert.deepEqual(referenceImageDimensions(1200, 2400), { width: 800, height: 1600 });
  assert.deepEqual(referenceImageDimensions(900, 600), { width: 900, height: 600 });
  assert.deepEqual(referenceImageDimensions(1, 4000), { width: 1, height: 1600 });
});
