import express, { Request, Response } from 'express';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import cors from 'cors';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import http from 'http';
import https from 'https';

dotenv.config();

// ---------------------------------------------------------
// [STRATEGY 1]: MULTI-RPC FALLBACK
// ---------------------------------------------------------
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x920c1f00EF178B3C060BD39a6a3f449BA2b230C9';

const RPC_1 = process.env.RPC_PRIMARY || process.env.ALCHEMY_RPC_URL || process.env.RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY';
const RPC_2 = process.env.RPC_SECONDARY || process.env.RPC_URL || 'https://mainnet.base.org';
const RPC_3 = process.env.RPC_TERTIARY || 'https://base.llamarpc.com';
const RPC_4 = process.env.PUBLIC_NODE_RPC || 'https://base.publicnode.com';

const provider1 = new ethers.JsonRpcProvider(RPC_1, 8453, { staticNetwork: true });
const provider2 = new ethers.JsonRpcProvider(RPC_2, 8453, { staticNetwork: true });
const provider3 = new ethers.JsonRpcProvider(RPC_3, 8453, { staticNetwork: true });
const provider4 = new ethers.JsonRpcProvider(RPC_4, 8453, { staticNetwork: true });

const fallbackProvider = new ethers.FallbackProvider([
    { provider: provider1, priority: 1, weight: 2 },
    { provider: provider2, priority: 2, weight: 1 },
    { provider: provider3, priority: 3, weight: 1 },
    { provider: provider4, priority: 4, weight: 1 }
], 1);

const abi = [
    "function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, fallbackProvider);

// ---------------------------------------------------------
// [STRATEGY 2]: SECURE AXIOS ENGINE & SMART UNPACKER
// ---------------------------------------------------------
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

const secureAxios = axios.create({
    timeout: 5000,
    maxContentLength: 50000,
    maxBodyLength: 50000,
    httpAgent,
    httpsAgent,
    maxRedirects: 3,
    headers: { 'Accept': 'application/json, text/plain, */*' }
});

const isSafeDomain = (url: string): boolean => {
    try {
        const parsedUrl = new URL(url);
        const allowedDomains = [
            'arweave.net', 
            'ipfs.io', 
            'gateway.irys.xyz', 
            'gateway.pinata.cloud',
            'cloudflare-ipfs.com',
            'dweb.link'
        ];
        return allowedDomains.some(domain => 
            parsedUrl.hostname === domain || parsedUrl.hostname.endsWith(`.${domain}`)
        );
    } catch (e) {
        return false;
    }
};

const formatURI = (uri: string): string => {
    if (!uri) return "";
    const cleanUri = uri.trim();
    
    if (cleanUri.startsWith("ar://")) return cleanUri.replace("ar://", "https://gateway.irys.xyz/");
    if (cleanUri.startsWith("ipfs://")) return cleanUri.replace("ipfs://", "https://gateway.pinata.cloud/ipfs/");
    if (cleanUri.startsWith("http://") || cleanUri.startsWith("https://")) return cleanUri;

    return `https://gateway.irys.xyz/${cleanUri}`;
};

const fetchJsonMetadata = async (url: string) => {
    try {
        const response = await secureAxios.get(url, { responseType: 'text' });
        let data = response.data;

        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return null;
            }
        }

        if (data && typeof data === 'object' && !Array.isArray(data)) {
            return data;
        }
    } catch (error: any) {
        // Ignore non-json or oversized payload
    }
    return null; 
};

// ---------------------------------------------------------
// [STRATEGY 3]: EXPRESS SERVER SETUP
// ---------------------------------------------------------
const app = express();

app.set('trust proxy', 1); 
app.use(express.json());
app.use(cors());

// ขยาย Rate Limit ให้สูงขึ้น ป้องกันบอท OpenSea ชนเพดานโดนบล็อก
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 2000,
    message: { error: "Rate limit exceeded. Please try again later." }
});
app.use('/metadata', apiLimiter);

