export const JPEG_PREFIX = 'data:image/jpeg;base64,';
const MAX_JPEG_LENGTH = 125_000;
const MAX_ADJACENT_GAP_MS = 350;
const COLORS = ['#ffdc61', '#64e5ff', '#fd97d6', '#a3ff89'];

function canvas(width, height) {
  const surface = document.createElement('canvas');
  surface.width = width;
  surface.height = height;
  return surface;
}

function encodeJpeg(surface) {
  for (;;) {
    const image = surface.toDataURL('image/jpeg', .8).slice(JPEG_PREFIX.length);
    if (image.length <= MAX_JPEG_LENGTH) return image;
    const smaller = canvas(Math.max(1, Math.floor(surface.width * .75)), Math.max(1, Math.floor(surface.height * .75)));
    smaller.getContext('2d').drawImage(surface, 0, 0, smaller.width, smaller.height);
    surface = smaller;
  }
}

function overlap([x, y, w, h], [u, v, a, b]) {
  const intersection = Math.max(0, Math.min(x + w, u + a) - Math.max(x, u))
    * Math.max(0, Math.min(y + h, v + b) - Math.max(y, v));
  return intersection / (w * h + a * b - intersection);
}

function matchFaces(a, b) {
  if (a.length !== b.length || a.some(face => face.score < .65) || b.some(face => face.score < .65)) return;
  const scores = a.map(face => b.map(other => overlap(face.box, other.box)));
  const matches = scores.map(row => row.findIndex(score => score >= .55));
  if (matches.some((match, i) => match < 0
    || scores[i].some((score, j) => j !== match && score > .22)
    || scores.some((row, j) => j !== i && row[match] > .22))) return;
  return matches;
}

function similarPixels(images, boxes, tolerance) {
  const width = 24, height = 14;
  const drawing = canvas(width, height).getContext('2d', { willReadFrequently: true });
  const samples = images.map((image, i) => {
    const [x, y, w, h] = boxes?.[i] || [0, 0, 1, 1];
    drawing.drawImage(image, x * image.width, y * image.height, w * image.width, h * image.height, 0, 0, width, height);
    return drawing.getImageData(0, 0, width, height).data;
  });
  return [[0, 1], [1, 2], [0, 2]].every(([a, b]) => {
    const from = samples[a], to = samples[b];
    let changed = 0;
    for (let i = 0; i < from.length; i += 4) {
      if (Math.abs(from[i] - to[i]) > 45 || Math.abs(from[i + 1] - to[i + 1]) > 45 || Math.abs(from[i + 2] - to[i + 2]) > 45) changed++;
    }
    return changed < width * height * tolerance;
  });
}

function timestamp(timeMs) {
  return `${(timeMs / 1000).toFixed(3)} s`;
}

function drawFullFrame(source, frame, hasTracks) {
  const width = Math.min(source.width, 960);
  const height = Math.max(1, Math.round(source.height * width / source.width));
  const surface = canvas(width, height + 24);
  const drawing = surface.getContext('2d');
  drawing.fillStyle = '#16202a';
  drawing.fillRect(0, 0, width, surface.height);
  drawing.drawImage(source, 0, 0, width, height);
  drawing.font = 'bold 15px sans-serif';
  drawing.textBaseline = 'top';
  drawing.lineWidth = 2;
  for (const [i, { box: [x, y, w, h] }] of frame.faces.entries()) {
    const color = COLORS[i % COLORS.length];
    const label = `${hasTracks ? 'T' : 'F'}${i + 1}`;
    const left = x * width, top = y * height;
    drawing.strokeStyle = color;
    drawing.strokeRect(left, top, w * width, h * height);
    drawing.fillStyle = color;
    const labelWidth = drawing.measureText(label).width + 8;
    const labelLeft = Math.min(left, Math.max(0, width - labelWidth));
    const labelTop = Math.max(0, top - 19);
    drawing.fillRect(labelLeft, labelTop, labelWidth, 19);
    drawing.fillStyle = '#16202a';
    drawing.fillText(label, labelLeft + 4, labelTop + 2);
  }
  drawing.fillStyle = '#fff';
  drawing.fillText(timestamp(frame.timeMs), 6, height + 4);
  return encodeJpeg(surface);
}

