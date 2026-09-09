import express, { Request, Response } from 'express';
import { Contract, JsonRpcProvider, ZeroAddress } from 'ethers';
import cors from 'cors';
import helmet from 'helmet';

// ============================================================================
// 🔱 CONSTANTS & INFRASTRUCTURE TARGETS
// ============================================================================
const CONTRACT_ADDRESS = '0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2';
const FALLBACK_IMAGE_URL = 'https://gateway.irys.xyz/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR';
const MAX_SUPPLY = 333;

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

const memoryCache = new Map<string, InterrogatedResource>();

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

interface OnChainDeed {
  owner: string;
  active: boolean;
  sanctified: boolean;
  front: string;
  back: string;
  video: string;
  dna: string;
  hidden: string;
  tbaAddress: string;
}

interface InterrogatedResource {
  type: 'json' | 'image' | 'video' | 'unknown';
  payload?: any;
}

const FALLBACK_METADATA: ERC721Metadata = {
  name: 'THE IMPERIAL SOVEREIGN DEED ♠️',
  description: 'UNCOMPROMISED INTEGRITY PROTOCOL',
  image: FALLBACK_IMAGE_URL,
  attributes: [{ trait_type: 'Status', value: 'Burned / Inactive / Pending' }]
};

const STANDARD_FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Imperial-Protocol-Engine/1.0 (Serverless-Production)',
  'Accept': 'application/json, image/*, video/*, */*'
};

// ============================================================================
// ⚙️ HARDENED UTILITIES & PARSERS
// ============================================================================

