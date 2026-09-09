import express, { Request, Response, NextFunction } from 'express';
import { Contract, JsonRpcProvider } from 'ethers';
import cors from 'cors';
import helmet from 'helmet';

// ============================================================================
// 🔥 WAR MACHINE CONFIGURATION & CONSTANTS
// ============================================================================
const CONTRACT_ADDRESS = '0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2';
const FALLBACK_IMAGE_URL = 'https://gateway.irys.xyz/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR';

const RPC_ENDPOINTS = [
  'https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl',
  'https://mainnet.base.org',
  'https://base.llamarpc.com'
];

const CONTRACT_ABI = [
  'function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)'
];

interface Attribute {
  trait_type: string;
  value: string | boolean | number;
}

const FALLBACK_METADATA = {
  name: 'THE IMPERIAL SOVEREIGN DEED ♠️',
  description: 'UNCOMPROMISED INTEGRITY PROTOCOL',
  image: FALLBACK_IMAGE_URL,
  attributes: [{ trait_type: 'Status', value: 'Burned / Inactive / Pending' }]
};

// Standard HTTP Request Headers to prevent gateway drops
const STANDARD_FETCH_HEADERS = {
  'User-Agent': 'Imperial-Protocol-Node/1.0 (Base-Mainnet-Audit-Engine)',
  'Accept': 'application/json, image/*, video/*, */*'
};

// ============================================================================
// ⚙️ UTILITIES & PARSERS (HARDENED & ZERO-DEFECT)
// ============================================================================
function normalizeUri(uri: string | null | undefined): string {
  if (!uri) return '';
  const trimmed = uri.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${trimmed.replace('ipfs://', '')}`;
  if (trimmed.startsWith('ar://')) return `https://arweave.net/${trimmed.replace('ar://', '')}`;
  return `https://gateway.irys.xyz/${trimmed}`;
}

function extractTxId(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const t = uri.trim();
  if (t.length >= 43 && !t.includes('://') && !t.includes('/')) return t;
  if (t.includes('gateway.irys.xyz/')) return t.split('gateway.irys.xyz/')[1]?.split('?')[0] || null;
  if (t.includes('arweave.net/')) return t.split('arweave.net/')[1]?.split('?')[0] || null;
  if (t.startsWith('ar://')) return t.replace('ar://', '');
  return null;
}

function getImperialRankDetailed(tokenId: bigint): string {
  const id = Number(tokenId);
  if (isNaN(id)) return 'UNKNOWN ENTITY';
  if ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50, 100].includes(id)) return 'THE COUNCIL PRIME';
  if (id >= 11 && id <= 99 && id !== 50) return 'THE GOLDEN COUNCIL';
  if (id >= 101 && id <= 200 && id !== 100) return 'THE SILVER CYPHER COUNCIL';
  if (id >= 201 && id <= 332) return 'THE RED MACHINE COUNCIL';
  if (id === 333) return 'SOVEREIGN IMMORTAL 333';
  return 'UNKNOWN ENTITY';
}

// 🧬 DNA PARSER Engine (Hardened against arbitrary colons in values)
function parseDnaAttributes(dnaStr: string | null | undefined, isSanctified: boolean, rank: string): Attribute[] {
  const attributes: Attribute[] = [];
  attributes.push({ trait_type: 'Imperial Rank', value: rank });
  attributes.push({ trait_type: 'Sanctified Status', value: isSanctified ? 'TRUE' : 'FALSE' });

  if (!dnaStr || typeof dnaStr !== 'string') return attributes;

  const segments = dnaStr.split('|');
  for (const segment of segments) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) continue;

    const colonIndex = trimmedSegment.indexOf(':');
    if (colonIndex !== -1) {
      const rawKey = trimmedSegment.substring(0, colonIndex).trim();
      const rawValue = trimmedSegment.substring(colonIndex + 1).trim();
      attributes.push({ trait_type: rawKey, value: rawValue });
    } else {
      attributes.push({ trait_type: 'Data Record', value: trimmedSegment });
    }
  }
  return attributes;
}

// 👁️ DUAL-HEMISPHERE MEDIA ENGINE (Hardened 4000ms Window)
async function interrogateServerForMediaType(url: string | null | undefined): Promise<'json' | 'image' | 'video' | 'none'> {
  if (!url) return 'none';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    // Primary Strike: HTTP HEAD
    let response = await fetch(url, {
      method: 'HEAD',
      headers: STANDARD_FETCH_HEADERS,
      signal: controller.signal
    });

    // Failsafe Strike: Range GET if Gateway rejects HEAD request
    if (!response.ok && (response.status === 405 || response.status === 403)) {
      response = await fetch(url, {
        method: 'GET',
        headers: { ...STANDARD_FETCH_HEADERS, 'Range': 'bytes=0-512' },
        signal: controller.signal
      });
    }

    if (!response.ok) return 'none';

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('json')) return 'json';
    if (contentType.includes('video')) return 'video';
    if (contentType.includes('image')) return 'image';
    return 'none';
  } catch (error: any) {
    // Gracefully handle aborted fetches without cluttering console logs
    return 'none';
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// 🛡️ CORE EXECUTIONS: RPC FAILOVER & CONCURRENT RACING
// ============================================================================
async function executeContractReadWithRetry(tokenId: bigint) {
  let lastError: Error | null = null;
  for (const rpcUrl of RPC_ENDPOINTS) {
    try {
      const provider = new JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });
      const contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

      const callPromise = contract.getDeedData(tokenId);
      const timeoutPromise = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('RPC Timeout')), 8000)
      );

      const rawData: any = await Promise.race([callPromise, timeoutPromise]);

      return {
        active: Boolean(rawData[1]),
        sanctified: Boolean(rawData[2]),
        front: normalizeUri(String(rawData[3] || '')),
        back: normalizeUri(String(rawData[4] || '')),
        video: normalizeUri(String(rawData[5] || '')),
        dna: String(rawData[6] || ''),
        hidden: normalizeUri(String(rawData[7] || ''))
      };
    } catch (err: any) {
      lastError = err;
    }
  }
  throw lastError || new Error('All RPC endpoints failed.');
}

