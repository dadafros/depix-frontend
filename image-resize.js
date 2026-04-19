/* global FileReader */
// Client-side image resize using Canvas API
// Square center crop + WebP/JPEG encoding — zero dependencies

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Resize an image file to a square of maxSize × maxSize pixels.
 * Center-crops non-square images, encodes as WebP (JPEG fallback).
 *
 * @param {File} file - Image file from <input type="file">
 * @param {number} maxSize - Target dimension in pixels (e.g. 360)
 * @returns {Promise<Blob>} Resized image blob
 */
export function resizeImage(file, maxSize) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      return reject(new Error("Arquivo deve ser uma imagem (JPG, PNG ou WebP)."));
    }
    if (file.size > MAX_FILE_SIZE) {
      return reject(new Error("Imagem deve ter no máximo 10MB."));
    }

    const reader = new FileReader();

    reader.onload = () => {
      const img = new Image();

      img.onload = () => {
        // Square center crop
        const cropSize = Math.min(img.width, img.height);
        const sx = (img.width - cropSize) / 2;
        const sy = (img.height - cropSize) / 2;

        const canvas = document.createElement("canvas");
        canvas.width = maxSize;
        canvas.height = maxSize;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, cropSize, cropSize, 0, 0, maxSize, maxSize);

        // Try WebP first, fallback to JPEG
        canvas.toBlob(
          (blob) => {
            if (blob) return resolve(blob);
            // WebP not supported — fallback to JPEG
            canvas.toBlob(
              (jpegBlob) => {
                if (jpegBlob) return resolve(jpegBlob);
                reject(new Error("Falha ao processar imagem."));
              },
              "image/jpeg",
              0.85
            );
          },
          "image/webp",
          0.8
        );
      };

      img.onerror = () => {
        reject(new Error("Não foi possível carregar a imagem. Verifique o arquivo."));
      };

      img.src = reader.result;
    };

    reader.onerror = () => {
      reject(new Error("Falha ao ler arquivo."));
    };

    reader.readAsDataURL(file);
  });
}
