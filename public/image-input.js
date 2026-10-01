export function imageDimensions(width, height, maximum = 2048) {
  if (!(width > 0 && height > 0)) throw new Error('画像サイズを読み取れません。');
  const scale = Math.min(1, maximum / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function validateImageFile(file) {
  if (!file || !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name) && !/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) throw new Error('JPEG・PNG・WebP・HEIC/HEIFの写真を選んでください。');
  if (file.size <= 0 || file.size > 30 * 1024 * 1024) throw new Error('画像は30MB以下の空でないファイルを選んでください。');
}

export async function prepareImage(file) {
  validateImageFile(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    try { await image.decode(); } catch { throw new Error('このブラウザーでは画像を読み込めません。HEIC/HEIFの場合はJPEGへ変換して選び直してください。'); }
    const { width, height } = imageDimensions(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像変換を利用できません。');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > 9_000_000) throw new Error('画像が大きすぎます。小さい写真を選んでください。');
    return { dataUrl, width, height, name: file.name };
  } finally { URL.revokeObjectURL(url); }
}