function drawTrackSheet(images, frames, tracks) {
  const tile = 172, labelWidth = 40, header = 25;
  const surface = canvas(labelWidth + images.length * tile, header + tracks.length * tile);
  const drawing = surface.getContext('2d');
  drawing.fillStyle = '#16202a';
  drawing.fillRect(0, 0, surface.width, surface.height);
  drawing.font = 'bold 15px sans-serif';
  drawing.textBaseline = 'middle';
  drawing.textAlign = 'center';
  drawing.fillStyle = '#fff';
  frames.forEach((frame, i) => drawing.fillText(timestamp(frame.timeMs), labelWidth + (i + .5) * tile, header / 2));
  for (const [i, boxes] of tracks.entries()) {
    drawing.fillStyle = COLORS[i];
    drawing.fillText(`T${i + 1}`, labelWidth / 2, header + (i + .5) * tile);
    // 同一轨迹使用相同的裁剪窗口，不把框的移动伪装成脸部变化。
    const left = Math.min(...boxes.map(([x, , w]) => x - w * .35));
    const top = Math.min(...boxes.map(([, y, , h]) => y - h * .35));
    const right = Math.max(...boxes.map(([x, , w]) => x + w * 1.35));
    const bottom = Math.max(...boxes.map(([, y, , h]) => y + h * 1.35));
    images.forEach((image, j) => {
      const x = Math.max(0, left) * image.width, y = Math.max(0, top) * image.height;
      const w = Math.min(1, right) * image.width - x, h = Math.min(1, bottom) * image.height - y;
      const scale = (tile - 8) / Math.max(w, h);
      drawing.drawImage(image, x, y, w, h,
        labelWidth + (j + .5) * tile - w * scale / 2, header + (i + .5) * tile - h * scale / 2, w * scale, h * scale);
    });
  }
  return encodeJpeg(surface);
}

export const emptyEvidence = () => ({ images: [], tracks: [], times: [], status: 'no_frames' });

export async function buildFaceEvidence(frames, decode, signal) {
  if (!frames.length) return { evidence: emptyEvidence() };
  const midpoint = (frames[0].timeMs + frames.at(-1).timeMs) / 2;
  const center = frames.reduce((best, frame, i) => Math.abs(frame.timeMs - midpoint) < Math.abs(frames[best].timeMs - midpoint) ? i : best, 0);
  const primary = frames[center];
  const source = await decode(primary.dataUrl);
  signal?.throwIfAborted();
  const pair = [frames[center - 1], frames[center + 1]];
  let sheet, adjacent;
  if (primary.faces.length && primary.faces.length <= COLORS.length
    && pair.every(frame => frame && Math.abs(primary.timeMs - frame.timeMs) <= MAX_ADJACENT_GAP_MS)) {
    const [before, after] = pair.map(frame => matchFaces(primary.faces, frame.faces));
    if (before && after && before.every((face, i) => overlap(pair[0].faces[face].box, pair[1].faces[after[i]].box) >= .45)) {
      const images = [await decode(pair[0].dataUrl), source, await decode(pair[1].dataUrl)];
      signal?.throwIfAborted();
      const boxes = primary.faces.map((face, i) => [pair[0].faces[before[i]].box, face.box, pair[1].faces[after[i]].box]);
      // 框的位置一致不足以证明连续；再比较画面布局和框内的外观。
      if (similarPixels(images, null, .14) && boxes.every(track => similarPixels(images, track, .24))) {
        adjacent = [pair[0], primary, pair[1]];
        sheet = drawTrackSheet(images, adjacent, boxes);
      }
    }
  }
  let sourceImage = primary.faces.length ? primary.dataUrl.slice(JPEG_PREFIX.length) : undefined;
  if (sourceImage?.length > MAX_JPEG_LENGTH) {
    const surface = canvas(source.width, source.height);
    surface.getContext('2d').drawImage(source, 0, 0);
    sourceImage = encodeJpeg(surface);
  }
  return {
    primary,
    sourceImage,
    evidence: {
      images: [drawFullFrame(source, primary, Boolean(sheet)), ...(sheet ? [sheet] : [])],
      tracks: sheet ? primary.faces.map((_, faceIndex) => ({ label: `T${faceIndex + 1}`, timeMs: primary.timeMs, faceIndex })) : [],
      times: (adjacent || [primary]).map(frame => frame.timeMs),
      status: sheet ? 'stable_tracks' : 'full_frame_only'
    }
  };
}
