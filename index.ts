import express, { Request, Response, NextFunction } from 'express';
import { Contract, JsonRpcProvider } from 'ethers';
import cors from 'cors';
import helmet from 'helmet';


// ============================================================================
// 🔱 การกำหนดค่าและค่าคงที่บนบล็อกเชน (CONFIGURATION & ON-CHAIN CONSTANTS)
// ============================================================================
const CONTRACT_ADDRESS = '0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2';
const MASTER_IMAGE_FALLBACK = 'https://gateway.irys.xyz/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR';

const RPC_ENDPOINTS: string[] = [
  'https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl',
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
// 🛡️ การระบุชนิดข้อมูลอย่างเข้มงวด (STRICT TYPE DEFINITIONS)
// ============================================================================
export interface Attribute {
  trait_type: string;
  value: string | boolean | number;
}

export interface OpenSeaMetadata {
  name: string;
  description: string;
  image: string;
  animation_url?: string;
  external_url?: string;
  attributes: Attribute[];
}

export interface NormalizedUri {
  url: string;
  txId: string | null;
}

export interface OnChainDeed {
  owner: string;
  active: boolean;
  sanctified: boolean;
  front: NormalizedUri;
  back: NormalizedUri;
  video: NormalizedUri;
  dna: string;
  hidden: NormalizedUri;
}

export interface StateUpdatePayload {
  tokenId: string;
  frontTxId?: string;
  backTxId?: string;
}

// แคชดัชนีซิงค์สถานะในหน่วยความจำ (มอดูล 4)
const DEED_STATE_INDEX = new Map<string, OnChainDeed>();

// ============================================================================
// ⚡ มอดูล 1: SOVEREIGN REBIRTH (RANK RESOLVER)
// ============================================================================
function resolveRankTier(tokenId: bigint): string {
  if (tokenId >= 1n && tokenId <= 3n) return 'PRIME';
  if (tokenId >= 4n && tokenId <= 33n) return 'GOLDEN';
  if (tokenId >= 34n && tokenId <= 100n) return 'SILVER CYPHER';
  if (tokenId >= 101n && tokenId <= 250n) return 'THE RED MACHINE';
  return 'IMMORTAL 333';
}

// ============================================================================
// ⚡ มอดูล 2: SOVEREIGN NOVA (STRING PARSING ENGINE)
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

/**
 * แยกแยะข้อความ DNA ดิบจาก Smart Contract ให้เป็นโครงสร้าง Attributes สำหรับ Marketplace
 * ตัวอย่างข้อมูลขาเข้า: "SOVEREIGN NOVA : STRINGS MEMORY DNA : IDENTITY DNA : SAKSIT | PIXEL ANCHOR : X : 1014 , Y : 1754 | CHRONO-MAP : SANCTIFIED AT 12S FR 1-5"
 */
export function parseSovereignNovaDna(rawDna: string | null | undefined): Attribute[] {
  if (!rawDna || typeof rawDna !== 'string') return [];
  
  // ลบ Prefix หัวเรื่องออกโดยอัตโนมัติ
  const cleanString = rawDna
    .replace(/^SOVEREIGN\s+NOVA\s*:\s*/i, '')
    .replace(/^STRINGS\s+MEMORY\s+DNA\s*:\s*/i, '')
    .trim();

  if (!cleanString || cleanString.toUpperCase() === 'UNASSIGNED') return [];

  const attributes: Attribute[] = [];
  const segments = cleanString.split('|');

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.substring(0, colonIndex).trim();
    let value = trimmed.substring(colonIndex + 1).trim();

    if (!key) continue;

    // ปรับรูปแบบ Spatial Anchor ให้เป็นมาตรฐาน: "X : 1014 , Y : 1754" -> "X: 1014, Y: 1754"
    if (key === 'PIXEL ANCHOR') {
      value = value.replace(/\s*:\s*/g, ': ').replace(/\s*,\s*/g, ', ');
    }

    attributes.push({
      trait_type: key,
      value: value
    });
  }

  return attributes;
}

