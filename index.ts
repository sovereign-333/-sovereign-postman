import express, { Request, Response, NextFunction } from 'express';
import { Contract, JsonRpcProvider, ZeroAddress, id } from 'ethers';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { LRUCache } from 'lru-cache';

// Sovereign Protocol V18 — Base Mainnet (Chain ID 8453)
const CONTRACT_ADDRESS = '0x06040F2e5301B2616491E113962A84d372b8f600';
const MASTER_COLLECTION_IMAGE = 'https://gateway.irys.xyz/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR';
const MAX_SUPPLY = 5555n;
const ZERO_ADDRESS = ZeroAddress;

const GATEWAY_NODES = [
  'https://gateway.irys.xyz',
  'https://arweave.net',
  'https://ar-io.dev',
];
const GATEWAY_HOSTS = new Set(GATEWAY_NODES.map((g) => new URL(g).hostname));
const GATEWAY_TIMEOUT_MS = 1800;
const RPC_TIMEOUT_MS = 4000;

const RPC_ENDPOINTS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
];

// F3: the custom error is declared so ethers can decode it by name.
const CONTRACT_ABI = [
  'error NonexistentToken()',
  'function getDeedData(uint256 t) view returns (address sovereignOwner, bool sovereignActive, bool absoluteSovereigntyStatus, string sovereignFront, string sovereignBack, string sovereignVideo, string sovereignIdentity, string sovereignHidden, address sovereignTba)',
];
const NONEXISTENT_TOKEN_SELECTOR = id('NonexistentToken()').slice(0, 10);

// F2: caching is opt-in per response. Everything defaults to no-store.
const CACHE_CONTROL_OK = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
const CACHE_CONTROL_NONE = 'no-store';

interface DeedTruth {
  owner: string;
  active: boolean;
  sovereigntyStatus: boolean;
  front: string;
  back: string;
  video: string;
  dna: string;
  hidden: string;
  tba: string;
}

interface OpenSeaAttribute {
  trait_type: string;
  value: string | number | boolean;
}

interface OpenSeaMetadataResponse {
  name: string;
  description: string;
  image: string;
  animation_url?: string;
  back_image?: string;
  external_url?: string;
  attributes: OpenSeaAttribute[];
}

class TokenNotFoundError extends Error {
  constructor() {
    super('TOKEN_NOT_FOUND');
    this.name = 'TokenNotFoundError';
  }
}

class ProviderFailureError extends Error {
  constructor(cause?: unknown) {
    super('ALL_RPC_PROVIDERS_FAILED');
    this.name = 'ProviderFailureError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function createProviders(): JsonRpcProvider[] {
  return RPC_ENDPOINTS.map(
    (url) => new JsonRpcProvider(url, 8453, { staticNetwork: true }),
  );
}

const PROVIDERS = createProviders();
const CONTRACTS = PROVIDERS.map(
  (provider) => new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider),
);

const metadataCache = new LRUCache<string, OpenSeaMetadataResponse>({
  max: 1000,
  ttl: 1000 * 60 * 3,
});
// Concurrent requests for the same token share one upstream build.
const inflight = new Map<string, Promise<OpenSeaMetadataResponse>>();

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ───────────────────────── F4: URI validation / sanitization ─────────────────────────

const MAX_URI_LENGTH = 2048;
const ARWEAVE_TX_ID = /^[A-Za-z0-9_-]{43,44}$/;
// Percent-encoded path characters only; no '?', '#', '\', quotes or whitespace.
const SAFE_AR_PATH = /^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]*$/;
const SAFE_IPFS_PATH = /^[A-Za-z0-9._~%/-]+$/;
const FORBIDDEN_CHARS = /[\u0000-\u0020\u007f]/;

type UriRef =
  | { scheme: 'https'; url: string }
  | { scheme: 'ar'; txId: string; path: string };

type MediaKind = 'image' | 'animation' | 'unknown';

interface MediaRef {
  url: string;
  kind: MediaKind;
}

function hasTraversal(path: string): boolean {
  return path.split('/').some((segment) => segment === '..' || segment === '.');
}

/**
 * Accepts only: bare Arweave tx id, ar://<txid>[/path], ipfs://<cid>[/path], https://…
 * Everything else (http:, data:, javascript:, file:, blob:, userinfo URLs, control chars,
 * oversized strings, 'UNASSIGNED') returns null.
 */
