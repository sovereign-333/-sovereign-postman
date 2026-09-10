import express, { Request, Response, NextFunction } from 'express';
import { Contract, JsonRpcProvider } from 'ethers';
import cors from 'cors';
import helmet from 'helmet';

const CONTRACT_ADDRESS = '0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2';
const FALLBACK_IMAGE_URL = 'https://gateway.irys.xyz/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR';

// Hard Code Alchemy ตามสั่ง ไม่ใช้ ENV
const RPC_ENDPOINTS: string[] = [
  'https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl',
  'https://mainnet.base.org',
  'https://base.llamarpc.com'
];

const PROVIDERS: JsonRpcProvider[] = RPC_ENDPOINTS.map(
  url => new JsonRpcProvider(url, 8453, { staticNetwork: true })
);

const CONTRACT_ABI = [
  'function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)'
];

const FALLBACK_METADATA = {
  name: 'THE IMPERIAL SOVEREIGN DEED ♠️',
  description: 'UNCOMPROMISED INTEGRITY PROTOCOL',
  image: FALLBACK_IMAGE_URL,
  attributes: [{ trait_type: 'Status', value: 'Burned / Inactive / Pending' }]
};

function parseDnaAttributes(dnaStr: string | null | undefined): any[] {
  const attributes: any[] = [];
  if (!dnaStr || typeof dnaStr !== 'string' || dnaStr.toUpperCase() === 'UNASSIGNED') return attributes;

  const cleanDna = dnaStr.replace(/^.*?STRINGS\s+MEMORY\s+DNA\s*:\s*/i, '').trim();
  const segments = cleanDna.split('|');
  
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      let key = trimmed.substring(0, colonIdx).trim();
      let val = trimmed.substring(colonIdx + 1).trim();
      
      if (key.toUpperCase() === 'PIXEL ANCHOR') {
        val = val.replace(/\s*:\s*/g, ': ').replace(/\s*,\s*/g, ', ');
      }
      attributes.push({ trait_type: key, value: val });
    }
  }
  return attributes;
}

// ยิง Fetch ตรงๆ ด้วย URL ที่ได้มาจาก Smart Contract
async function fetchJsonPayload(url: string): Promise<any> {
  if (!url || url.trim() === '' || url.toUpperCase() === 'UNASSIGNED') return null;
  
  // จัดการเผื่อกรณีใส่ลิงก์มาไม่ครบ แต่เน้นใช้ URL เดิมเป็นหลัก
  const fetchUrl = url.startsWith('http') ? url : `https://${url.replace(/^ar:\/\//, 'gateway.irys.xyz/')}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(fetchUrl, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchMetadataOrAsset(url: string): Promise<{ type: 'json' | 'media' | 'unknown'; data: any }> {
  if (!url || url.trim() === '' || url.toUpperCase() === 'UNASSIGNED') return { type: 'unknown', data: null };

  const targetUrl = url.startsWith('http') ? url : `https://${url.replace(/^ar:\/\//, 'gateway.irys.xyz/')}`;
  const backupUrl = targetUrl.replace('gateway.irys.xyz', 'arweave.net'); // หรือ Gateway สำรอง

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    // ยิง 2 Gateway พร้อมกัน ใครมาก่อนเอาตัวนั้น (Race)
    const fetchWithTimeout = async (endpoint: string) => {
      const res = await fetch(endpoint, { method: 'HEAD', signal: controller.signal });
      if (!res.ok) throw new Error('Not OK');
      return {
        contentType: res.headers.get('content-type') || '',
        url: endpoint.replace('/HEAD', '') // ถ้าใช้ HEAD บางเกตเวย์ไม่รองรับ ให้สลับมาใช้ GET แบบ Range หรือระมัดระวังเรื่อง Method
      };
    };

    // ใช้ GET แบบขอแค่ Header หรือเช็กนามสกุล/Content-Type เบื้องต้น
    const raceResult: any = await Promise.race([
      fetch(targetUrl, { method: 'GET', headers: { Range: 'bytes=0-512' }, signal: controller.signal }),
      fetch(backupUrl, { method: 'GET', headers: { Range: 'bytes=0-512' }, signal: controller.signal })
    ]);

    clearTimeout(timeoutId);
    
    const contentType = raceResult.headers.get('content-type') || '';
    const finalUrl = raceResult.url || targetUrl;

    if (contentType.includes('application/json')) {
      const fullRes = await fetch(finalUrl);
      const json = await fullRes.json();
      return { type: 'json', data: json };
    } else {
      // ถ้าเป็น Video หรือ Image ส่ง URL ตรงไปเลย ไม่ต้องโหลดก้อนข้อมูล
      return { type: 'media', data: finalUrl };
    }

  } catch {
    clearTimeout(timeoutId);
    return { type: 'unknown', data: targetUrl }; // Fallback ส่ง URL ดิบไปตามทรง
  }
}


