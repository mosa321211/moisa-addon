const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const { log, logWarn, logError } = require('../utils/logger');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Base URL of the Torrentio service.
const TORRENTIO_BASE =
  process.env.TORRENTIO_BASE || 'https://torrentio.strem.fun';

// Path segment before `/stream/...` (quality filter etc.).
const TORRENTIO_PATH_PREFIX =
  process.env.TORRENTIO_PATH_PREFIX ||
  'qualityfilter=threed,480p,scr,cam,unknown';

// Torrentio providers available in configuration. Russian providers are
// intentionally excluded from both the defaults and the accepted options.
const TORRENTIO_PROVIDER_IDS = [
  'yts',
  'eztv',
  'rarbg',
  '1337x',
  'thepiratebay',
  'ext',
  'kickasstorrents',
  'torrentgalaxy',
  'uindex',
  'knaben',
  'magnetdl',
  'horriblesubs',
  'nyaasi',
  'animetosho',
  'tokyotosho',
  'anidex',
  'nekobt',
  'comando',
  'bludv',
  'micoleaodublado',
  'torrent9',
  'ilcorsaronero',
  'mejortorrent',
  'wolfmax4k',
  'cinecalidad',
  'besttorrents'
];
const TORRENTIO_DEFAULT_PROVIDERS = [
  'yts',
  'eztv',
  '1337x',
  'thepiratebay',
  'ext'
];
const TORRENTIO_PROVIDER_LABELS = {
  yts: /^yts(?:\.mx)?$/i,
  eztv: /^eztv(?:\.re)?$/i,
  rarbg: /^rarbg$/i,
  '1337x': /^1337x(?:\.to)?$/i,
  thepiratebay: /^(?:the\s*)?pirate\s*bay$|^tpb$/i,
  ext: /^ext$/i,
  kickasstorrents: /^(?:kickass(?:torrents)?|kat)$/i,
  torrentgalaxy: /^(?:torrent\s*galaxy|tgx)$/i,
  uindex: /^uindex$/i,
  knaben: /^knaben$/i,
  magnetdl: /^magnet\s*dl$/i,
  horriblesubs: /^horrible\s*subs$/i,
  nyaasi: /^nyaa(?:\.si)?$/i,
  animetosho: /^anime\s*tosho$/i,
  tokyotosho: /^tokyo\s*tosho$/i,
  anidex: /^anidex$/i,
  nekobt: /^neko\s*bt$/i,
  comando: /^comando$/i,
  bludv: /^blu\s*dv$/i,
  micoleaodublado: /^mico\s*leao\s*dublado$/i,
  torrent9: /^torrent\s*9$/i,
  ilcorsaronero: /^il\s*corsaro\s*nero$/i,
  mejortorrent: /^mejor\s*torrent$/i,
  wolfmax4k: /^wolf\s*max\s*4k$/i,
  cinecalidad: /^cine\s*calidad$/i,
  besttorrents: /^best\s*torrents$/i
};
const RUSSIAN_PROVIDER_LABEL = /\b(?:rutor|rutracker)\b|рутор|рутрекер/i;
const TORRENTIO_SORTS = ['quality', 'qualitysize', 'seeders', 'size'];
const TORRENTIO_QUALITY_IDS = [
  'brremux',
  'hdrall',
  'dolbyvision',
  'threed',
  '4k',
  '1080p',
  '720p',
  '480p',
  'other',
  'scr',
  'cam',
  'unknown'
];
const TORRENTIO_LANGUAGE_IDS = [
  'japanese', 'italian', 'portuguese', 'spanish', 'latino', 'korean',
  'chinese', 'taiwanese', 'french', 'german', 'dutch', 'hindi', 'telugu',
  'tamil', 'polish', 'lithuanian', 'latvian', 'estonian', 'czech',
  'slovakian', 'slovenian', 'hungarian', 'romanian', 'bulgarian', 'serbian',
  'croatian', 'greek', 'danish', 'finnish', 'swedish', 'norwegian', 'turkish',
  'arabic', 'persian', 'hebrew', 'vietnamese', 'indonesian', 'malay', 'thai'
];

// Base URL of the TorrServer instance.
// Used as a fallback when no explicit `torrserver` is provided via query/config.
const TORRSERVER_URL =
  process.env.TORRSERVER_URL || 'http://127.0.0.1:8090';

// Timeout for requests to Torrentio (in milliseconds).
const TORRENTIO_TIMEOUT_MS =
  Number(process.env.TORRENTIO_TIMEOUT_MS) || 25000;

// ---------------------------------------------------------------------------
// Addon manifest
// ---------------------------------------------------------------------------