function parseUri(raw: string | null | undefined): UriRef | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URI_LENGTH) return null;
  if (value.toUpperCase() === 'UNASSIGNED') return null;
  if (FORBIDDEN_CHARS.test(value)) return null;

  if (ARWEAVE_TX_ID.test(value)) {
    return { scheme: 'ar', txId: value, path: '' };
  }

  if (value.startsWith('ar://')) {
    const rest = value.slice('ar://'.length);
    const slash = rest.indexOf('/');
    const txId = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? '' : rest.slice(slash);
    if (!ARWEAVE_TX_ID.test(txId)) return null;
    if (path && (!SAFE_AR_PATH.test(path) || hasTraversal(path))) return null;
    return { scheme: 'ar', txId, path: path === '/' ? '' : path };
  }

  if (value.startsWith('ipfs://')) {
    let rest = value.slice('ipfs://'.length);
    if (rest.startsWith('ipfs/')) rest = rest.slice('ipfs/'.length);
    if (!rest || !SAFE_IPFS_PATH.test(rest) || hasTraversal(rest)) return null;
    return { scheme: 'https', url: `https://ipfs.io/ipfs/${rest}` };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;

  // A direct Arweave/Irys gateway link is re-expressed as ar:// so every gateway can be
  // raced and a bounded media prefix can be inspected (tx IDs carry no file extension).
  if (GATEWAY_HOSTS.has(parsed.hostname.toLowerCase()) && !parsed.search && !parsed.hash) {
    const match = /^\/([A-Za-z0-9_-]{43,44})(\/.*)?$/.exec(parsed.pathname);
    if (match) {
      const path = match[2] && match[2] !== '/' ? match[2] : '';
      if (!path || (SAFE_AR_PATH.test(path) && !hasTraversal(path))) {
        return { scheme: 'ar', txId: match[1], path };
      }
    }
  }

  return { scheme: 'https', url: parsed.toString() };
}

function gatewayUrl(ref: Extract<UriRef, { scheme: 'ar' }>, gateway: string = GATEWAY_NODES[0]): string {
  return `${gateway}/${ref.txId}${ref.path}`;
}

// ───────────────────────── media classification ─────────────────────────

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const ANIMATION_EXT = /\.(mp4|webm|mov|m4v|m3u8|ogv|html?|glb|gltf|mp3|wav|ogg)$/i;

function kindFromUrl(url: string): MediaKind {
  try {
    const pathname = new URL(url).pathname;
    if (ANIMATION_EXT.test(pathname) || pathname.toLowerCase().includes('/video/')) return 'animation';
    if (IMAGE_EXT.test(pathname)) return 'image';
  } catch {
    /* fall through */
  }
  return 'unknown';
}

function kindFromContentType(contentType: string): MediaKind {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') return 'unknown';
  if (type.startsWith('image/')) return 'image';
  if (
    type.startsWith('video/') ||
    type.startsWith('audio/') ||
    type.startsWith('model/') ||
    type === 'text/html' ||
    type === 'application/xhtml+xml' ||
    type === 'application/vnd.apple.mpegurl' ||
    type === 'application/x-mpegurl'
  ) {
    return 'animation';
  }
  return 'unknown';
}

const MEDIA_SNIFF_BYTES = 4096;

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let i = offset; i < offset + length && i < bytes.length; i++) {
    value += String.fromCharCode(bytes[i]);
  }
  return value.toLowerCase();
}

/**
 * Identify common media from a bounded prefix. The gateway's Content-Type and
 * URI suffix are hints only; an Arweave transaction ID does not encode a type.
 */
function kindFromBytes(prefix: Uint8Array): MediaKind {
  const bytes = prefix;
  const ascii = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '').trimStart().toLowerCase();

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return 'image';

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image';
  if (asciiAt(bytes, 0, 6) === 'gif87a' || asciiAt(bytes, 0, 6) === 'gif89a') return 'image';
  if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === 'riff' && asciiAt(bytes, 8, 4) === 'webp') return 'image';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image';

  if (bytes.length >= 12 && asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4);
    return brand === 'avif' || brand === 'avis' ? 'image' : 'animation';
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'animation';
  }
  if (bytes.length >= 4 && asciiAt(bytes, 0, 4) === 'gltf') return 'animation';

  if (
    ascii.startsWith('<!doctype html') ||
    ascii.startsWith('<html') ||
    ascii.startsWith('<head') ||
    ascii.startsWith('<body') ||
    ascii.startsWith('<script')
  ) return 'animation';

  if (ascii.startsWith('<svg') || (ascii.startsWith('<?xml') && ascii.includes('<svg'))) return 'image';

  if (
    ascii.startsWith('{') &&
    /"asset"\s*:\s*\{/.test(ascii) &&
    /"version"\s*:\s*"2(?:\.0)?"/.test(ascii) &&
    /"(?:scenes?|nodes|meshes|buffers)"\s*:/.test(ascii)
  ) return 'animation';

  return 'unknown';
}

