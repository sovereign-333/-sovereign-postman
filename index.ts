// ============================================================================
// 🔥 WAR MACHINE MASTER ARCHITECTURE: DUAL-GATEWAY RACING & ANTI-LEAK
// ============================================================================
import express, { Request, Response, NextFunction } from 'express';
import { Contract, JsonRpcProvider } from 'ethers';
import cors from 'cors';
import helmet from 'helmet';

// ⚙️ SYSTEM CONSTANTS
const CONTRACT_ADDRESS = '0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2';
const FALLBACK_IMAGE_URL = 'https://gateway.irys.xyz/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR';
const BASE_CHAIN_ID = 8453;

const RPC_ENDPOINTS = [
  'https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl',
  'https://mainnet.base.org',
  'https://base.llamarpc.com'
];

const CONTRACT_ABI = [
  'function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)'
];

const providerPool = RPC_ENDPOINTS.map(url => new JsonRpcProvider(url, BASE_CHAIN_ID, { staticNetwork: true }));

// ============================================================================
// ⚙️ UTILITIES: TX_ID EXTRACTOR & NORMALIZER
// ============================================================================
function extractTxId(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const t = uri.trim();
  if (/^[a-zA-Z0-9_-]{43}$/.test(t)) return t;
  if (t.includes('gateway.irys.xyz/')) return t.split('gateway.irys.xyz/')[1]?.split('?')[0] || null;
  if (t.includes('arweave.net/')) return t.split('arweave.net/')[1]?.split('?')[0] || null;
  if (t.startsWith('ar://')) return t.replace('ar://', '');
  return null;
}

function normalizeUri(uri: string | null | undefined): string {
  if (!uri) return '';
  const txId = extractTxId(uri);
  if (txId) return `https://gateway.irys.xyz/${txId}`; // Default display URL
  const trimmed = uri.trim();
  if (trimmed.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${trimmed.replace('ipfs://', '')}`;
  return trimmed;
}

function parseDnaAttributes(dnaStr: string): { trait_type: string; value: string }[] {
  const attributes: { trait_type: string; value: string }[] = [];
  if (!dnaStr) return attributes;

  const cleanDna = dnaStr.replace(/SOVEREIGN NOVA\s*:\s*STRINGS MEMORY DNA\s*:\s*/i, '');
  const segments = cleanDna.split('|');
  
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex !== -1) {
      const rawKey = trimmed.substring(0, colonIndex).trim();
      const rawValue = trimmed.substring(colonIndex + 1).trim();
      attributes.push({ trait_type: rawKey, value: rawValue });
    } else {
      attributes.push({ trait_type: 'Data Record', value: trimmed });
    }
  }
  return attributes;
}

// ============================================================================
// 🚀 DUAL-GATEWAY RACING ENGINE (IRYS VS ARWEAVE)
// ============================================================================
async function fetchJsonWithRace(uri: string) {
  if (!uri) return null;
  const txId = extractTxId(uri);
  
  const controller = new AbortController();
  // 🚨 ตัดจบที่ 2.0 วินาที ป้องกัน Time-out จาก OpenSea
  const timeoutId = setTimeout(() => controller.abort(), 2000); 

  try {
    if (txId) {
      const urls = [`https://gateway.irys.xyz/${txId}`, `https://arweave.net/${txId}`];
      
      // Promise.any: ใครตอบกลับก่อน เอาข้อมูลนั้นทันที
      return await Promise.any(urls.map(async (url) => {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`Gateway Error: ${url}`);
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('json') && !contentType.includes('text/plain')) {
            throw new Error('Not JSON');
        }
        return await res.json();
      }));
    } else {
      // กรณีเป็น URL ปกติ
      const res = await fetch(uri, { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP Error');
      return await res.json();
    }
  } catch (error) {
    return null; // เงียบไว้ ไม่ให้กระทบระบบหลัก
  } finally {
    // 🚨 ทำลายขยะในหน่วยความจำ ป้องกัน Memory Leak 100%
    clearTimeout(timeoutId); 
  }
}