const builder = new addonBuilder({
  id: 'org.stremio.moisa.addon',
  version: '1.2.0',
  name: 'Moisa',
  description:
    'Simple addon: fetches torrents from Torrentio and redirects playback to a local TorrServer instance.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
});

// ---------------------------------------------------------------------------
// Torrentio integration
// ---------------------------------------------------------------------------

/**
 * Fetch stream candidates from Torrentio for a given item.
 *
 * The quality/path filter can be overridden per request via
 * `torrentioPathPrefix` so users can customize from the config page.
 */
async function fetchTorrentioStreams({
  type,
  id,
  torrentioPathPrefix,
  torrentioOptions
}) {
  const prefix = (torrentioPathPrefix || TORRENTIO_PATH_PREFIX)
    .replace(/^\/+|\/+$/g, '')
    .replace(/(?:^|\|)providers=[^|]*(?=\||$)/g, '')
    .replace(/^\|+|\|+$/g, '');
  const options =
    torrentioOptions && typeof torrentioOptions === 'object'
      ? torrentioOptions
      : {};
  const hasConfiguredProviders = Array.isArray(options.providers);
  const requestedProviders = hasConfiguredProviders
    ? options.providers.filter((provider) =>
        TORRENTIO_PROVIDER_IDS.includes(provider)
      )
    : TORRENTIO_DEFAULT_PROVIDERS;
  if (hasConfiguredProviders && requestedProviders.length === 0) {
    logWarn('No supported Torrentio providers selected', { type, id });
    return [];
  }
  const providerList = requestedProviders;
  const parts = [`providers=${providerList.join(',')}`];
  if (TORRENTIO_SORTS.includes(options.sort)) {
    parts.push(`sort=${options.sort}`);
  }
  if (Array.isArray(options.qualityFilters)) {
    const qualities = options.qualityFilters.filter((quality) =>
      TORRENTIO_QUALITY_IDS.includes(quality)
    );
    parts.push(`qualityfilter=${qualities.join(',')}`);
  } else if (prefix) {
    const legacyQualityFilter = prefix
      .split('|')
      .find((part) => part.startsWith('qualityfilter='));
    if (legacyQualityFilter) {
      const qualities = legacyQualityFilter
        .slice('qualityfilter='.length)
        .split(',')
        .filter((quality) => TORRENTIO_QUALITY_IDS.includes(quality));
      parts.push(`qualityfilter=${qualities.join(',')}`);
    }
  }
  const limit = String(options.limit || '');
  if (/^[1-9]\d*$/.test(limit)) parts.push(`limit=${limit}`);
  const minSeeders = Number(options.minSeeders);
  if (Number.isInteger(minSeeders) && minSeeders > 0) {
    parts.push(`minseeders=${minSeeders}`);
  }
  if (Array.isArray(options.languages) && options.languages.length) {
    const languages = options.languages.filter((language) =>
      TORRENTIO_LANGUAGE_IDS.includes(language)
    );
    if (languages.length) parts.push(`language=${languages.join(',')}`);
  }
  const configuredSizeLimit = options.sizeLimit || options.sizeFilter;
  if (configuredSizeLimit) {
    const sizeLimits = String(configuredSizeLimit)
      .split(',')
      .map((size) => size.trim().replace(/\s+/g, '').toLowerCase())
      .filter((size) => /^\d+(?:\.\d+)?(?:kb|mb|gb|tb)$/.test(size))
      .filter(Boolean)
      .join(',');
    if (sizeLimits) parts.push(`sizelimit=${sizeLimits}`);
  }
  const torrentioConfig = parts.join('|');
  const url = `${TORRENTIO_BASE}/${torrentioConfig}/stream/${type}/${id}.json`;

  log('fetchTorrentioStreams request', { type, id, url });

  const { data } = await axios.get(url, {
    timeout: TORRENTIO_TIMEOUT_MS
  });

  if (!data || !Array.isArray(data.streams)) {
    logWarn('Torrentio responded without a streams array', {
      type,
      id
    });
    return [];
  }

  log('fetchTorrentioStreams response', {
    type,
    id,
    count: data.streams.length
  });

  // Torrentio can return stale or unexpected sources, so enforce the selected
  // provider list locally as a final boundary. Prefer its explicit provider
  // field or the provider label following the gear marker in the title.
  let removedRussian = 0;
  let removedUnselectedOrUnknown = 0;
  const filteredStreams = data.streams.filter((stream) => {
    const allText = [
      stream.name,
      stream.title,
      stream.description,
      stream.behaviorHints && stream.behaviorHints.filename
    ]
      .filter((value) => typeof value === 'string')
      .join('\n');
    const sourceCandidates = [stream.source, stream.provider].filter(
      (value) => typeof value === 'string'
    );
    for (const field of [stream.title, stream.description, stream.name]) {
      if (typeof field !== 'string') continue;
      const marker = field.match(/(?:⚙️|provider\s*[:=])\s*([^\r\n]+)/i);
      if (marker) sourceCandidates.push(marker[1].trim());
      else if (!/^torrentio(?:\s|$)/i.test(field.trim())) {
        // Some Torrentio responses expose the provider as the whole name.
        sourceCandidates.push(field.trim());
      }
    }

    if (
      RUSSIAN_PROVIDER_LABEL.test(allText) ||
      sourceCandidates.some((source) => RUSSIAN_PROVIDER_LABEL.test(source))
    ) {
      removedRussian += 1;
      return false;
    }
    const isSelected = providerList.some((provider) => {
      const label = TORRENTIO_PROVIDER_LABELS[provider];
      return label && sourceCandidates.some((source) => label.test(source));
    });
    if (!isSelected) removedUnselectedOrUnknown += 1;
    return isSelected;
  });

  log('fetchTorrentioStreams source filter', {
    type,
    id,
    selectedProviders: providerList,
    upstreamCount: data.streams.length,
    filteredCount: filteredStreams.length,
    removedRussian,
    removedUnselectedOrUnknown
  });
  return filteredStreams;
}