// ---------------------------------------------------------
// CORE ENDPOINT
// ---------------------------------------------------------
app.get('/metadata/:tokenId', async (req: Request, res: Response) => {
    // ✅ เปิดให้ Caching Proxy ของ OpenSea บันทึกข้อมูลได้ ไม่สั่ง no-store อีกต่อไป
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const tokenId = req.params.tokenId.replace(/\.json$/, '');

    if (!/^\d+$/.test(tokenId)) {
        return res.status(400).json({ error: "Invalid Token ID format. Must be a numeric string." });
    }

    try {
        const data = await contract.getDeedData(tokenId);

        if (!data.owner || data.owner === ethers.ZeroAddress) {
            return res.status(404).json({ error: "โฉนดใบนี้ยังไม่ถูกสร้างเข้าระบบสิทธิ์ขาด" });
        }

        const rawFrontUrl = formatURI(data.front);
        let finalImage = rawFrontUrl; 
        let finalAnimation = data.video ? formatURI(data.video) : undefined;
        let finalName = `THE IMPERIAL SOVEREIGN DEED ♠️ #${tokenId}`;
        let finalDescription = "IMPERIAL SOVEREIGN ARCHITECTURE - Absolute Immutable Autarkic Identity Manifest";
        const dynamicAttributes: any[] = [
            { trait_type: "Sovereign Owner", value: data.owner },
            { trait_type: "Active Status", value: data.active ? "True" : "False" },
            { trait_type: "Sanctified", value: data.sanctified ? "True" : "False" }
        ];

        if (data.front && data.front.trim() !== "") {
            const frontJson = await fetchJsonMetadata(rawFrontUrl);
            if (frontJson) {
                if (frontJson.image) finalImage = formatURI(frontJson.image);
                if (frontJson.animation_url) finalAnimation = formatURI(frontJson.animation_url);
                if (frontJson.name) finalName = frontJson.name;
                if (frontJson.description) finalDescription = frontJson.description;
                if (frontJson.attributes && Array.isArray(frontJson.attributes)) {
                    dynamicAttributes.push(...frontJson.attributes);
                }
            }
        }

        if (data.back && data.back.trim() !== "") {
            const fullBackUrl = formatURI(data.back);
            dynamicAttributes.push({ trait_type: "Deed Back Registry", value: fullBackUrl });
            
            if (!finalAnimation) {
                finalAnimation = fullBackUrl;
            }
        }

        if (data.hidden && data.hidden.trim() !== "") {
            const hiddenUrl = formatURI(data.hidden);
            if (hiddenUrl.startsWith("http") && isSafeDomain(hiddenUrl)) {
                const hiddenJson = await fetchJsonMetadata(hiddenUrl);
                if (hiddenJson) {
                    if (Array.isArray(hiddenJson.attributes)) {
                        dynamicAttributes.push(...hiddenJson.attributes);
                    } else {
                        dynamicAttributes.push({ trait_type: "Hidden Property (Chrono-Map)", value: JSON.stringify(hiddenJson) });
                    }
                } else {
                    dynamicAttributes.push({ trait_type: "Hidden Property (Chrono-Map)", value: hiddenUrl });
                }
            }
        }

        if (data.dna && data.dna.trim() !== "") {
            dynamicAttributes.push({ trait_type: "Identity DNA", value: data.dna });
        }

        const metadata: Record<string, any> = {
            name: finalName,
            description: finalDescription,
            image: finalImage,
            external_url: `https://basescan.org/token/${CONTRACT_ADDRESS}?a=${tokenId}`,
            attributes: dynamicAttributes
        };

        if (finalAnimation) {
            metadata.animation_url = finalAnimation;
        }

        res.json(metadata);
        console.log(`[SUCCESS] ♠️ ส่งออก Metadata โฉนด #${tokenId} สำเร็จ`);

    } catch (error: any) {
        if (error.message?.includes("NonexistentToken") || error.message?.includes("execution reverted") || error.code === "CALL_EXCEPTION") {
            return res.status(404).json({ error: `Token #${tokenId} does not exist.` });
        }
        console.error(`[ORACLE ERROR] ⚠️ Token #${tokenId}:`, error.message || error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/', (_req: Request, res: Response) => {
    res.send("♣️ Imperial Sovereign Metadata Relay Pipe is active.");
});

// ---------------------------------------------------------
// [STRATEGY 4]: GLOBAL ERROR SHIELD
// ---------------------------------------------------------
process.on('uncaughtException', (err) => console.error('[CRITICAL] ⚠️ Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('[CRITICAL] ⚠️ Unhandled Rejection:', reason));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SYSTEM] ♠️ Metadata Relay Server รันอยู่ที่พอร์ต ${PORT}`);
    console.log(`[SYSTEM] 🔗 ชี้ไปยัง Contract: ${CONTRACT_ADDRESS}`);
});