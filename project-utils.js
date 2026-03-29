(function () {
  'use strict';

  const PROJECT_KEY = 'rpgstudio_project';
  const SPRITE_TAGS = new Set(['tile', 'character', 'bg', 'fg', 'ui', 'item', 'effect']);
  const CHARACTER_TYPES = new Set(['player', 'npc', 'enemy']);
  const MAP_LAYER_NAMES = ['Background', 'Midground', 'Foreground', 'Collision'];
  const MAP_TRIGGER_TYPES = new Set(['transition', 'dialog', 'message']);
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function asInt(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.round(num) : fallback;
  }

  function clampInt(value, min, max, fallback) {
    return Math.max(min, Math.min(max, asInt(value, fallback)));
  }

  function normalizeName(value, fallback) {
    const text = String(value ?? '').trim();
    return text || fallback;
  }

  function normalizeColor(value) {
    return typeof value === 'string' && COLOR_RE.test(value) ? value.toLowerCase() : null;
  }

  function normalizeFolderPath(value) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/\\/g, '/')
      .split('/')
      .map(part => part.trim())
      .filter(Boolean)
      .join('/');
  }

  function slugifyName(value, fallback = 'asset') {
    const base = String(value ?? '')
      .trim()
      .replace(/\.[a-z0-9]+$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return base || fallback;
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b]
      .map(channel => channel.toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToRgb(hex) {
    const normalized = normalizeColor(hex);
    if (!normalized) return null;
    return {
      r: parseInt(normalized.slice(1, 3), 16),
      g: parseInt(normalized.slice(3, 5), 16),
      b: parseInt(normalized.slice(5, 7), 16),
    };
  }

  function colorDistance(a, b) {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return dr * dr + dg * dg + db * db;
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('No image file selected.'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read "${file.name || 'image'}".`));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error(`Could not decode "${file.name || 'image'}".`));
        image.onload = () => resolve(image);
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function drawImageToCanvas(image, width, height, options = {}) {
    const fit = options.fit === 'fill' || options.fit === 'stretch' ? options.fit : 'fit';
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = options.imageSmoothing !== false;

    if (fit === 'stretch') {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    const srcW = Math.max(1, image.naturalWidth || image.width || canvas.width);
    const srcH = Math.max(1, image.naturalHeight || image.height || canvas.height);
    if (fit === 'fill') {
      const scale = Math.max(canvas.width / srcW, canvas.height / srcH);
      const cropW = canvas.width / scale;
      const cropH = canvas.height / scale;
      const sx = Math.max(0, (srcW - cropW) / 2);
      const sy = Math.max(0, (srcH - cropH) / 2);
      ctx.drawImage(image, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    const scale = Math.min(canvas.width / srcW, canvas.height / srcH);
    const drawW = Math.max(1, Math.round(srcW * scale));
    const drawH = Math.max(1, Math.round(srcH * scale));
    const dx = Math.floor((canvas.width - drawW) / 2);
    const dy = Math.floor((canvas.height - drawH) / 2);
    ctx.drawImage(image, dx, dy, drawW, drawH);
    return canvas;
  }

  function cornerPalette(imageData) {
    const { data, width, height } = imageData;
    const points = [
      [0, 0],
      [Math.max(0, width - 1), 0],
      [0, Math.max(0, height - 1)],
      [Math.max(0, width - 1), Math.max(0, height - 1)],
    ];
    return points.map(([x, y]) => {
      const offset = (y * width + x) * 4;
      return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
    });
  }

  function quantizeFrameColors(colors, maxColors) {
    if (!(maxColors > 0)) return colors.slice();
    const counts = new Map();
    colors.forEach(color => {
      if (!color) return;
      counts.set(color, (counts.get(color) || 0) + 1);
    });
    if (counts.size <= maxColors) return colors.slice();

    const palette = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxColors)
      .map(([hex]) => ({ hex, rgb: hexToRgb(hex) }))
      .filter(entry => entry.rgb);

    if (!palette.length) return colors.slice();
    const cache = new Map();
    return colors.map(color => {
      if (!color) return null;
      if (cache.has(color)) return cache.get(color);
      const rgb = hexToRgb(color);
      if (!rgb) return null;
      let best = palette[0].hex;
      let bestDistance = colorDistance(rgb, palette[0].rgb);
      for (let i = 1; i < palette.length; i++) {
        const dist = colorDistance(rgb, palette[i].rgb);
        if (dist < bestDistance) {
          bestDistance = dist;
          best = palette[i].hex;
        }
      }
      cache.set(color, best);
      return best;
    });
  }

  function imageDataToFrame(imageData, options = {}) {
    const data = imageData?.data;
    const pixelCount = imageData?.width && imageData?.height ? imageData.width * imageData.height : 0;
    if (!data || !pixelCount) return [];

    const alphaThreshold = clampInt(options.alphaThreshold, 0, 255, 10);
    const transparentMode = options.transparentMode === 'corner' ? 'corner' : 'alpha';
    const transparentThreshold = clampInt(options.transparentThreshold, 0, 255, 36);
    const corners = transparentMode === 'corner' ? cornerPalette(imageData) : [];

    const colors = new Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 4;
      const a = data[offset + 3];
      if (a <= alphaThreshold) {
        colors[i] = null;
        continue;
      }
      const rgb = { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
      if (transparentMode === 'corner' && corners.some(corner => colorDistance(rgb, corner) <= transparentThreshold * transparentThreshold)) {
        colors[i] = null;
        continue;
      }
      colors[i] = rgbToHex(rgb.r, rgb.g, rgb.b);
    }
    return quantizeFrameColors(colors, clampInt(options.maxColors, 0, 256, 0));
  }

  function frameKey(frame) {
    return Array.isArray(frame) ? frame.map(color => color || '').join('|') : '';
  }

  function normalizeRecentColors(colors) {
    if (!Array.isArray(colors)) return [];
    const seen = new Set();
    const out = [];
    colors.forEach(color => {
      const normalized = normalizeColor(color);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    });
    return out.slice(0, 10);
  }

  function normalizeFlagKey(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeFlags(flags) {
    if (!isObject(flags)) return {};
    const out = {};
    Object.entries(flags).forEach(([key, value]) => {
      const normalized = normalizeFlagKey(key);
      if (normalized) out[normalized] = value === true;
    });
    return out;
  }

  function normalizeSpriteTags(tags) {
    if (!Array.isArray(tags)) return [];
    const seen = new Set();
    const out = [];
    tags.forEach(tag => {
      const normalized = String(tag ?? '').trim();
      if (SPRITE_TAGS.has(normalized) && !seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    });
    return out;
  }

  function normalizeFrames(frames, width, height) {
    const size = width * height;
    const source = Array.isArray(frames) && frames.length ? frames : [new Array(size).fill(null)];
    return source.map(frame => {
      const normalized = new Array(size).fill(null);
      if (Array.isArray(frame)) {
        for (let i = 0; i < Math.min(size, frame.length); i++) {
          normalized[i] = normalizeColor(frame[i]);
        }
      }
      return normalized;
    });
  }

  function normalizeSpriteData(data) {
    const gridW = clampInt(data?.gridW, 1, 128, 16);
    const gridH = clampInt(data?.gridH, 1, 128, 16);
    return {
      gridW,
      gridH,
      fps: clampInt(data?.fps, 1, 60, 8),
      frames: normalizeFrames(data?.frames, gridW, gridH),
      tags: normalizeSpriteTags(data?.tags),
      folder: normalizeFolderPath(data?.folder),
      modified: typeof data?.modified === 'string' ? data.modified : new Date().toISOString(),
    };
  }

  function normalizeTileValue(value, collisionLayer) {
    if (collisionLayer) return value ? true : null;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  function normalizeMapLayer(layer, index, mapW, mapH) {
    const size = mapW * mapH;
    const collisionLayer = index === 3;
    const tiles = new Array(size).fill(null);
    if (Array.isArray(layer?.tiles)) {
      for (let i = 0; i < Math.min(size, layer.tiles.length); i++) {
        tiles[i] = normalizeTileValue(layer.tiles[i], collisionLayer);
      }
    }
    return {
      name: MAP_LAYER_NAMES[index],
      visible: layer?.visible !== false,
      tiles,
    };
  }

  function normalizeMapEntrance(entry, index, mapW, mapH) {
    return {
      id: normalizeName(entry?.id, `entrance_${index + 1}`),
      name: normalizeName(entry?.name, `Entrance ${index + 1}`),
      x: clampInt(entry?.x, 0, Math.max(0, mapW - 1), 0),
      y: clampInt(entry?.y, 0, Math.max(0, mapH - 1), 0),
    };
  }

  function normalizeMapTrigger(trigger, index, mapW, mapH) {
    const type = MAP_TRIGGER_TYPES.has(trigger?.type) ? trigger.type : 'transition';
    return {
      id: normalizeName(trigger?.id, `trigger_${index + 1}`),
      name: normalizeName(trigger?.name, `Trigger ${index + 1}`),
      type,
      x: clampInt(trigger?.x, 0, Math.max(0, mapW - 1), 0),
      y: clampInt(trigger?.y, 0, Math.max(0, mapH - 1), 0),
      w: clampInt(trigger?.w, 1, mapW, 1),
      h: clampInt(trigger?.h, 1, mapH, 1),
      targetMap: typeof trigger?.targetMap === 'string' ? trigger.targetMap : '',
      targetEntranceId: typeof trigger?.targetEntranceId === 'string' ? trigger.targetEntranceId : '',
      dialogId: typeof trigger?.dialogId === 'string' ? trigger.dialogId : '',
      message: typeof trigger?.message === 'string' ? trigger.message : '',
      requiredFlag: normalizeFlagKey(trigger?.requiredFlag),
      blockedMessage: typeof trigger?.blockedMessage === 'string' ? trigger.blockedMessage : '',
      setFlag: normalizeFlagKey(trigger?.setFlag),
      clearFlag: normalizeFlagKey(trigger?.clearFlag),
    };
  }

  function normalizeMapData(data, fallbackName = 'Untitled Map') {
    const mapW = clampInt(data?.mapW, 4, 128, 20);
    const mapH = clampInt(data?.mapH, 4, 128, 15);
    return {
      name: normalizeName(data?.name, fallbackName),
      mapW,
      mapH,
      layers: MAP_LAYER_NAMES.map((_, index) => normalizeMapLayer(data?.layers?.[index], index, mapW, mapH)),
      entrances: Array.isArray(data?.entrances)
        ? data.entrances.map((entry, index) => normalizeMapEntrance(entry, index, mapW, mapH))
        : [],
      triggers: Array.isArray(data?.triggers)
        ? data.triggers.map((trigger, index) => normalizeMapTrigger(trigger, index, mapW, mapH))
        : [],
      modified: typeof data?.modified === 'string' ? data.modified : new Date().toISOString(),
    };
  }

  function normalizeCharacterData(data, fallbackId = 'char_imported') {
    const type = CHARACTER_TYPES.has(data?.type) ? data.type : 'npc';
    const stats = isObject(data?.stats) ? data.stats : {};
    const spawn = isObject(data?.spawn) ? data.spawn : {};
    const sprites = isObject(data?.sprites) ? data.sprites : {};
    return {
      id: normalizeName(data?.id, fallbackId),
      name: normalizeName(data?.name, 'New Character'),
      type,
      notes: typeof data?.notes === 'string' ? data.notes : '',
      sprites: {
        idle: typeof sprites.idle === 'string' ? sprites.idle : '',
        walk: typeof sprites.walk === 'string' ? sprites.walk : '',
        attack: typeof sprites.attack === 'string' ? sprites.attack : '',
        hurt: typeof sprites.hurt === 'string' ? sprites.hurt : '',
      },
      stats: {
        hp: Math.max(0, asInt(stats.hp, 100)),
        attack: Math.max(0, asInt(stats.attack, 10)),
        defense: Math.max(0, asInt(stats.defense, 5)),
        speed: clampInt(stats.speed, 1, 20, 3),
        level: clampInt(stats.level, 1, 99, 1),
      },
      spawn: {
        map: typeof spawn.map === 'string' ? spawn.map : '',
        x: Math.max(0, asInt(spawn.x, 0)),
        y: Math.max(0, asInt(spawn.y, 0)),
      },
      dialogId: typeof data?.dialogId === 'string' ? data.dialogId : '',
    };
  }

  function normalizeDialogChoice(choice, index, nodeIds = [], fallbackNext = '') {
    const next = typeof choice?.next === 'string' && nodeIds.includes(choice.next)
      ? choice.next
      : fallbackNext;
    return {
      id: normalizeName(choice?.id, `choice_${index + 1}`),
      text: typeof choice?.text === 'string' ? choice.text : `Choice ${index + 1}`,
      next,
      requiredFlag: normalizeFlagKey(choice?.requiredFlag),
      setFlag: normalizeFlagKey(choice?.setFlag),
      clearFlag: normalizeFlagKey(choice?.clearFlag),
    };
  }

  function normalizeDialogNode(node, index, nodeIds = []) {
    const id = normalizeName(node?.id, `node_${index + 1}`);
    const next = typeof node?.next === 'string' && nodeIds.includes(node.next) ? node.next : '';
    const speakerType = ['narrator', 'character', 'custom'].includes(node?.speakerType)
      ? node.speakerType
      : 'narrator';
    return {
      id,
      speakerType,
      speakerCharacterId: typeof node?.speakerCharacterId === 'string' ? node.speakerCharacterId : '',
      speakerName: typeof node?.speakerName === 'string' ? node.speakerName : '',
      text: typeof node?.text === 'string' ? node.text : '',
      next,
      setFlag: normalizeFlagKey(node?.setFlag),
      clearFlag: normalizeFlagKey(node?.clearFlag),
      choices: Array.isArray(node?.choices)
        ? node.choices.map((choice, choiceIndex) => normalizeDialogChoice(choice, choiceIndex, nodeIds, next))
        : [],
    };
  }

  function normalizeDialogData(data, fallbackName = 'New Dialog') {
    const rawNodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const nodeIds = rawNodes.map((node, index) => normalizeName(node?.id, `node_${index + 1}`));
    const normalizedNodes = (rawNodes.length ? rawNodes : [{}]).map((node, index) =>
      normalizeDialogNode(node, index, nodeIds.length ? nodeIds : ['node_1']));
    const resolvedNodeIds = normalizedNodes.map(node => node.id);
    const finalNodes = normalizedNodes.map((node, index) =>
      normalizeDialogNode(node, index, resolvedNodeIds));
    const startNodeId = typeof data?.startNodeId === 'string' && resolvedNodeIds.includes(data.startNodeId)
      ? data.startNodeId
      : finalNodes[0].id;
    return {
      id: normalizeName(data?.id, `dialog_${Date.now()}`),
      name: normalizeName(data?.name, fallbackName),
      characterId: typeof data?.characterId === 'string' ? data.characterId : '',
      startNodeId,
      nodes: finalNodes,
      modified: typeof data?.modified === 'string' ? data.modified : new Date().toISOString(),
    };
  }

  function normalizeSceneObject(data, index) {
    const type = ['sprite', 'character', 'text'].includes(data?.type) ? data.type : 'sprite';
    return {
      id: normalizeName(data?.id, `scene_object_${index + 1}`),
      type,
      name: normalizeName(data?.name, `${type[0].toUpperCase()}${type.slice(1)} ${index + 1}`),
      spriteId: typeof data?.spriteId === 'string' ? data.spriteId : '',
      characterId: typeof data?.characterId === 'string' ? data.characterId : '',
      text: typeof data?.text === 'string' ? data.text : '',
      x: asInt(data?.x, 64),
      y: asInt(data?.y, 64),
      scale: Math.max(0.25, Math.min(8, Number(data?.scale) || 1)),
      flipX: data?.flipX === true,
      opacity: Math.max(0.1, Math.min(1, Number(data?.opacity) || 1)),
      z: asInt(data?.z, index),
    };
  }

  function normalizeSceneData(data, fallbackName = 'New Scene') {
    const rawObjects = Array.isArray(data?.objects) ? data.objects : [];
    return {
      id: normalizeName(data?.id, `scene_${Date.now()}`),
      name: normalizeName(data?.name, fallbackName),
      width: clampInt(data?.width, 160, 2560, 960),
      height: clampInt(data?.height, 120, 1440, 540),
      backgroundColor: normalizeColor(data?.backgroundColor) || '#1a2238',
      dialogId: typeof data?.dialogId === 'string' ? data.dialogId : '',
      requiredFlag: normalizeFlagKey(data?.requiredFlag),
      setFlag: normalizeFlagKey(data?.setFlag),
      clearFlag: normalizeFlagKey(data?.clearFlag),
      objects: rawObjects.map((object, index) => normalizeSceneObject(object, index))
        .sort((a, b) => a.z - b.z),
      modified: typeof data?.modified === 'string' ? data.modified : new Date().toISOString(),
    };
  }

  function normalizeProject(project) {
    const source = isObject(project) ? project : {};
    const sprites = {};
    if (isObject(source.sprites)) {
      Object.entries(source.sprites).forEach(([name, data]) => {
        const normalizedName = normalizeName(name, '');
        if (normalizedName) sprites[normalizedName] = normalizeSpriteData(data);
      });
    }

    const maps = Array.isArray(source.maps)
      ? source.maps.map((map, index) => normalizeMapData(map, `Map ${index + 1}`))
      : [];

    const characters = Array.isArray(source.characters)
      ? source.characters.map((character, index) =>
          normalizeCharacterData(character, `char_imported_${index + 1}`))
      : [];

    const dialogs = Array.isArray(source.dialogs)
      ? source.dialogs.map((dialog, index) => normalizeDialogData(dialog, `Dialog ${index + 1}`))
      : [];

    const scenes = Array.isArray(source.scenes)
      ? source.scenes.map((scene, index) => normalizeSceneData(scene, `Scene ${index + 1}`))
      : [];

    return {
      name: normalizeName(source.name || source.projectName, 'Untitled Game'),
      created: typeof source.created === 'string' ? source.created : new Date().toISOString(),
      modified: typeof source.modified === 'string' ? source.modified : new Date().toISOString(),
      flags: normalizeFlags(source.flags),
      sprites,
      tilesets: isObject(source.tilesets) ? source.tilesets : {},
      maps,
      characters,
      dialogs,
      scenes,
    };
  }

  function blankProject(name) {
    return normalizeProject({ name });
  }

  function getProject() {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (!raw) return null;
    try {
      return normalizeProject(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function setProject(project, options = {}) {
    const normalized = normalizeProject(project);
    if (options.touch !== false) normalized.modified = new Date().toISOString();
    localStorage.setItem(PROJECT_KEY, JSON.stringify(normalized));
    return normalized;
  }

  window.ProjectUtils = {
    PROJECT_KEY,
    blankProject,
    drawImageToCanvas,
    frameKey,
    getProject,
    imageDataToFrame,
    loadImageFile,
    setProject,
    normalizeProject,
    normalizeSpriteData,
    normalizeMapData,
    normalizeCharacterData,
    normalizeDialogData,
    normalizeSceneData,
    normalizeRecentColors,
    normalizeFlags,
    normalizeFolderPath,
    slugifyName,
  };
})();
