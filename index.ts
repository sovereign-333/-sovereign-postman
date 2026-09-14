import express, { Request, Response } from 'express';
import { Contract, JsonRpcProvider } from 'ethers';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { LRUCache } from 'lru-cache';

// ============================================================================
// 🔱 1. ON-CHAIN CONFIGURATION & TYPES
// ============================================================================
const CONTRACT_ADDRESS = '0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2';
const MASTER_COLLECTION_IMAGE = 'https://gateway.irys.xyz/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR';

const GATEWAY_NODES = [
  'https://gateway.irys.xyz',
  'https://arweave.net',
  'https://ar-io.dev'
];

const RPC_ENDPOINTS = [
  'https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl',
  'https://mainnet.base.org',
  'https://base.llamarpc.com'
];

const CONTRACT_ABI = [
  'function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)',
  'function getTBA(uint256 t) public view returns (address)'
];

interface DeedTruth {
  owner: string;
  active: boolean;
  sanctified: boolean;
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
  external_url?: string;
  attributes: OpenSeaAttribute[];
}

const PROVIDERS = RPC_ENDPOINTS.map(url => new JsonRpcProvider(url, 8453, { staticNetwork: true }));
const CONTRACTS = PROVIDERS.map(provider => new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider));

// ============================================================================
// 🛡️ 2. SECURITY, CACHING & RATE LIMITING
// ============================================================================
const metadataCache = new LRUCache<string, OpenSeaMetadataResponse>({
  max: 1000,
  ttl: 1000 * 60 * 3, // 3 Minutes
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 300, 
  message: { error: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================================
// ⚡ 3. HARDENED GATEWAY RACER (PER-REQUEST ABORT ISOLATION)
// ============================================================================

/**
 * Executes isolated HTTP HEAD races across Arweave Gateways.
 * Uses individual AbortControllers per target to guarantee no cross-signal interference.
 */
async function resolveFastestGateway(rawUri: string | null | undefined): Promise<string> {
  if (!rawUri) return '';
  const trimmed = rawUri.trim();
  if (!trimmed || trimmed.toUpperCase() === 'UNASSIGNED') return '';

  let txId = '';
  if (/^[a-zA-Z0-9_-]{43}$/.test(trimmed)) {
    txId = trimmed;
  } else if (trimmed.startsWith('ar://')) {
    txId = trimmed.replace('ar://', '');
  } else if (trimmed.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${trimmed.replace('ipfs://', '')}`;
  } else {
    return trimmed;
  }

  const controllers: AbortController[] = [];

  try {
    const racePromises = GATEWAY_NODES.map((gateway) => {
      const controller = new AbortController();
      controllers.push(controller);
      
      const timeoutId = setTimeout(() => controller.abort(), 1500);
      const targetUrl = `${gateway}/${txId}`;

      return fetch(targetUrl, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'Sovereign-Gateway-Racer/1.0' }
      })
      .then((res) => {
        clearTimeout(timeoutId);
        if (res.ok) return targetUrl;
        throw new Error(`HTTP_${res.status}`);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        throw err;
      });
    });

    return await Promise.any(racePromises);
  } catch (_err) {
    return `https://gateway.irys.xyz/${txId}`;
  } finally {
    // Safely abort all lingering gateway connections
    controllers.forEach(c => {
      try { c.abort(); } catch (_) {}
    });
  }
}

/**
 * Parses raw DNA string into OpenSea Attributes array.
 */
function parseDnaTraits(dnaString: string | null | undefined): OpenSeaAttribute[] {
  if (!dnaString) return [];
  const trimmedDna = dnaString.trim();
  if (!trimmedDna || trimmedDna.toUpperCase() === 'UNASSIGNED') return [];

  const attributes: OpenSeaAttribute[] = [];
  const segments = trimmedDna.split('|');

  for (const segment of segments) {
    const rawSegment = segment.trim();
    if (!rawSegment) continue;

    const firstColonIndex = rawSegment.indexOf(':');
    if (firstColonIndex > 0) {
      const key = rawSegment.substring(0, firstColonIndex).trim();
      const valStr = rawSegment.substring(firstColonIndex + 1).trim();

      if (key && valStr) {
        attributes.push({ trait_type: key, value: valStr });
      }
    }
  }

  return attributes;
}

function isVideoUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.mov') || lower.includes('/video/');
}

// ============================================================================
// ⚖️ 4. ON-CHAIN TRUTH EXTRACTOR
// ============================================================================
async function getSovereignTruth(tokenId: bigint): Promise<DeedTruth> {
  let lastError: Error | null = null;

  for (let i = 0; i < CONTRACTS.length; i++) {
    const contract = CONTRACTS[i];
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      const fetchPromise = Promise.all([
        contract.getDeedData(tokenId),
        contract.getTBA(tokenId).catch(() => '0x0000000000000000000000000000000000000000')
      ]);

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('RPC_TIMEOUT')), 2500);
      });

      const [deed, tbaAddress] = await Promise.race([fetchPromise, timeoutPromise]);

      return {
        owner: String(deed[0] ?? ''),
        active: Boolean(deed[1]),
        sanctified: Boolean(deed[2]),
        front: String(deed[3] ?? ''),
        back: String(deed[4] ?? ''),
        video: String(deed[5] ?? ''),
        dna: String(deed[6] ?? ''),
        hidden: String(deed[7] ?? ''),
        tba: String(tbaAddress ?? '0x0000000000000000000000000000000000000000')
      };
    } catch (err: any) {
      lastError = err;
      if (err?.message?.includes('revert') || err?.message?.includes('NonexistentToken')) {
        throw new Error('TOKEN_NOT_FOUND');
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error('ALL_RPC_PROVIDERS_FAILED');
}

// ============================================================================
// 🚀 5. EXPRESS API SERVER PROTOCOL
// ============================================================================
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use('/api/', apiLimiter);

app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  next();
});

