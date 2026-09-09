import express, { Request, Response, NextFunction } from 'express';
import { Contract, JsonRpcProvider } from 'ethers';
import cors from 'cors';
import helmet from 'helmet';

// ============================================================================
// 🔱 CONSTANTS & ENVIRONMENT CONFIGURATION
// ============================================================================
const CONTRACT_ADDRESS = '0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2';
const FALLBACK_IMAGE_URL = 'https://gateway.irys.xyz/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR';

const RPC_ENDPOINTS: string[] = [
  process.env.ALCHEMY_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl',
  'https://mainnet.base.org',
  'https://base.llamarpc.com'
];

const PROVIDERS: JsonRpcProvider[] = RPC_ENDPOINTS.map(
  url => new JsonRpcProvider(url, 8453, { staticNetwork: true })
);

const CONTRACT_ABI: string[] = [
  'function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)'
];

// ============================================================================
// 🛡️ TYPE DEFINITIONS
// ============================================================================
interface Attribute {
  trait_type: string;
  value: string | boolean | number;
}

interface ERC721Metadata {
  name: string;
  description: string;
  image: string;
  animation_url?: string;
  external_url?: string;
  attributes: Attribute[];
}

interface NormalizedUri {
  url: string;
  txId: string | null;
}

interface OnChainDeed {
  owner: string;
  active: boolean;
  sanctified: boolean;
  front: NormalizedUri;
  back: NormalizedUri;
  video: NormalizedUri;
  dna: string;
  hidden: NormalizedUri;
}

interface ResourceResult {
  type: 'json' | 'image' | 'video' | 'none';
  payload?: any;
}

const FALLBACK_METADATA: ERC721Metadata = {
  name: 'THE IMPERIAL SOVEREIGN DEED ♠️',
  description: 'UNCOMPROMISED INTEGRITY PROTOCOL',
  image: FALLBACK_IMAGE_URL,
  attributes: [{ trait_type: 'Status', value: 'Burned / Inactive / Pending' }]
};

const STANDARD_FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Imperial-Protocol-Engine/1.0 (Vercel-Serverless-Production)',
  'Accept': 'application/json, image/*, video/*, */*'
};

// ============================================================================
// ⚙️ HARDENED UTILITIES & PARSERS
// ============================================================================

/**
 * Normalizes any raw URI format (Irys TxID, Arweave Hash, ipfs://, ar://) to canonical gateway HTTPS URL.
 */
function parseRawUri(rawUri: string | null | undefined): NormalizedUri {
  if (!rawUri) return { url: '', txId: null };
  const trimmed = rawUri.trim();
  if (!trimmed || trimmed.toUpperCase() === 'UNASSIGNED') return { url: '', txId: null };

  let txId: string | null = null;
  let url = trimmed;

  if (trimmed.length >= 43 && !trimmed.includes('://') && !trimmed.includes('/')) {
    txId = trimmed;
    url = `https://gateway.irys.xyz/${trimmed}`;
  } else if (trimmed.includes('gateway.irys.xyz/')) {
    txId = trimmed.split('gateway.irys.xyz/')[1]?.split('?')[0] || null;
  } else if (trimmed.includes('arweave.net/')) {
    txId = trimmed.split('arweave.net/')[1]?.split('?')[0] || null;
  } else if (trimmed.startsWith('ar://')) {
    txId = trimmed.replace('ar://', '');
    url = `https://arweave.net/${txId}`;
  } else if (trimmed.startsWith('ipfs://')) {
    url = `https://ipfs.io/ipfs/${trimmed.replace('ipfs://', '')}`;
  }

  return { url, txId };
}

/**
 * Line-by-Line DNA String parser for SOVEREIGN NOVA (Sanctified state).
 * Separates dynamic key-values split by pipe '|' and colon ':'.
 */
function parseDnaAttributes(dnaStr: string | null | undefined): Attribute[] {
  const attributes: Attribute[] = [];
  if (!dnaStr || typeof dnaStr !== 'string' || dnaStr.toUpperCase() === 'UNASSIGNED') return attributes;

  const cleanDna = dnaStr.includes('STRINGS MEMORY DNA :')
    ? dnaStr.split('STRINGS MEMORY DNA :')[1]
    : dnaStr;

  const segments = cleanDna.split('|');
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const traitType = trimmed.substring(0, colonIdx).trim();
      const value = trimmed.substring(colonIdx + 1).trim();
      if (traitType && value) {
        attributes.push({ trait_type: traitType, value });
      }
    } else {
      attributes.push({ trait_type: 'Data Record', value: trimmed });
    }
  }

  return attributes;
}

/**
 * Single-pass Resource Interrogator with strict AbortController timeout.
 */