async function executeContractReadWithRetry(tokenId: bigint): Promise<any> {
  let lastError: Error | null = null;
  for (const provider of PROVIDERS) {
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
      const rawData: any = await Promise.race([
        contract.getDeedData(tokenId),
        new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('RPC_TIMEOUT')), 2500); })
      ]);
      return {
        owner: String(rawData[0] ?? ''), 
        active: Boolean(rawData[1]), 
        sanctified: Boolean(rawData[2]),
        front: String(rawData[3] || '').trim(), 
        back: String(rawData[4] || '').trim(), 
        video: String(rawData[5] || '').trim(),
        dna: String(rawData[6] || '').trim(), 
        hidden: String(rawData[7] || '').trim()
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
  throw lastError || new Error('ALL_RPC_FAILED');
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  next();
});

app.get('/api/metadata/:tokenId', async (req: Request, res: Response): Promise<void> => {
  const cleanTokenIdStr = (req.params.tokenId || '').replace(/\.json$/, '');
  
  if (!/^\d+$/.test(cleanTokenIdStr)) { res.status(200).json(FALLBACK_METADATA); return; }
  const numericId = BigInt(cleanTokenIdStr);
  if (numericId < 1n || numericId > 333n) { res.status(200).json(FALLBACK_METADATA); return; }

  try {
    const deedData = await executeContractReadWithRetry(numericId);

    if (!deedData.active || deedData.owner === '0x0000000000000000000000000000000000000000') {
      res.status(200).json({
        name: `THE IMPERIAL SOVEREIGN DEED ♠️ #${cleanTokenIdStr} (Burned)`,
        description: 'This deed has been returned to the reserve.',
        image: FALLBACK_IMAGE_URL,
        attributes: [{ trait_type: 'Status', value: 'Burned / Inactive / Pending' }]
      });
      return;
    }

    let finalMetadata: any = {};

    // 1. Pass-Through: โยน URL หน้าดื้อๆ เข้าไป Fetch เลย
    if (deedData.front && deedData.front.toUpperCase() !== 'UNASSIGNED') {
      const jsonPayload = await fetchJsonPayload(deedData.front);
      if (jsonPayload) {
        finalMetadata = { ...jsonPayload };
      }
    }

    // 2. Fallback กันพัง
    if (!finalMetadata.name) finalMetadata.name = `THE IMPERIAL SOVEREIGN DEED ♠️ #${cleanTokenIdStr}`;
    if (!finalMetadata.description) finalMetadata.description = 'UNCOMPROMISED INTEGRITY PROTOCOL';
    if (!finalMetadata.attributes) finalMetadata.attributes = [];

    // เปลี่ยนรูป (back)
    if (!finalMetadata.image) {
      if (deedData.back && deedData.back.toUpperCase() !== 'UNASSIGNED') {
        finalMetadata.image = deedData.back;
      } else {
        finalMetadata.image = FALLBACK_IMAGE_URL;
      }
    }

    // เปลี่ยนวิดีโอ (video)
    if (!finalMetadata.animation_url && deedData.video && deedData.video.toUpperCase() !== 'UNASSIGNED') {
      finalMetadata.animation_url = deedData.video;
    }

    // 3. ผสม DNA
    if (deedData.sanctified && deedData.dna) {
      const dnaAttributes = parseDnaAttributes(deedData.dna);
      const existingTraits = new Set(finalMetadata.attributes.map((a: any) => a.trait_type));
      
      for (const dnaAttr of dnaAttributes) {
        if (!existingTraits.has(dnaAttr.trait_type)) {
          finalMetadata.attributes.push(dnaAttr);
        }
      }
    }

    // ซ่อนข้อมูล (hidden)
    if (!finalMetadata.external_url && deedData.hidden && deedData.hidden.toUpperCase() !== 'UNASSIGNED') {
      finalMetadata.external_url = deedData.hidden;
    }

    res.status(200).json(finalMetadata);

  } catch (error: any) {
    if (error.message === 'TOKEN_NOT_FOUND') {
      res.status(200).json(FALLBACK_METADATA);
    } else {
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR_OR_RPC_TIMEOUT" });
    }
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'HEALTHY', network: 'BASE MAINNET', target: CONTRACT_ADDRESS });
});

app.use((_req: Request, res: Response) => { res.status(200).json(FALLBACK_METADATA); });

export default app;