// ============================================================================
// 🛡️ เอนจิน GATEWAY RACE
// ============================================================================
async function raceGateways(txId: string | null, fallbackUrl: string): Promise<{ url: string; contentType: string }> {
  const targetTx = txId || fallbackUrl;
  if (!targetTx) return { url: '', contentType: 'unknown' };

  const irysUrl = targetTx.startsWith('http') ? targetTx : `https://gateway.irys.xyz/${targetTx}`;
  const arweaveUrl = targetTx.startsWith('http') ? targetTx : `https://arweave.net/${targetTx}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);

  try {
    const winner = await Promise.any([
      fetch(irysUrl, { method: 'HEAD', signal: controller.signal }).then(r => r.ok ? { res: r, url: irysUrl } : Promise.reject()),
      fetch(arweaveUrl, { method: 'HEAD', signal: controller.signal }).then(r => r.ok ? { res: r, url: arweaveUrl } : Promise.reject())
    ]);

    const contentType = (winner.res.headers.get('content-type') || '').toLowerCase();
    return { url: winner.url, contentType };
  } catch {
    return { url: irysUrl, contentType: 'unknown' };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// 🛡️ การอ่านข้อมูลสัญญาพร้อมระบบ FAILOVER
// ============================================================================
async function executeContractReadWithRetry(tokenId: bigint): Promise<OnChainDeed> {
  let lastError: Error | null = null;

  for (const provider of PROVIDERS) {
    try {
      const contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
      const rawData: any = await Promise.race([
        contract.getDeedData(tokenId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RPC_TIMEOUT')), 2500))
      ]);

      return {
        owner: String(rawData[0] ?? ''),
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

  throw lastError || new Error('ALL_RPC_ENDPOINTS_FAILED');
}

// ============================================================================
// 🔱 ตัวจัดการเส้นทางเซิร์ฟเวอร์ (SERVER ROUTER)
// ============================================================================
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  next();
});

// ----------------------------------------------------------------------------
// เส้นทาง METADATA (มอดูล 1 และ มอดูล 2)
// ----------------------------------------------------------------------------
app.get('/api/metadata/:tokenId', async (req: Request, res: Response): Promise<void> => {
  try {
    const rawTokenParam = (req.params.tokenId || '').replace(/\.json$/, '');

    if (!/^\d+$/.test(rawTokenParam)) {
      res.status(400).json({ error: 'INVALID_TOKEN_ID', message: 'Token ID must be a non-negative integer.' });
      return;
    }

    const numericId = BigInt(rawTokenParam);
    const deedData = await executeContractReadWithRetry(numericId);

    // มอดูล 4: อัปเดตแคชในหน่วยความจำ
    DEED_STATE_INDEX.set(rawTokenParam, deedData);

    // ตรวจสอบสถานะการเผา (Burn) / ไม่ใช้งาน (Inactive)
    if (!deedData.active) {
      const inactiveMetadata: OpenSeaMetadata = {
        name: `THE IMPERIAL SOVEREIGN DEED ♠️ #${rawTokenParam}`,
        description: 'UNCOMPROMISED INTEGRITY PROTOCOL',
        image: MASTER_IMAGE_FALLBACK,
        attributes: []
      };
      res.status(200).json(inactiveMetadata);
      return;
    }

    const [frontRace, backRace] = await Promise.all([
      deedData.front.url ? raceGateways(deedData.front.txId, deedData.front.url) : Promise.resolve(null),
      deedData.back.url ? raceGateways(deedData.back.txId, deedData.back.url) : Promise.resolve(null)
    ]);

    let externalJsonPayload: any = null;

    if (frontRace?.contentType.includes('application/json') && frontRace.url) {
      const c = new AbortController();
      const timeoutId = setTimeout(() => c.abort(), 2000);
      try {
        const jsonRes = await fetch(frontRace.url, { signal: c.signal });
        if (jsonRes.ok) externalJsonPayload = await jsonRes.json();
      } catch {
        // สำรองใช้สถานะบนเชน
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // รวบรวม Attributes
    const attributes: Attribute[] = Array.isArray(externalJsonPayload?.attributes) ? externalJsonPayload.attributes : [];

    // มอดูล 1: เพิ่ม Attribute สำหรับ Rank
    const rankTier = resolveRankTier(numericId);
    if (!attributes.some(a => a.trait_type === 'Rank')) {
      attributes.unshift({ trait_type: 'Rank', value: rankTier });
    }

    // มอดูล 2: วิเคราะห์ข้อความ DNA บนเชน
    if (deedData.sanctified && deedData.dna) {
      const parsedDnaAttrs = parseSovereignNovaDna(deedData.dna);
      const existingTraits = new Set(attributes.map(a => a.trait_type));
      for (const dnaAttr of parsedDnaAttrs) {
        if (!existingTraits.has(dnaAttr.trait_type)) {
          attributes.push(dnaAttr);
        }
      }
    }

    // รวบรวม Metadata ขั้นสุดท้าย
    const metadata: OpenSeaMetadata = {
      name: externalJsonPayload?.name || `THE IMPERIAL SOVEREIGN DEED ♠️ #${rawTokenParam}`,
      description: externalJsonPayload?.description || 'UNCOMPROMISED INTEGRITY PROTOCOL',
      image: externalJsonPayload?.image
        ? parseRawUri(externalJsonPayload.image).url
        : (frontRace?.url || deedData.front.url || MASTER_IMAGE_FALLBACK),
      attributes
    };

    // แนบ Video / Media
    if (deedData.video.url) {
      metadata.animation_url = deedData.video.url;
    } else if (externalJsonPayload?.animation_url) {
      metadata.animation_url = parseRawUri(externalJsonPayload.animation_url).url;
    }

    // แนบ URL ที่ซ่อนอยู่ (Hidden URL)
    if (deedData.hidden.url) {
      metadata.external_url = deedData.hidden.url;
    } else if (backRace?.url) {
      metadata.external_url = backRace.url;
    } else if (deedData.back.url) {
      metadata.external_url = deedData.back.url;
    }

    res.status(200).json(metadata);

  } catch (error: any) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.status(502).json({
      error: 'ON_CHAIN_READ_FAILED',
      message: error?.message || 'Failed to read transaction state from Base RPC endpoints.'
    });
  }
});