// ============================================================================
// 🛡️ SMART CONTRACT INTERROGATOR
// ============================================================================
async function executeContractRead(tokenId: bigint) {
  let lastError: Error | null = null;
  for (const provider of providerPool) {
    try {
      const contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
      const timeoutPromise = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('RPC Timeout')), 2000));
      const rawData: any = await Promise.race([contract.getDeedData(tokenId), timeoutPromise]);
      
      return {
        owner: String(rawData[0]),
        active: Boolean(rawData[1]), 
        sanctified: Boolean(rawData[2]),
        front: String(rawData[3] || ''), 
        back: String(rawData[4] || ''),
        video: String(rawData[5] || ''), 
        dna: String(rawData[6] || ''), 
        hidden: String(rawData[7] || '')
      };
    } catch (err: any) {
      lastError = err;
    }
  }
  throw lastError || new Error('All RPC endpoints failed.');
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

  try {
    const parsedTokenId = BigInt(tokenId);
    const deedData = await executeContractRead(parsedTokenId);
    
    if (!deedData.active) { 
      res.status(200).json({
        name: `THE IMPERIAL SOVEREIGN DEED ♠️ #${tokenId}`,
        description: 'UNCOMPROMISED INTEGRITY PROTOCOL',
        image: FALLBACK_IMAGE_URL,
        attributes: [{ trait_type: 'Status', value: 'Burned / Inactive' }]
      }); 
      return; 
    }

    let finalMetadata: any = {
      name: `THE IMPERIAL SOVEREIGN DEED ♠️ #${tokenId}`,
      description: 'IMPERIAL SOVEREIGN ARCHITECTURE - Absolute Immutable Autarkic Identity Manifest',
      image: FALLBACK_IMAGE_URL,
      attributes: []
    };

    // 🚨 ดึงข้อมูลด้วย Dual-Gateway Racing
    if (deedData.front) {
      const fetchedJson = await fetchJsonWithRace(deedData.front);
      if (fetchedJson) {
        finalMetadata = { ...finalMetadata, ...fetchedJson };
        if (!Array.isArray(finalMetadata.attributes)) finalMetadata.attributes = [];
        if (finalMetadata.image) finalMetadata.image = normalizeUri(finalMetadata.image);
      } else {
        // หาก Front ไม่ใช่ JSON หรือดึงไม่สำเร็จ ให้ลองใช้เป็น Image URL โดยตรง
        const frontUrl = normalizeUri(deedData.front);
        if (frontUrl && finalMetadata.image === FALLBACK_IMAGE_URL) {
          finalMetadata.image = frontUrl;
        }
      }
    }

    // 🚨 ประกอบร่างข้อมูลที่เหลือจาก Smart Contract
    const dnaAttributes = parseDnaAttributes(deedData.dna);
    if (dnaAttributes.length > 0) {
      finalMetadata.attributes = [...finalMetadata.attributes, ...dnaAttributes];
    }

    const backUrl = normalizeUri(deedData.back);
    if (backUrl) {
        if (finalMetadata.image === FALLBACK_IMAGE_URL) finalMetadata.image = backUrl;
        finalMetadata.attributes.push({ trait_type: 'BACK URI', value: backUrl });
    }

    const videoUrl = normalizeUri(deedData.video);
    if (videoUrl) finalMetadata.animation_url = videoUrl;

    const hiddenUrl = normalizeUri(deedData.hidden);
    if (hiddenUrl) finalMetadata.external_url = hiddenUrl;

    finalMetadata.attributes.push({ 
      trait_type: 'Sanctified', 
      value: deedData.sanctified ? 'TRUE' : 'FALSE' 
    });

    res.status(200).json(finalMetadata);

  } catch (error: any) {
    res.status(200).json({
        name: `THE IMPERIAL SOVEREIGN DEED ♠️ #${tokenId}`,
        description: 'UNCOMPROMISED INTEGRITY PROTOCOL',
        image: FALLBACK_IMAGE_URL,
        attributes: [{ trait_type: 'Status', value: 'Pending Data / Error' }]
    });
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'HEALTHY', network: 'BASE MAINNET', target: CONTRACT_ADDRESS });
});

app.use((_req: Request, res: Response) => { 
  res.status(200).json({
    name: 'THE IMPERIAL SOVEREIGN DEED ♠️',
    description: 'UNCOMPROMISED INTEGRITY PROTOCOL',
    image: FALLBACK_IMAGE_URL
  }); 
});

export default app;