app.get('/api/metadata/:tokenId', async (req: Request, res: Response): Promise<void> => {
  const rawParam = req.params.tokenId || '';
  const cleanTokenIdStr = rawParam.replace(/\.json$/i, '').trim();

  if (!/^\d+$/.test(cleanTokenIdStr)) {
    res.status(400).json({ error: 'INVALID_TOKEN_ID_FORMAT' });
    return;
  }

  const numericId = BigInt(cleanTokenIdStr);
  if (numericId < 1n || numericId > 333n) {
    res.status(404).json({ error: 'TOKEN_OUT_OF_BOUNDS', message: 'Token ID must be between 1 and 333.' });
    return;
  }

  const cacheKey = `metadata_${cleanTokenIdStr}`;
  if (metadataCache.has(cacheKey)) {
    res.status(200).json(metadataCache.get(cacheKey));
    return;
  }

  try {
    const truth = await getSovereignTruth(numericId);

    if (!truth.active || truth.owner === '0x0000000000000000000000000000000000000000') {
      res.status(404).json({ error: 'TOKEN_UNASSIGNED_OR_BURNED', message: 'Token is not active or has been burned.' });
      return;
    }

    // Parallel Gateway Race execution
    const [resolvedFront, resolvedBack, resolvedVideo] = await Promise.all([
      resolveFastestGateway(truth.front),
      resolveFastestGateway(truth.back),
      resolveFastestGateway(truth.video)
    ]);

    const resolvedExternal = truth.hidden && truth.hidden.toUpperCase() !== 'UNASSIGNED' ? truth.hidden : undefined;

    const attributes: OpenSeaAttribute[] = [
      { trait_type: 'RANK', value: 'THE COUNCIL PRIME' },
      { trait_type: 'IDENTITY STATUS', value: truth.sanctified ? 'SANCTIFIED (NOVA)' : 'UNCOMPROMISED INTEGRITY PROTOCOL' }
    ];

    if (truth.tba && truth.tba !== '0x0000000000000000000000000000000000000000') {
      attributes.push({ trait_type: 'Token Bound Account (TBA)', value: truth.tba });
    }

    const parsedDnaTraits = parseDnaTraits(truth.dna);
    parsedDnaTraits.forEach(trait => attributes.push(trait));

    let finalImage = MASTER_COLLECTION_IMAGE;
    let finalAnimationUrl: string | undefined = undefined;

    if (resolvedVideo) {
      finalAnimationUrl = resolvedVideo;
      finalImage = resolvedFront || MASTER_COLLECTION_IMAGE;
    } else if (isVideoUrl(resolvedFront)) {
      finalAnimationUrl = resolvedFront;
      finalImage = resolvedBack || MASTER_COLLECTION_IMAGE;
    } else if (resolvedFront) {
      finalImage = resolvedFront;
      if (isVideoUrl(resolvedBack)) {
        finalAnimationUrl = resolvedBack;
      }
    } else if (resolvedBack) {
      if (isVideoUrl(resolvedBack)) {
        finalAnimationUrl = resolvedBack;
      } else {
        finalImage = resolvedBack;
      }
    }

    const responsePayload: OpenSeaMetadataResponse = {
      name: `THE IMPERIAL SOVEREIGN DEED ♠️ #${cleanTokenIdStr}`,
      description: 'IMPERIAL SOVEREIGN ARCHITECTURE - Absolute Immutable Autarkic Identity Manifest',
      image: finalImage,
      ...(finalAnimationUrl ? { animation_url: finalAnimationUrl } : {}),
      ...(resolvedExternal ? { external_url: resolvedExternal } : {}),
      attributes
    };

    metadataCache.set(cacheKey, responsePayload);
    res.status(200).json(responsePayload);

  } catch (error: any) {
    if (error?.message === 'TOKEN_NOT_FOUND') {
      res.status(404).json({ error: 'TOKEN_NOT_FOUND', message: 'Token does not exist on-chain.' });
    } else {
      res.status(503).json({ error: 'RPC_CONSENSUS_FAILURE', message: 'Blockchain nodes currently unreachable. Retry imminent.' });
    }
  }
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'HEALTHY', cache_size: metadataCache.size, timestamp: Date.now() });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'ENDPOINT_NOT_FOUND' });
});

export default app;