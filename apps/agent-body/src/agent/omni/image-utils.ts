/** Decodes one ephemeral JPEG data URL into RGBA pixels for the vision encoder. */
export interface ImagePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export async function dataUrlToPixels(dataUrl: string): Promise<ImagePixels> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This browser cannot decode images for the vision encoder (createImageBitmap is missing).');
  }
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser could not create a 2D canvas for the camera frame');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return { data: image.data, width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

/** Crops/scales pixels so both sides are multiples of the 32-pixel vision block. */
export function snapToVisionBlock(pixels: ImagePixels): ImagePixels {
  const block = 32;
  const width = Math.max(block, Math.floor(pixels.width / block) * block);
  const height = Math.max(block, Math.floor(pixels.height / block) * block);
  if (width === pixels.width && height === pixels.height) return pixels;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sourceStart = (row * pixels.width) * 4;
    data.set(pixels.data.subarray(sourceStart, sourceStart + width * 4), row * width * 4);
  }
  return { data, width, height };
}