function parseRawUri(rawUri: string | null | undefined): string {
  if (!rawUri) return '';
  const trimmed = rawUri.trim();
  if (!trimmed) return '';

  if (trimmed.length >= 43 && !trimmed.includes('://') && !trimmed.includes('/')) {
    return `https://gateway.irys.xyz/${trimmed}`;
  }
  if (trimmed.startsWith('ar://')) {
    return `https://arweave.net/${trimmed.replace('ar://', '')}`;
  }
  if (trimmed.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${trimmed.replace('ipfs://', '')}`;
  }
  return trimmed;
}

function parseDnaAttributes(dnaStr: string | null | undefined): Attribute[] {
  const attributes: Attribute[] = [];
  if (!dnaStr || typeof dnaStr !== 'string') return attributes;

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

async function interrogateResource(url: string): Promise<InterrogatedResource> {
  if (!url) return { type: 'unknown' };

  if (memoryCache.has(url)) {
    return memoryCache.get(url)!;
  }

  try {
    const response = await fetch(url, {
      headers: STANDARD_FETCH_HEADERS,
      signal: AbortSignal.timeout(3000)
    });

    if (!response.ok) return { type: 'unknown' };

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    let result: InterrogatedResource = { type: 'unknown' };

    // 🛡️ ZERO-GUESSWORK: บังคับลอง Parse JSON เสมอเพื่อแก้ปัญหา Irys Octet-stream
    if (!contentType.includes('image') && !contentType.includes('video')) {
      try {
        const clone = response.clone();
        const payload = await clone.json();
        result = { type: 'json', payload };
      } catch {
        // ไม่ใช่ JSON ปล่อยผ่านไปเช็คเงื่อนไขอื่น
      }
    }

    if (result.type === 'unknown') {
      if (contentType.includes('video') || url.match(/\.(mp4|webm|mov)$/i)) {
        result = { type: 'video' };
      } else if (contentType.includes('image') || url.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)) {
        result = { type: 'image' };
      }
    }

    if (result.type !== 'unknown') {
      memoryCache.set(url, result);
    }

    return result;
  } catch {
    return { type: 'unknown' };
  }
}

async function fetchOnChainStateWithFailover(tokenId: bigint): Promise<OnChainDeed | null> {
  for (const provider of PROVIDERS) {
    try {
      const contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
      
      // 🛡️ HARDENED: ใช้ Promise.all โดยไม่มี Race Timeout ที่ทำให้เกิด Memory Leak
      // ปล่อยให้ Ethers.js จัดการ Timeout ตามมาตรฐานของมันเอง
      const [rawData, tbaAddress]: any = await Promise.all([
        contract.getDeedData(tokenId),
        contract.getTBA(tokenId)
      ]);

      return {
        owner: String(rawData[0]),
        active: Boolean(rawData[1]),
        sanctified: Boolean(rawData[2]),
        front: parseRawUri(rawData[3]),
        back: parseRawUri(rawData[4]),
        video: parseRawUri(rawData[5]),
        dna: String(rawData[6] || ''),
        hidden: parseRawUri(rawData[7]),
        tbaAddress: String(tbaAddress || ZeroAddress)
      };
    } catch (error) {
      console.error(`[RPC FAILOVER] Provider failed for Token ${tokenId}`);
      continue;
    }
  }
  return null;
}

// ============================================================================
// 🔱 SERVERLESS EXPRESS ENGINE
// ============================================================================
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/api/metadata/:tokenId', async (req: Request, res: Response): Promise<void> => {
  // 🛡️ ZERO-DEFECT: สกัดเอาเฉพาะตัวเลข ตัด .json ทิ้งอย่างเด็ดขาด
  const rawTokenId = req.params.tokenId;
  const cleanTokenIdStr = rawTokenId.replace(/\.json$/, '');

  // 🛡️ BOUNDARY CHECK: ต้องเป็นตัวเลข และอยู่ระหว่าง 1 ถึง 333 เท่านั้น
  if (!/^\d+$/.test(cleanTokenIdStr)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).json(FALLBACK_METADATA);
    return;
  }

  const tokenIdNum = parseInt(cleanTokenIdStr, 10);
  if (tokenIdNum < 1 || tokenIdNum > MAX_SUPPLY) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).json(FALLBACK_METADATA);
    return;
  }

  try {
    const deedData = await fetchOnChainStateWithFailover(BigInt(tokenIdNum));

    if (!deedData || !deedData.active) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.status(200).json(FALLBACK_METADATA);
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');

    const [frontInfo, backInfo] = await Promise.all([
      interrogateResource(deedData.front),
      interrogateResource(deedData.back)
    ]);

    let staticPayload: any = null;
    if (frontInfo.type === 'json') staticPayload = frontInfo.payload;
    else if (backInfo.type === 'json') staticPayload = backInfo.payload;

    const traitMap = new Map<string, any>();

    if (staticPayload && Array.isArray(staticPayload.attributes)) {
      staticPayload.attributes.forEach((attr: Attribute) => {
        if (attr?.trait_type && attr?.value !== undefined) {
          traitMap.set(attr.trait_type, attr.value);
        }
      });
    }

    if (deedData.tbaAddress && deedData.tbaAddress !== ZeroAddress) {
      traitMap.set('Token Bound Account (TBA)', deedData.tbaAddress);
    }

    if (deedData.sanctified) {
      const dnaAttributes = parseDnaAttributes(deedData.dna);
      dnaAttributes.forEach(attr => traitMap.set(attr.trait_type, attr.value));
      traitMap.set('Sanctified Status', 'TRUE');
    }

    const finalAttributes: Attribute[] = Array.from(traitMap, ([trait_type, value]) => ({ trait_type, value }));

    let finalImage = parseRawUri(staticPayload?.image);
    if (!finalImage) {
      if (frontInfo.type === 'image') finalImage = deedData.front;
      else if (backInfo.type === 'image') finalImage = deedData.back;
      else finalImage = FALLBACK_IMAGE_URL;
    }

    let finalAnimationUrl = parseRawUri(staticPayload?.animation_url);
    if (!finalAnimationUrl) {
      if (deedData.video) finalAnimationUrl = deedData.video;
      else if (backInfo.type === 'video') finalAnimationUrl = deedData.back;
      else if (frontInfo.type === 'video') finalAnimationUrl = deedData.front;
    }

    const responseMetadata: ERC721Metadata = {
      name: staticPayload?.name || `THE IMPERIAL SOVEREIGN DEED ♠️ #${tokenIdNum}`,
      description: staticPayload?.description || 'IMPERIAL SOVEREIGN ARCHITECTURE',
      image: finalImage,
      attributes: finalAttributes
    };

    if (finalAnimationUrl) responseMetadata.animation_url = finalAnimationUrl;
    if (deedData.hidden) responseMetadata.external_url = deedData.hidden;

    res.status(200).json(responseMetadata);
  } catch (error: any) {
    console.error(`[EXECUTION ERROR] TokenID ${tokenIdNum}:`, error.message || error);
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