async function fetchResourceOrType(uriData: NormalizedUri): Promise<ResourceResult> {
  if (!uriData.url) return { type: 'none' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);

  try {
    const fetchUrl = uriData.txId ? `https://gateway.irys.xyz/${uriData.txId}` : uriData.url;
    const response = await fetch(fetchUrl, {
      headers: STANDARD_FETCH_HEADERS,
      signal: controller.signal
    });

    if (!response.ok) return { type: 'none' };

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    if (contentType.includes('json') || fetchUrl.endsWith('.json')) {
      const payload = await response.json();
      return { type: 'json', payload };
    }
    if (contentType.includes('video') || fetchUrl.match(/\.(mp4|webm|mov)$/i)) {
      return { type: 'video' };
    }
    if (contentType.includes('image') || fetchUrl.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)) {
      return { type: 'image' };
    }

    return { type: 'none' };
  } catch {
    return { type: 'none' };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// 🛡️ CONTRACT READ WITH RPC FAILOVER & TIMEOUT
// ============================================================================
async function executeContractReadWithRetry(tokenId: bigint): Promise<OnChainDeed> {
  let lastError: Error | null = null;

  for (const provider of PROVIDERS) {
    try {
      const contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
      const callPromise = contract.getDeedData(tokenId);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('RPC Provider Timeout')), 2000)
      );

      const rawData: any = await Promise.race([callPromise, timeoutPromise]);

      return {
        owner: String(rawData[0]),
        active: Boolean(rawData[1]),
        sanctified: Boolean(rawData[2]),
        front: parseRawUri(rawData[3]),
        back: parseRawUri(rawData[4]),
        video: parseRawUri(rawData[5]),
        dna: String(rawData[6] || ''),
        hidden: parseRawUri(rawData[7])
      };
    } catch (err: any) {
      lastError = err;
    }
  }

  throw lastError || new Error('All RPC endpoints failed execution.');
}

// ============================================================================
// 🔱 SERVERLESS EXPRESS ENGINE
// ============================================================================
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// Edge Caching Middleware
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  next();
});

// Dynamic Token Metadata Endpoint
app.get('/api/metadata/:tokenId', async (req: Request, res: Response): Promise<void> => {
  const { tokenId } = req.params;
  const numericId = Number(tokenId);

  if (!/^\d+$/.test(tokenId) || numericId < 1 || numericId > 333) {
    res.status(200).json(FALLBACK_METADATA);
    return;
  }

  try {
    const deedData = await executeContractReadWithRetry(BigInt(tokenId));

    if (!deedData.active) {
      res.status(200).json(FALLBACK_METADATA);
      return;
    }

    let finalAttributes: Attribute[] = [];
    let finalImage = FALLBACK_IMAGE_URL;
    let animationUrl = deedData.video.url;
    let externalJsonPayload: any = null;
    let directImage = '';

    // Parallel Single-pass Execution for Front and Back URIs
    const [frontRes, backRes] = await Promise.all([
      fetchResourceOrType(deedData.front),
      fetchResourceOrType(deedData.back)
    ]);

    // Resolve JSON Metadata Payload (First Mint Factory Defaults)
    if (frontRes.type === 'json') externalJsonPayload = frontRes.payload;
    else if (backRes.type === 'json') externalJsonPayload = backRes.payload;

    // Resolve Video Streams
    if (!animationUrl) {
      if (backRes.type === 'video') animationUrl = deedData.back.url;
      else if (frontRes.type === 'video') animationUrl = deedData.front.url;
    }

    // Resolve Image Streams
    if (frontRes.type === 'image') directImage = deedData.front.url;
    else if (backRes.type === 'image') directImage = deedData.back.url;

    // ------------------------------------------------------------------------
    // ATTRIBUTE & MEDIA ASSEMBLY PIPELINE
    // ------------------------------------------------------------------------
    if (externalJsonPayload) {
      // Direct pass-through of Factory JSON Attributes (Contains RANK & IDENTITY STATUS)
      if (Array.isArray(externalJsonPayload.attributes)) {
        finalAttributes = [...externalJsonPayload.attributes];
      }
      if (externalJsonPayload.image) {
        finalImage = parseRawUri(externalJsonPayload.image).url;
      }
      if (externalJsonPayload.animation_url && !animationUrl) {
        animationUrl = parseRawUri(externalJsonPayload.animation_url).url;
      }
    }

    // Apply Direct Media if JSON Image is missing or Fallback
    if (directImage && finalImage === FALLBACK_IMAGE_URL) {
      finalImage = directImage;
    }

    // Append Dynamic DNA Attributes only if Sanctified (SOVEREIGN NOVA State)
    if (deedData.sanctified) {
      const dnaAttributes = parseDnaAttributes(deedData.dna);
      const existingTraits = new Set(finalAttributes.map(a => a.trait_type));

      for (const dnaAttr of dnaAttributes) {
        if (!existingTraits.has(dnaAttr.trait_type)) {
          finalAttributes.push(dnaAttr);
        }
      }
      
      // Inject Sanctified Status Marker if not present
      if (!existingTraits.has('Sanctified Status')) {
        finalAttributes.push({ trait_type: 'Sanctified Status', value: 'TRUE' });
      }
    }

    const responseMetadata: ERC721Metadata = {
      name: externalJsonPayload?.name || `THE IMPERIAL SOVEREIGN DEED ♠️ #${tokenId}`,
      description: externalJsonPayload?.description || 'IMPERIAL SOVEREIGN ARCHITECTURE - Absolute Immutable Autarkic Identity Manifest',
      image: finalImage,
      attributes: finalAttributes
    };

    if (animationUrl) responseMetadata.animation_url = animationUrl;
    if (deedData.hidden.url) {
      responseMetadata.external_url = deedData.hidden.url;
    } else if (externalJsonPayload?.external_url) {
      responseMetadata.external_url = externalJsonPayload.external_url;
    }

    res.status(200).json(responseMetadata);
  } catch (error: any) {
    console.error(`[EXECUTION ERROR] TokenID ${tokenId}:`, error.message || error);
    res.status(200).json(FALLBACK_METADATA);
  }
});

// Health Check Endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'HEALTHY', network: 'BASE MAINNET', target: CONTRACT_ADDRESS });
});

// Catch-All Handler
app.use((_req: Request, res: Response) => {
  res.status(200).json(FALLBACK_METADATA);
});

export default app;