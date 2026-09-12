import express, { Request, Response } from 'express';
import { Contract, JsonRpcProvider } from 'ethers';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { LRUCache } from 'lru-cache';

// ============================================================================
// 🔱 1. ON-CHAIN CONFIGURATION & GLOBAL INSTANCES
// ============================================================================
const CONTRACT_ADDRESS = '0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2';
const MASTER_IMAGE = 'https://gateway.irys.xyz/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR';

const RPC_ENDPOINTS = [
  'https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl',
  'https://mainnet.base.org',
  'https://base.llamarpc.com'
];

const CONTRACT_ABI = [
  'function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)',
  'function getTBA(uint256 t) public view returns (address)'
];

const PROVIDERS = RPC_ENDPOINTS.map(url => new JsonRpcProvider(url, 8453, { staticNetwork: true }));
const CONTRACTS = PROVIDERS.map(provider => new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider));

// ============================================================================
// 🛡️ 2. SECURITY & CACHING
// ============================================================================
const metadataCache = new LRUCache<string, any>({
  max: 2000,
  ttl: 1000 * 60 * 3, 
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 200, 
  message: { error: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, image/*, video/*, */*'
};

// ============================================================================
// ⚙️ 3. URI FORMATTER & GATEWAY RESOLVER
// ============================================================================
function parseRawUri(rawUri: string | null): string {
  if (!rawUri || rawUri.toUpperCase() === 'UNASSIGNED') return '';
  let trimmed = rawUri.trim();
  
  if (/^[a-zA-Z0-9_-]{43}$/.test(trimmed)) return `https://gateway.irys.xyz/${trimmed}`; 
  if (trimmed.startsWith('ar://')) return `https://gateway.irys.xyz/${trimmed.replace('ar://', '')}`;
  if (trimmed.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${trimmed.replace('ipfs://', '')}`;
  return trimmed;
}

// ============================================================================
// ⚡ 4. GATEWAY RACER 
// ============================================================================
async function inspectAndRaceGateways(txId: string): Promise<{ url: string; contentType: string; jsonData?: any }> {
  if (!txId) return { url: '', contentType: 'unknown' };

  const isDirectHttp = txId.startsWith('http') && !txId.includes('irys.xyz') && !txId.includes('arweave.net');
  const baseTx = txId.replace('ar://', '').replace('https://gateway.irys.xyz/', '').replace('https://arweave.net/', '');
  
  const irysUrl = isDirectHttp ? txId : `https://gateway.irys.xyz/${baseTx}`;
  const arUrl = isDirectHttp ? txId : `https://arweave.net/${baseTx}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500); 

  try {
    const winnerRes = await Promise.any([
      fetch(irysUrl, { signal: controller.signal, headers: FETCH_HEADERS }).then(r => r.ok ? r : Promise.reject()),
      fetch(arUrl, { signal: controller.signal, headers: FETCH_HEADERS }).then(r => r.ok ? r : Promise.reject())
    ]);

    const contentType = (winnerRes.headers.get('content-type') || '').toLowerCase();
    const winnerUrl = winnerRes.url;

    if (contentType.includes('application/json') || winnerUrl.endsWith('.json')) {
      const jsonData = await winnerRes.json();
      return { url: winnerUrl, contentType, jsonData };
    }

    return { url: winnerUrl, contentType };
  } catch (err) {
    return { url: irysUrl, contentType: 'unknown' };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// ⚖️ 5. ON-CHAIN TRUTH EXTRACTOR 
// ============================================================================
async function getSovereignTruth(tokenId: bigint): Promise<any> {
  let lastError = null;

  for (const contract of CONTRACTS) {
    let timeoutId;
    try {
      const fetchPromise = Promise.all([
        contract.getDeedData(tokenId),
        contract.getTBA(tokenId).catch(() => '0x0000000000000000000000000000000000000000') 
      ]);

      const [deed, tbaAddress] = await Promise.race([
        fetchPromise,
        new Promise<any>((_, rej) => { timeoutId = setTimeout(() => rej(new Error('RPC_TIMEOUT')), 2500); })
      ]);

      return {
        owner: String(deed[0] ?? ''),
        active: Boolean(deed[1]),
        sanctified: Boolean(deed[2]),
        front: parseRawUri(deed[3]),
        back: parseRawUri(deed[4]),
        video: parseRawUri(deed[5]),
        dna: String(deed[6] || '').trim(),
        hidden: parseRawUri(deed[7]),
        tba: tbaAddress
      };
    } catch (err: any) {
      lastError = err;
      if (err.message.includes('revert') || err.message.includes('NonexistentToken')) {
        throw new Error('TOKEN_NOT_FOUND');
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  throw lastError || new Error('ALL_RPC_FAILED');
}

// ============================================================================
// 🚀 6. API SERVER (ABSOLUTE COMMAND)
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
  const cleanTokenIdStr = (req.params.tokenId || '').replace(/\.json$/, '');
  if (!/^\d+$/.test(cleanTokenIdStr)) { res.status(400).json({ error: 'INVALID_TOKEN_FORMAT' }); return; }
  
  const numericId = BigInt(cleanTokenIdStr);
  if (numericId < 1n || numericId > 333n) { res.status(404).json({ error: 'TOKEN_OUT_OF_RANGE' }); return; }

  const cacheKey = `metadata_${cleanTokenIdStr}`;
  if (metadataCache.has(cacheKey)) { res.status(200).json(metadataCache.get(cacheKey)); return; }

  try {
    const truth = await getSovereignTruth(numericId);

    // 🛑 ตรวจสอบการ Burn หรือยังไม่มิ้นข้อมูล (ไม่ออก Master Image มั่วซั่ว คืนค่าตามจริงหรือสถานะ Unassigned)
    if (!truth.active || truth.owner === '0x0000000000000000000000000000000000000000') {
      res.status(404).json({ error: 'TOKEN_UNASSIGNED_OR_BURNED', message: 'Token has not been minted or has been burned.' });
      return;
    }

    const inspection = await inspectAndRaceGateways(truth.front);
    let finalResponseData: any = {};

    if (inspection.jsonData) {
      finalResponseData = inspection.jsonData;
    } else {
      finalResponseData = {
        name: `THE IMPERIAL SOVEREIGN DEED ♠️ #${cleanTokenIdStr}`,
        description: 'IMPERIAL SOVEREIGN ARCHITECTURE - Absolute Immutable Autarkic Identity Manifest',
        attributes: [
          { trait_type: 'RANK', value: 'THE COUNCIL PRIME' },
          { trait_type: 'IDENTITY STATUS', value: truth.sanctified ? 'SANCTIFIED (NOVA)' : 'UNCOMPROMISED INTEGRITY PROTOCOL' }
        ]
      };

      if (inspection.contentType.includes('video') || inspection.url.endsWith('.mp4')) {
        finalResponseData.animation_url = inspection.url;
      } else if (inspection.url) {
        finalResponseData.image = inspection.url;
      }
    }

    if (truth.video || truth.back) {
      const targetSecondary = truth.video ? truth.video : truth.back;
      const secInspection = await inspectAndRaceGateways(targetSecondary);
      if (secInspection.url) {
        finalResponseData.animation_url = secInspection.url;
      }
    }

    if (truth.hidden && truth.hidden.toUpperCase() !== 'UNASSIGNED') {
      finalResponseData.external_url = truth.hidden;
    }

    if (truth.dna && truth.dna.toUpperCase() !== 'UNASSIGNED') {
      if (!finalResponseData.attributes) finalResponseData.attributes = [];
      
      const segments = truth.dna.split('|');
      segments.forEach(segment => {
        const firstColonIdx = segment.indexOf(':');
        if (firstColonIdx > -1) {
          const key = segment.substring(0, firstColonIdx).trim();
          const value = segment.substring(firstColonIdx + 1).trim();
          
          const exists = finalResponseData.attributes.find((a: any) => a.trait_type === key);
          if (!exists) finalResponseData.attributes.push({ trait_type: key, value: value });
        }
      });
    }

    if (truth.tba && truth.tba !== '0x0000000000000000000000000000000000000000') {
      if (!finalResponseData.attributes) finalResponseData.attributes = [];
      finalResponseData.attributes.push({ trait_type: 'Token Bound Account', value: truth.tba });
    }

    metadataCache.set(cacheKey, finalResponseData);
    res.status(200).json(finalResponseData);

  } catch (error: any) {
    if (error.message === 'TOKEN_NOT_FOUND') {
      res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
    } else {
      res.status(503).json({ error: 'RPC_UNAVAILABLE', message: 'Blockchain consensus delayed. Retry imminent.' });
    }
  }
});

app.get('/health', (_req, res) => res.status(200).json({ status: 'HEALTHY', cache_size: metadataCache.size }));
app.use((_req, res) => { res.status(404).json({ error: 'NOT_FOUND' }); });

export default app;