// ---------------------------------------------------------------------------
// Play proxy helpers
// ---------------------------------------------------------------------------

/**
 * Build a URL that points back to this addon, which will then resolve the
 * correct TorrServer file and redirect to it via `/play`.
 */
function buildPlayProxyUrl({
  selfBase,
  infoHash,
  type,
  id,
  season,
  episode,
  torrServerBase,
  torrserverUser,
  torrserverPass,
  filename,
  fileIndex
}) {
  if (!selfBase || !infoHash) return null;

  const base = selfBase.replace(/\/+$/, '');
  const params = new URLSearchParams();

  params.set('infoHash', infoHash);
  params.set('type', type);
  params.set('id', id);

  if (torrServerBase) params.set('torrserver', torrServerBase);
  if (torrserverUser) params.set('torrserverUser', torrserverUser);
  if (typeof torrserverPass === 'string') {
    params.set('torrserverPass', torrserverPass);
  }
  if (filename) params.set('filename', filename);
  if (season !== undefined && season !== null) {
    params.set('season', String(season));
  }
  if (episode !== undefined && episode !== null) {
    params.set('episode', String(episode));
  }
  if (fileIndex !== undefined && fileIndex !== null) {
    params.set('fileIndex', String(fileIndex));
  }

  return `${base}/play?${params.toString()}`;
}

/**
 * Build a single Stremio stream entry from a Torrentio candidate.
 * This does not talk to TorrServer yet – it only constructs a `/play` URL
 * that the HTTP handler will later translate to a direct TorrServer URL.
 */
async function buildStremioStreamFromCandidate({
  candidate,
  index,
  type,
  id,
  torrServerBase,
  torrserverUser,
  torrserverPass,
  selfBase,
  season,
  episode
}) {
  if (!candidate.infoHash) {
    logWarn('Skipping candidate without infoHash', { type, id, index });
    return null;
  }

  if (!selfBase) {
    logWarn('No addon base URL available; cannot build play proxy URL', {
      type,
      id,
      index
    });
    return null;
  }

  const filename =
    (candidate.behaviorHints && candidate.behaviorHints.filename) || '';

  // Torrentio usually provides fileIdx which matches the internal index of
  // the file within the torrent. We pass this through to `/play` and later
  // into TorrServer.
  const fileIndex =
    typeof candidate.fileIdx === 'number'
      ? candidate.fileIdx
      : Number.isInteger(Number(candidate.fileIdx))
        ? Number(candidate.fileIdx)
        : undefined;

  const title = candidate.title || filename || candidate.name || 'Moisa stream';

  const name = candidate.name || (filename ? `Moisa • ${filename}` : 'Moisa');

  const streamUrl = buildPlayProxyUrl({
    selfBase,
    infoHash: candidate.infoHash,
    type,
    id,
    season,
    episode,
    torrServerBase,
    torrserverUser,
    torrserverPass,
    filename,
    fileIndex
  });

  if (!streamUrl) {
    logWarn('Failed to build play proxy URL for candidate', {
      type,
      id,
      index
    });
    return null;
  }

  return {
    name,
    title,
    url: streamUrl
  };
}

/**
 * Resolve a single play request into a direct TorrServer URL.
 * Called only when the user actually starts playback.
 */