// ----------------------------------------------------------------------------
// มอดูล 3: UPDATE IDENTITY (ตัวจัดการการเปลี่ยนแปลงสถานะ)
// ----------------------------------------------------------------------------
app.post('/api/sync/update', (req: Request, res: Response): void => {
  const body: StateUpdatePayload = req.body;

  if (!body || !body.tokenId || !/^\d+$/.test(body.tokenId)) {
    res.status(400).json({ error: 'INVALID_PAYLOAD', message: 'Valid tokenId is required.' });
    return;
  }

  const existingState = DEED_STATE_INDEX.get(body.tokenId);
  if (!existingState) {
    res.status(444).json({ error: 'CACHE_MISS', message: 'Token must be indexed via GET /api/metadata first.' });
    return;
  }

  if (body.frontTxId) {
    existingState.front = parseRawUri(body.frontTxId);
  }
  if (body.backTxId) {
    existingState.back = parseRawUri(body.backTxId);
  }

  DEED_STATE_INDEX.set(body.tokenId, existingState);

  res.status(200).json({
    status: 'MUTATED',
    tokenId: body.tokenId,
    updatedFront: existingState.front.url,
    updatedBack: existingState.back.url
  });
});

// ----------------------------------------------------------------------------
// มอดูล 4: SOVEREIGN REMINT (ตัวทำดัชนีซิงค์ข้อมูล)
// ----------------------------------------------------------------------------
app.get('/api/deeds/:tokenId/sync', async (req: Request, res: Response): Promise<void> => {
  const rawTokenParam = req.params.tokenId;

  if (!/^\d+$/.test(rawTokenParam)) {
    res.status(400).json({ error: 'INVALID_TOKEN_ID', message: 'Token ID must be a non-negative integer.' });
    return;
  }

  try {
    const numericId = BigInt(rawTokenParam);
    const deedData = await executeContractReadWithRetry(numericId);

    DEED_STATE_INDEX.set(rawTokenParam, deedData);

    res.status(200).json({
      tokenId: rawTokenParam,
      owner: deedData.owner,
      active: deedData.active,
      sanctified: deedData.sanctified,
      frontUri: deedData.front.url,
      backUri: deedData.back.url,
      videoUrl: deedData.video.url,
      hiddenUrl: deedData.hidden.url,
      dna: deedData.dna
    });
  } catch (error: any) {
    res.status(502).json({ error: 'SYNC_FAILED', message: error?.message || 'RPC synchronization error.' });
  }
});

// ตรวจสอบการทำงานของระบบ (Health Check)
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'HEALTHY', network: 'BASE MAINNET', target: CONTRACT_ADDRESS });
});

// จัดการกรณีไม่พบเส้นทาง (404 Route handling)
app.use((_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.status(404).json({ error: 'ENDPOINT_NOT_FOUND' });
});

export default app;