async function fetchDynamicJsonData(uri: string) {
  if (!uri) return null;
  const txId = extractTxId(uri);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    if (txId) {
      const targetUrls = [`https://gateway.irys.xyz/${txId}`, `https://arweave.net/${txId}`];
      const fetchPromises = targetUrls.map(async (url) => {
        const response = await fetch(url, {
          headers: STANDARD_FETCH_HEADERS,
          signal: controller.signal
        });
        if (!response.ok) throw new Error('Gateway Error');
        return await response.json();
      });
      return await Promise.any(fetchPromises);
    } else {
      const response = await fetch(uri, {
        headers: STANDARD_FETCH_HEADERS,
        signal: controller.signal
      });
      if (!response.ok) throw new Error('HTTP Error');
      return await response.json();
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// 🔱 MASTER EXPRESS ENDPOINT
// ============================================================================
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  next();
});

app.get('/api/metadata/:tokenId', async (req: Request, res: Response): Promise<void> => {
  const { tokenId } = req.params;

  let parsedTokenId: bigint;
  try {
    if (!/^\d+$/.test(tokenId)) {
      res.status(200).json(FALLBACK_METADATA);
      return;
    }
    parsedTokenId = BigInt(tokenId);
    if (parsedTokenId < 1n || parsedTokenId > 333n) {
      res.status(200).json(FALLBACK_METADATA);
      return;
    }
  } catch {
    res.status(200).json(FALLBACK_METADATA);
    return;
  }

  try {
    const deedData = await executeContractReadWithRetry(parsedTokenId);

    if (!deedData.active) {
      res.status(200).json(FALLBACK_METADATA);
      return;
    }

    const rank = getImperialRankDetailed(parsedTokenId);
    let finalAttributes = parseDnaAttributes(deedData.dna, deedData.sanctified, rank);
    let finalImage = FALLBACK_IMAGE_URL;
    let animationUrl = '';
    let jsonUri = '';
    let directImage = '';

    // ========================================================================
    // 🧠 DUAL-HEMISPHERE MEDIA ENGINE
    // ========================================================================
    if (!deedData.sanctified) {
      // 🛡️ BRANCH FALSE (First Mint / Sovereign Rebirth)
      jsonUri = deedData.front;

      if (deedData.video) animationUrl = deedData.video;

      if (deedData.back) {
        const typeBack = await interrogateServerForMediaType(deedData.back);
        if (typeBack === 'video') {
          animationUrl = deedData.back;
        } else if (typeBack === 'image') {
          directImage = deedData.back;
        } else if (typeBack === 'json' && !jsonUri) {
          jsonUri = deedData.back;
        }
      }
    } else {
      // 👁️ BRANCH TRUE (Sanctified / Update Identity State)
      const [typeFront, typeBack, typeVideo] = await Promise.all([
        interrogateServerForMediaType(deedData.front),
        interrogateServerForMediaType(deedData.back),
        interrogateServerForMediaType(deedData.video)
      ]);

      if (typeVideo === 'video') animationUrl = deedData.video;
      else if (typeBack === 'video') animationUrl = deedData.back;
      else if (typeFront === 'video') animationUrl = deedData.front;

      if (typeFront === 'json') jsonUri = deedData.front;
      else if (typeBack === 'json') jsonUri = deedData.back;

      if (typeFront === 'image') directImage = deedData.front;
      else if (typeBack === 'image') directImage = deedData.back;
    }

    // ========================================================================
    // 🛠️ JSON PAYLOAD ASSEMBLY & MARKETPLACE FORMATTING
    // ========================================================================
    if (jsonUri) {
      const externalData = await fetchDynamicJsonData(jsonUri);
      if (externalData) {
        if (externalData.image) finalImage = normalizeUri(externalData.image);
        if (externalData.animation_url) animationUrl = normalizeUri(externalData.animation_url);
        if (externalData.attributes && Array.isArray(externalData.attributes)) {
          finalAttributes = [...finalAttributes, ...externalData.attributes];
        }
      }
    }

    if (directImage && finalImage === FALLBACK_IMAGE_URL) {
      finalImage = directImage;
    }

    const responseMetadata: Record<string, any> = {
      name: `THE IMPERIAL SOVEREIGN DEED ♠️ #${parsedTokenId.toString()}`,
      description: 'IMPERIAL SOVEREIGN ARCHITECTURE - Absolute Immutable Autarkic Identity Manifest',
      image: finalImage,
      attributes: finalAttributes
    };

    if (animationUrl) responseMetadata.animation_url = animationUrl;
    if (deedData.hidden) responseMetadata.external_url = deedData.hidden;

    res.status(200).json(responseMetadata);
  } catch (error: any) {
    console.error(`[EXECUTION ERROR] TokenID ${tokenId}:`, error.message || error);
    res.status(200).json(FALLBACK_METADATA);
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'HEALTHY', network: 'BASE MAINNET', target: CONTRACT_ADDRESS });
});

app.use((_req: Request, res: Response) => {
  res.status(200).json(FALLBACK_METADATA);
});

export default app;