function classifyMedia(contentType: string, url: string, prefix: Uint8Array): MediaKind {
  const byBytes = kindFromBytes(prefix);
  if (byBytes !== 'unknown') return byBytes;
  const byType = kindFromContentType(contentType);
  if (byType !== 'unknown') return byType;
  return kindFromUrl(url);
}

// ───────────────────────── gateway resolution ─────────────────────────

async function probeGateways(
  txId: string,
  path: string,
): Promise<{ url: string; contentType: string; kind: MediaKind } | null> {
  const controllers: AbortController[] = [];
  try {
    const probes = GATEWAY_NODES.map(async (gateway) => {
      const controller = new AbortController();
      controllers.push(controller);
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
      const target = `${gateway}/${txId}${path}`;
      try {
        const response = await fetch(target, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'Range': `bytes=0-${MEDIA_SNIFF_BYTES - 1}`,
            'User-Agent': 'Sovereign-Metadata-API/1.1',
          },
        });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* best-effort cleanup */ }
          throw new Error(`GATEWAY_HTTP_${response.status}`);
        }

        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
          try {
            while (total < MEDIA_SNIFF_BYTES) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = value.subarray(0, MEDIA_SNIFF_BYTES - total);
              chunks.push(chunk);
              total += chunk.length;
              if (total >= MEDIA_SNIFF_BYTES) {
                try { await reader.cancel(); } catch { /* best-effort cleanup */ }
                break;
              }
            }
          } finally {
            reader.releaseLock();
          }
        }
        const prefix = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          prefix.set(chunk, offset);
          offset += chunk.length;
        }

        const contentType = response.headers.get('content-type') ?? '';
        const kind = classifyMedia(contentType, response.url || target, prefix);
        if (kind === 'unknown') throw new Error('GATEWAY_MEDIA_TYPE_UNKNOWN');
        return { url: target, contentType, kind };
      } finally {
        clearTimeout(timer);
      }
    });
    return await Promise.any(probes);
  } catch {
    return null;
  } finally {
    for (const controller of controllers) {
      try { controller.abort(); } catch { /* best-effort cleanup */ }
    }
  }
}

/** Returns null when the on-chain string is empty or fails validation. */
async function resolveMedia(raw: string | null | undefined): Promise<MediaRef | null> {
  const ref = parseUri(raw);
  if (!ref) return null;

  if (ref.scheme === 'https') {
    return { url: ref.url, kind: kindFromUrl(ref.url) };
  }

  const probe = await probeGateways(ref.txId, ref.path);
  if (probe) {
    return { url: probe.url, kind: probe.kind };
  }

  const fallback = gatewayUrl(ref);
  return { url: fallback, kind: kindFromUrl(fallback) };
}

// ───────────────────────── DNA traits ─────────────────────────

function parseDnaTraits(dnaString: string | null | undefined): OpenSeaAttribute[] {
  if (!dnaString) return [];
  const trimmed = dnaString.trim();
  if (!trimmed || trimmed.toUpperCase() === 'UNASSIGNED') return [];

  const attributes: OpenSeaAttribute[] = [];
  for (const segment of trimmed.split('|')) {
    const index = segment.indexOf(':');
    if (index <= 0) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (key && value) attributes.push({ trait_type: key, value });
  }
  return attributes;
}

// ───────────────────────── F3: on-chain read + revert mapping ─────────────────────────

