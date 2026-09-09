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
  'function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)',
  'function getTBA(uint256 t) external view returns (address)'
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
  tbaAddress: string;
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
// 🛡️ CONTRACT READ WITH RPC FAILOVER & TIMEOUT (PARALLEL EXECUTION)
// ============================================================================
async function executeContractReadWithRetry(tokenId: bigint): Promise<OnChainDeed> {
  let lastError: Error | null = null;

  for (const provider of PROVIDERS) {
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
      
      const callPromise = Promise.all([
        contract.getDeedData(tokenId),
        contract.getTBA(tokenId)
      ]);
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('RPC Provider Timeout')), 2000);
      });

      const [rawData, tbaAddress]: any = await Promise.race([callPromise, timeoutPromise]);

      return {
        owner: String(rawData[0]),
        active: Boolean(rawData[1]),
        sanctified: Boolean(rawData[2]),
        front: parseRawUri(rawData[3]),
        back: parseRawUri(rawData[4]),
        video: parseRawUri(rawData[5]),
        dna: String(rawData[6] || ''),
        hidden: parseRawUri(rawData[7]),
        tbaAddress: String(tbaAddress || '0x0000000000000000000000000000000000000000')
      };
    } catch (err: any) {
      lastError = err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
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

app.get('/api/metadata/:tokenId', async (req: Request, res: Response): Promise<void> => {
  const { tokenId } = req.params;
  const numericId = Number(tokenId);

  if (!/^\d{1,3}$/.test(tokenId) || numericId < 1 || numericId > 333) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).json(FALLBACK_METADATA);
    return;
  }

  try {
    const deedData = await executeContractReadWithRetry(BigInt(tokenId));

    if (!deedData.active) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.status(200).json(FALLBACK_METADATA);
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');

    let finalAttributes: Attribute[] = [];
    let finalImage = FALLBACK_IMAGE_URL;
    let animationUrl = deedData.video.url;
    let externalJsonPayload: any = null;
    let directImage = '';

    // ------------------------------------------------------------------------
    // 🛡️ ABSTRACT GOVERNANCE & SILENT POWER MAPPING (REGULATORY SAFE)
    // ------------------------------------------------------------------------
    const isCouncil = (numericId >= 1 && numericId <= 10) || numericId === 50 || numericId === 100;
    const isTierZero = numericId >= 1 && numericId <= 10;
    const isInherentlySanctified = isCouncil || numericId === 333;
    
    const finalSanctifiedState = deedData.sanctified || isInherentlySanctified;

    if (isCouncil) {
      finalAttributes.push({ trait_type: 'Council Status', value: 'Active Council' });
    }
    
    // Abstract Power Injection (No Financial Terms)
    if (isTierZero) {
      finalAttributes.push({ trait_type: 'SOVEREIGN ACCESS', value: 'TIER-0' });
      finalAttributes.push({ trait_type: 'COUNCIL PRIVILEGE', value: 'FULL INTEGRITY' });
    } else if (numericId === 50 || numericId === 100) {
      finalAttributes.push({ trait_type: 'SOVEREIGN ACCESS', value: 'TIER-1' });
      finalAttributes.push({ trait_type: 'COUNCIL PRIVILEGE', value: 'GOVERNANCE ONLY' });
    } else {
      finalAttributes.push({ trait_type: 'SOVEREIGN ACCESS', value: 'STANDARD' });
    }

    if (deedData.tbaAddress && deedData.tbaAddress !== '0x0000000000000000000000000000000000000000') {
      finalAttributes.push({ trait_type: 'Token Bound Account (TBA)', value: deedData.tbaAddress });
    }

    // ------------------------------------------------------------------------
    // MEDIA & JSON RESOLUTION PIPELINE
    // ------------------------------------------------------------------------
    const [frontRes, backRes] = await Promise.all([
      fetchResourceOrType(deedData.front),
      fetchResourceOrType(deedData.back)
    ]);

    if (frontRes.type === 'json') externalJsonPayload = frontRes.payload;
    else if (backRes.type === 'json') externalJsonPayload = backRes.payload;

    if (!animationUrl) {
      if (backRes.type === 'video') animationUrl = deedData.back.url;
      else if (frontRes.type === 'video') animationUrl = deedData.front.url;
    }

    if (frontRes.type === 'image') directImage = deedData.front.url;
    else if (backRes.type === 'image') directImage = deedData.back.url;

    // ------------------------------------------------------------------------
    // ATTRIBUTE ASSEMBLY & DEDUPLICATION
    // ------------------------------------------------------------------------
    const traitMap = new Map<string, any>();
    
    finalAttributes.forEach(attr => traitMap.set(attr.trait_type, attr.value));

    if (externalJsonPayload && Array.isArray(externalJsonPayload.attributes)) {
      externalJsonPayload.attributes.forEach((attr: Attribute) => {
        // Filter out any accidental financial terms from external JSON just in case
        const safeTrait = attr.trait_type.toUpperCase();
        if (!safeTrait.includes('DIVIDEND') && !safeTrait.includes('REVENUE') && !safeTrait.includes('YIELD')) {
          if (!traitMap.has(attr.trait_type)) {
            traitMap.set(attr.trait_type, attr.value);
          }
        }
      });
      if (externalJsonPayload.image) finalImage = parseRawUri(externalJsonPayload.image).url;
      if (externalJsonPayload.animation_url && !animationUrl) animationUrl = parseRawUri(externalJsonPayload.animation_url).url;
    }

    if (directImage && finalImage === FALLBACK_IMAGE_URL) {
      finalImage = directImage;
    }

    if (finalSanctifiedState) {
      const dnaAttributes = parseDnaAttributes(deedData.dna);
      dnaAttributes.forEach(attr => traitMap.set(attr.trait_type, attr.value));
      traitMap.set('Sanctified Status', 'TRUE');
    }

    const resolvedAttributes: Attribute[] = Array.from(traitMap, ([trait_type, value]) => ({ trait_type, value }));

    const responseMetadata: ERC721Metadata = {
      name: externalJsonPayload?.name || `THE IMPERIAL SOVEREIGN DEED ♠️ #${tokenId}`,
      description: externalJsonPayload?.description || 'IMPERIAL SOVEREIGN ARCHITECTURE - Absolute Immutable Autarkic Identity Manifest',
      image: finalImage,
      attributes: resolvedAttributes
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
    // เปลี่ยนสถานะเป็น 500 เพื่อป้องกัน Marketplace จดจำ Fallback เป็นข้อมูลถาวร
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(500).json({ error: 'TEMPORARY_NETWORK_FAILURE', message: 'RPC Failover Exhausted' });
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'HEALTHY', network: 'BASE MAINNET', target: CONTRACT_ADDRESS });
});

app.use((_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json(FALLBACK_METADATA);
});

export default app;