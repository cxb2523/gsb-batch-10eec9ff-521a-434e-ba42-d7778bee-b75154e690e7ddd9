import { settings } from "./state.js";
import { updateRange } from "./listeners.js";

export const drawGrid = (canvas, ctx, isExport = false) => {
  if (isExport) return;

  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 3);
  ctx.lineTo(canvas.width, canvas.height / 3);
  ctx.moveTo(0, (canvas.height / 3) * 2);
  ctx.lineTo(canvas.width, (canvas.height / 3) * 2);
  ctx.moveTo(canvas.width / 3, 0);
  ctx.lineTo(canvas.width / 3, canvas.height);
  ctx.moveTo((canvas.width / 3) * 2, 0);
  ctx.lineTo((canvas.width / 3) * 2, canvas.height);

  // Grey border (outer stroke)
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#757575";
  ctx.stroke();

  // White line (inner stroke)
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  ctx.restore();
};

export const drawCheckPattern = (canvas, ctx, isExport = false) => {
  if (isExport) return;

  const size = canvas.width / 40;
  ctx.fillStyle = "#bdbdbd";

  for (let i = 0; i < 40; ++i) {
    for (let j = 0, col = 40 / 2; j < col; ++j) {
      ctx.rect(2 * j * size + (i % 2 ? 0 : size), i * size, size, size);
    }
  }

  ctx.fill();
};

export const updateSliderStates = () => {
  const eleX = document.querySelector(".form input#image-x");
  const eleY = document.querySelector(".form input#image-y");
  const eleZ = document.querySelector(".form input#image-z");
  const img = settings.image.img;

  if (!img) {
    if (eleX) eleX.disabled = true;
    if (eleY) eleY.disabled = true;
    if (eleZ) eleZ.disabled = true;
    return;
  }

  if (eleZ) eleZ.disabled = false;

  const z = parseFloat(settings.z) || 1;
  const shape = settings.shape;

  let canvasW, canvasH, renderW, renderH;

  if (shape === "original") {
    canvasW = img.width;
    canvasH = img.height;
    renderW = img.width * z;
    renderH = img.height * z;
  } else {
    const size = Math.min(img.width, img.height);
    canvasW = size;
    canvasH = size;
    const ratio = Math.max(size / img.width, size / img.height);
    renderW = img.width * ratio * z;
    renderH = img.height * ratio * z;
  }

  const canScrollX = renderW - canvasW > 0.5;
  const canScrollY = renderH - canvasH > 0.5;

  if (eleX) {
    if (!canScrollX) {
      if (!eleX.disabled) {
        eleX.disabled = true;
        updateRange("x", 0, 1);
      }
    } else {
      eleX.disabled = false;
    }
  }

  if (eleY) {
    if (!canScrollY) {
      if (!eleY.disabled) {
        eleY.disabled = true;
        updateRange("y", 0, 1);
      }
    } else {
      eleY.disabled = false;
    }
  }
};

export const isDrawable = (image) =>
  Boolean(
    image &&
      typeof image === "object" &&
      image.complete &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0,
  );

const getCanvasSize = (image, shape) => {
  if (!image) return { width: 1920, height: 1920 };

  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;

  if (shape === "original") {
    return { width: imageWidth, height: imageHeight };
  }

  const size = Math.min(imageWidth, imageHeight);
  return { width: size, height: size };
};

const syncShapeAttribute = (shape) => {
  const container = document.querySelector(".canvas");
  if (!container) return;
  if (shape === "circle" || shape === "material") {
    container.dataset.shape = shape;
  } else {
    delete container.dataset.shape;
  }
};

/**
 * Draws the badge into any canvas.
 *
 * This is a pure render: it never reads or writes preview-only state. The
 * caller decides whether guides (grid, transparency checkerboard) belong in
 * the output. Preview draws pass `isExport: false`; downloaded files pass
 * `isExport: true`, which renders to a throwaway canvas so the preview canvas
 * and the user's settings are never mutated by an export.
 */