function isNonexistentTokenError(error: any): boolean {
  if (error?.code !== 'CALL_EXCEPTION') return false;
  if (error?.revert?.name === 'NonexistentToken') return true;
  const data = typeof error?.data === 'string' ? error.data.toLowerCase() : '';
  return data.startsWith(NONEXISTENT_TOKEN_SELECTOR);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('RPC_TIMEOUT')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getSovereignTruth(tokenId: bigint): Promise<DeedTruth> {
  let lastError: unknown;

  for (const contract of CONTRACTS) {
    try {
      const deed = await withTimeout<any>(contract.getDeedData(tokenId), RPC_TIMEOUT_MS);
      return {
        owner: String(deed[0] ?? ''),
        active: Boolean(deed[1]),
        sovereigntyStatus: Boolean(deed[2]),
        front: String(deed[3] ?? ''),
        back: String(deed[4] ?? ''),
        video: String(deed[5] ?? ''),
        dna: String(deed[6] ?? ''),
        hidden: String(deed[7] ?? ''),
        tba: String(deed[8] ?? ZERO_ADDRESS),
      };
    } catch (error: any) {
      // Only the contract's own NonexistentToken() error means "token not found".
      if (isNonexistentTokenError(error)) throw new TokenNotFoundError();
      // Any other failure (timeout, transport, unrecognised revert) fails over to the next provider.
      lastError = error;
    }
  }
  throw new ProviderFailureError(lastError);
}

// ───────────────────────── metadata assembly ─────────────────────────

async function buildMetadata(tokenId: bigint): Promise<OpenSeaMetadataResponse> {
  const truth = await getSovereignTruth(tokenId);
  if (!truth.owner || truth.owner.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new TokenNotFoundError();
  }

  const [front, back, video] = await Promise.all([
    resolveMedia(truth.front),
    resolveMedia(truth.back),
    resolveMedia(truth.video),
  ]);

  const attributes: OpenSeaAttribute[] = [
    { trait_type: 'Active', value: truth.active },
    { trait_type: 'Absolute Sovereignty', value: truth.sovereigntyStatus },
  ];
  if (truth.tba && truth.tba.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
    attributes.push({ trait_type: 'Token Bound Account (TBA)', value: truth.tba });
  }
  attributes.push(...parseDnaTraits(truth.dna));

  // animation_url: dedicated video slot first (unless it is actually an image),
  // otherwise Back when its content is video / 3D HTML / model / audio.
  const animation: MediaRef | undefined =
    (video && video.kind !== 'image' ? video : undefined) ??
    (back && back.kind === 'animation' ? back : undefined);

  // Front is a fixed image slot. Keep it in `image` even if an owner supplied
  // an unsupported file; never reinterpret Front as an animation.
  // Back images are preserved in a custom field for clients that display both sides.
  const backImage = back?.kind === 'image' ? back.url : undefined;

  const hiddenRef = parseUri(truth.hidden);
  const externalUrl =
    hiddenRef === null ? undefined : hiddenRef.scheme === 'https' ? hiddenRef.url : gatewayUrl(hiddenRef);

  return {
    name: `THE IMPERIAL SOVEREIGN DEED ♠️ #${tokenId.toString()}`,
    description: 'THE IMPERIAL SOVEREIGN DEED — Sovereign Protocol NFT metadata.',
    image: front ? front.url : MASTER_COLLECTION_IMAGE,
    ...(animation ? { animation_url: animation.url } : {}),
    ...(backImage ? { back_image: backImage } : {}),
    ...(externalUrl ? { external_url: externalUrl } : {}),
    attributes,
  };
}

// ───────────────────────── app ─────────────────────────

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '32kb' }));

// F2: default to no-store BEFORE the limiter so 429/400/404/503 and /health are never publicly cached.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', CACHE_CONTROL_NONE);
  next();
});
app.use('/api/', apiLimiter);

app.get('/api/metadata/:tokenId', async (req: Request, res: Response): Promise<void> => {
  const rawParam = req.params.tokenId || '';
  const tokenIdText = rawParam.replace(/\.json$/i, '').trim();

  if (!/^[0-9]+$/.test(tokenIdText)) {
    res.status(400).json({ error: 'INVALID_TOKEN_ID_FORMAT' });
    return;
  }

  let tokenId: bigint;
  try {
    tokenId = BigInt(tokenIdText);
  } catch {
    res.status(400).json({ error: 'INVALID_TOKEN_ID_FORMAT' });
    return;
  }

  if (tokenId < 1n || tokenId > MAX_SUPPLY) {
    res.status(404).json({
      error: 'TOKEN_OUT_OF_BOUNDS',
      message: `Token ID must be between 1 and ${MAX_SUPPLY.toString()}.`,
    });
    return;
  }

  const cacheKey = `metadata_${tokenId.toString()}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', CACHE_CONTROL_OK);
    res.status(200).json(cached);
    return;
  }

  try {
    let pending = inflight.get(cacheKey);
    if (!pending) {
      pending = buildMetadata(tokenId).finally(() => inflight.delete(cacheKey));
      inflight.set(cacheKey, pending);
    }
    const payload = await pending;

    metadataCache.set(cacheKey, payload);
    res.setHeader('Cache-Control', CACHE_CONTROL_OK); // only successful 200s are cacheable
    res.status(200).json(payload);
  } catch (error: unknown) {
    if (error instanceof TokenNotFoundError) {
      res.status(404).json({ error: 'TOKEN_NOT_FOUND', message: 'Token does not exist on-chain.' });
      return;
    }
    res.status(503).json({
      error: 'RPC_CONSENSUS_FAILURE',
      message: 'Blockchain RPC providers are currently unavailable. Please retry.',
    });
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'HEALTHY',
    chainId: 8453,
    contractAddress: CONTRACT_ADDRESS,
    maxSupply: MAX_SUPPLY.toString(),
    cacheSize: metadataCache.size,
    timestamp: Date.now(),
  });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'ENDPOINT_NOT_FOUND' });
});

export default app;