async function resolvePlayUrl({
  torrServerBase,
  type,
  id,
  infoHash,
  season,
  episode,
  filename,
  fileIndex
}) {
  if (!torrServerBase || !infoHash) {
    return null;
  }

  const base = torrServerBase.replace(/\/+$/, '');
  const safeName = encodeURIComponent(
    (filename && String(filename)) || 'video'
  );

  // TorrServer `/stream` expects a 1-based file index within the torrent.
  //
  // Torrentio's `fileIdx` is often reliable for series episodes (multi-file
  // torrents), but can be incorrect for some movie torrents (where we usually
  // want the main video file).
  let index = 0;
  if (type === 'movie') {
    index = 1;
  } else if (
    fileIndex !== undefined &&
    fileIndex !== null &&
    !Number.isNaN(Number(fileIndex))
  ) {
    // Torrentio's fileIdx is 0-based; TorrServer expects 1-based.
    index = Number(fileIndex) + 1;
  }

  const directUrl = `${base}/stream/${safeName}?link=${encodeURIComponent(
    infoHash
  )}&index=${index}&play`;

  log('resolvePlayUrl (no TorrServer stat/preload)', {
    type,
    id,
    infoHash,
    season,
    episode,
    requestedFileIndex: fileIndex,
    resolvedIndex: index,
    torrServerBase,
    directUrl
  });

  return directUrl;
}

// ---------------------------------------------------------------------------
// Stremio stream handler
// ---------------------------------------------------------------------------

builder.defineStreamHandler(async ({ type, id, extra }) => {
  try {
    // Determine TorrServer base URL:
    // 1) prefer explicit override from `extra` (?torrserver=... via config)
    // 2) fall back to explicit environment variable TORRSERVER_URL (or localhost default)
    const torrServerBase =
      (extra && extra.torrserver) || TORRSERVER_URL || null;

    if (!torrServerBase) {
      logWarn('No TorrServer base URL configured', { type, id });
      return { streams: [] };
    }

    // Determine the base URL of this addon (used for proxy /play URLs).
    // Prefer an explicit environment override (e.g. SELF_BASE_URL=https://moisa.fun/api/moisa)
    // and only fall back to the value forwarded from the HTTP layer.
    const selfBase =
      process.env.SELF_BASE_URL || (extra && extra._base) || null;

    log('Resolved bases for stream handler', {
      type,
      id,
      torrServerBase,
      selfBase
    });

    // 1. Ask Torrentio for available torrents. Allow override of the
    //    quality/path prefix via extra.torrentioPathPrefix (from config).
    const streams = await fetchTorrentioStreams({
      type,
      id,
      torrentioPathPrefix: extra && extra.torrentioPathPrefix,
      torrentioOptions: extra && extra.torrentioOptions
    });

    if (!streams.length) {
      logWarn('No streams returned from Torrentio', { type, id });
      return { streams: [] };
    }

    // 2. Extract season/episode info for series (from id and/or extra).
    let season;
    let episode;

    if (type === 'series') {
      const idParts = String(id).split(':');
      if (idParts.length >= 3) {
        const maybeSeason = parseInt(idParts[idParts.length - 2], 10);
        const maybeEpisode = parseInt(idParts[idParts.length - 1], 10);
        if (!Number.isNaN(maybeSeason)) season = maybeSeason;
        if (!Number.isNaN(maybeEpisode)) episode = maybeEpisode;
      }

      if (extra) {
        if (season === undefined && extra.season) {
          const s = parseInt(extra.season, 10);
          if (!Number.isNaN(s)) season = s;
        }
        if (episode === undefined && extra.episode) {
          const e = parseInt(extra.episode, 10);
          if (!Number.isNaN(e)) episode = e;
        }
      }
    }

    // 3. Build multiple stream options, one per Torrentio candidate.
    const stremioStreams = (
      await Promise.all(
        streams
          // Limit to a reasonable number to avoid cluttering the UI.
          .slice(0, 25)
          .map((candidate, index) =>
            buildStremioStreamFromCandidate({
              candidate,
              index,
              type,
              id,
              torrServerBase,
              torrserverUser: extra && extra.torrserverUser,
              torrserverPass: extra && extra.torrserverPass,
              selfBase,
              season,
              episode
            })
          )
      )
    ).filter(Boolean);

    if (!stremioStreams.length) {
      logWarn('No valid candidates after building proxy URLs', { type, id });
      return { streams: [] };
    }

    return { streams: stremioStreams };
  } catch (err) {
    logError('Stream handler error', {
      message: err.message || String(err),
      stack: err.stack
    });
    return { streams: [] };
  }
});

const addonInterface = builder.getInterface();

// Expose a helper for the HTTP layer to resolve /play requests.
addonInterface.resolvePlayUrl = resolvePlayUrl;

module.exports = addonInterface;