export const renderBadge = (
  canvas,
  {
    image = null,
    banner = null,
    material = null,
    x = 0,
    y = 0,
    z = 1,
    shape = "original",
    grid = "none",
  } = {},
  { isExport = false } = {},
) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const { width, height } = getCanvasSize(image, shape);
  // Assigning width/height also resets the context, clearing previous pixels.
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const offsetX = Number(x) || 0;
  const offsetY = Number(y) || 0;
  const zoom = Number(z) || 1;

  if (image) {
    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;

    switch (shape) {
      case "original": {
        ctx.save();
        ctx.translate(
          (((canvas.width - imageWidth * zoom) / 2) * offsetX) / 100,
          (((canvas.height - imageHeight * zoom) / 2) * offsetY) / 100,
        );
        ctx.transform(
          zoom,
          0,
          0,
          zoom,
          (-(zoom - 1) * canvas.width) / 2,
          (-(zoom - 1) * canvas.height) / 2,
        );
        drawCheckPattern(canvas, ctx, isExport);
        ctx.drawImage(image, 0, 0);
        ctx.restore();
        break;
      }
      default: {
        const hRatio = canvas.width / imageWidth;
        const vRatio = canvas.height / imageHeight;
        const ratio = Math.max(hRatio, vRatio);
        const canvasX = (canvas.width - imageWidth * ratio) / 2;
        const canvasY = (canvas.height - imageHeight * ratio) / 2;
        ctx.save();
        ctx.translate(
          (((canvas.width - imageWidth * zoom) / 2) * offsetX) / 100,
          (((canvas.height - imageHeight * zoom) / 2) * offsetY) / 100,
        );
        ctx.transform(
          zoom,
          0,
          0,
          zoom,
          (-(zoom - 1) * canvas.width) / 2,
          (-(zoom - 1) * canvas.height) / 2,
        );
        drawCheckPattern(canvas, ctx, isExport);
        ctx.drawImage(
          image,
          0,
          0,
          imageWidth,
          imageHeight,
          canvasX,
          canvasY,
          imageWidth * ratio,
          imageHeight * ratio,
        );
        ctx.restore();
        break;
      }
    }
  } else {
    // No image yet: keep the transparent 1920x1920 preview stage. In export
    // mode the checkerboard is omitted, yielding a valid transparent badge.
    drawCheckPattern(canvas, ctx, isExport);
  }

  // Draw "Banner". This is part of the finished badge, so it is drawn in both
  // preview and export mode, but only when the asset is actually decodable.
  if (isDrawable(banner)) {
    const bannerHeight =
      ((banner.naturalHeight || banner.height) /
        (banner.naturalWidth || banner.width)) *
      canvas.width;
    const bannerY = canvas.height - bannerHeight;
    ctx.drawImage(
      banner,
      0,
      0,
      banner.naturalWidth || banner.width,
      banner.naturalHeight || banner.height,
      0,
      bannerY,
      canvas.width,
      bannerHeight,
    );
  }

  // Draw grid (guides only, never part of an exported badge)
  if (grid === "grid") drawGrid(canvas, ctx, isExport);

  // Apply the user-selected shape mask. Masking is part of the finished badge.
  switch (shape) {
    case "circle": {
      ctx.globalCompositeOperation = "destination-in";
      ctx.beginPath();
      ctx.arc(
        canvas.width / 2,
        canvas.height / 2,
        canvas.height / 2,
        0,
        Math.PI * 2,
      );
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "material": {
      if (isDrawable(material)) {
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(material, 0, 0, canvas.width, canvas.height);
      }
      break;
    }
    default:
      break;
  }

  return canvas;
};

export const draw = () => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return;

  const { image: imageObj, banner, material, x, y, z, shape, grid } = settings;

  renderBadge(canvas, {
    image: imageObj && isDrawable(imageObj.img) ? imageObj.img : null,
    banner,
    material,
    x,
    y,
    z,
    shape,
    grid,
  });

  syncShapeAttribute(shape);
  updateSliderStates();
};

export const loadBanner = async (category = "gdev") => {
  settings.banner = new Image();
  settings.banner.src = (await import(`../images/${category}.webp`)).default;
  settings.banner.onload = async () => {
    await document.fonts.ready;
    draw();
  };
};

export const loadMaterial = async () => {
  const input = document.querySelector("input#shape-material");
  if (input) input.disabled = false;
  settings.material = new Image();
  settings.material.src = (await import("../images/m3.svg")).default;
  settings.material.onload = async () => {
    draw();
  };
};

export const checkMaterialFlag = () => {
  const params = new URLSearchParams(location.search);
  const material = params.get("material");
  if (material === "true") loadMaterial();
};
