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
// [STRATEGY 1]: MULTI-RPC FALLBACK (ระบบสำรอง 4-Node)
// ---------------------------------------------------------
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x920c1f00EF178B3C060BD39a6a3f449BA2b230C9';

const RPC_1 = process.env.RPC_PRIMARY || process.env.RPC_URL || process.env.ALCHEMY_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY';
const RPC_2 = process.env.RPC_SECONDARY || 'https://mainnet.base.org';
const RPC_3 = process.env.RPC_TERTIARY || 'https://base.llamarpc.com';
const RPC_4 = process.env.PUBLIC_NODE_RPC || 'https://base.publicnode.com';

const fallbackProvider = new ethers.FallbackProvider([
    { provider: new ethers.JsonRpcProvider(RPC_1), priority: 1, weight: 2 },
    { provider: new ethers.JsonRpcProvider(RPC_2), priority: 2, weight: 1 },
    { provider: new ethers.JsonRpcProvider(RPC_3), priority: 3, weight: 1 },
    { provider: new ethers.JsonRpcProvider(RPC_4), priority: 4, weight: 1 }
], 1);

const abi = [
    "function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, fallbackProvider);

// ---------------------------------------------------------
// [STRATEGY 2]: SECURE AXIOS ENGINE & IRYS ID PARSER
// ---------------------------------------------------------
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

const secureAxios = axios.create({
    timeout: 4000,
    maxContentLength: 50000,
    httpAgent,
    httpsAgent,
    maxRedirects: 0,
    headers: { 'Accept': 'application/json' }
});

const isSafeDomain = (url: string): boolean => {
    try {
        const parsedUrl = new URL(url);
        const allowedDomains = ['arweave.net', 'ipfs.io', 'gateway.irys.xyz', 'gateway.pinata.cloud'];
        return allowedDomains.some(domain => 
            parsedUrl.hostname === domain || parsedUrl.hostname.endsWith(`.${domain}`)
        );
    } catch (e) {
        return false;
    }
};

// [SYSTEM CORRECTION]: แก้ไขตัวแปลง URI ให้รองรับทั้ง Full URL, Protocols และ Irys Tx ID เพียวๆ
const formatURI = (uri: string): string => {
    if (!uri) return "";
    const cleanUri = uri.trim();
    
    if (cleanUri.startsWith("ar://")) return cleanUri.replace("ar://", "https://gateway.irys.xyz/");
    if (cleanUri.startsWith("ipfs://")) return cleanUri.replace("ipfs://", "https://gateway.pinata.cloud/ipfs/");
    if (cleanUri.startsWith("http://") || cleanUri.startsWith("https://")) return cleanUri;

    // ถ้าส่งมาเป็นแค่ Tx ID เพียวๆ ของ Irys ให้ต่อ URL Gateway ให้อัตโนมัติ
    return `https://gateway.irys.xyz/${cleanUri}`;
};

// ---------------------------------------------------------
// [STRATEGY 3]: EXPRESS SERVER SETUP
// ---------------------------------------------------------
const app = express();

app.set('trust proxy', 1); 

app.use(express.json());
app.use(cors());

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 150,
    message: { error: "Rate limit exceeded. Please try again later." }
});
app.use('/metadata', apiLimiter);

// ---------------------------------------------------------
// CORE ENDPOINT
// ---------------------------------------------------------
app.get('/metadata/:tokenId', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // ดักตัด .json ออกให้เหลือแต่ตัวเลข Token ID
    const tokenId = req.params.tokenId.replace(/\.json$/, '');

    if (!/^\d+$/.test(tokenId)) {
        return res.status(400).json({ error: "Invalid Token ID format. Must be a numeric string." });
    }

    try {
        const data = await contract.getDeedData(tokenId);

        if (!data.owner || data.owner === ethers.ZeroAddress) {
            return res.status(404).json({ error: "โฉนดใบนี้ยังไม่ถูกสร้างเข้าระบบสิทธิ์ขาด" });
        }

        const metadata: Record<string, any> = {
            name: `Imperial Sovereign Deed #${tokenId}`,
            description: "The Absolute Proof of True Ownership & Identity.",
            image: formatURI(data.front),
            external_url: `https://basescan.org/token/${CONTRACT_ADDRESS}?a=${tokenId}`,
            attributes: [
                { trait_type: "Sovereign Owner", value: data.owner },
                { trait_type: "Active Status", value: data.active ? "True" : "False" },
                { trait_type: "Sanctified", value: data.sanctified ? "True" : "False" }
            ]
        };

        if (data.video && data.video.trim() !== "") metadata.animation_url = formatURI(data.video);
        if (data.back && data.back.trim() !== "") metadata.attributes.push({ trait_type: "Deed Back Registry", value: formatURI(data.back) });
        if (data.dna && data.dna.trim() !== "") metadata.attributes.push({ trait_type: "Identity DNA (Forensic Anchor)", value: data.dna });

        if (data.hidden && data.hidden.trim() !== "") {
            const hiddenUrl = formatURI(data.hidden);
            
            if (hiddenUrl.startsWith("http") && isSafeDomain(hiddenUrl)) {
                try {
                    const response = await secureAxios.get(hiddenUrl);
                    const extraData = response.data;
                    
                    if (extraData && Array.isArray(extraData.attributes)) {
                        metadata.attributes.push(...extraData.attributes);
                    } else if (extraData && typeof extraData === 'object') {
                        metadata.attributes.push({ trait_type: "Hidden Property (Chrono-Map)", value: JSON.stringify(extraData) });
                    }
                } catch (err: any) {
                    console.warn(`[WARN] ⚠️ ดึงข้อมูล Hidden จาก ${hiddenUrl} ไม่สำเร็จ: ${err.message}`);
                    metadata.attributes.push({ trait_type: "Hidden Property (Chrono-Map)", value: hiddenUrl });
                }
            } else {
                metadata.attributes.push({ trait_type: "Hidden Property (Chrono-Map)", value: data.hidden });
            }
        }

        res.json(metadata);
        console.log(`[SUCCESS] ♠️ ส่งออก Metadata โฉนด #${tokenId} สำเร็จ`);

    } catch (error: any) {
        if (error.message?.includes("NonexistentToken") || error.message?.includes("execution reverted") || error.code === "CALL_EXCEPTION") {
            return res.status(404).json({ error: `Token #${tokenId} does not exist.` });
        }
        console.error(`[ORACLE ERROR] ⚠️ Token #${tokenId}:`, error.message || error);
        res.status(500).json({ error: "Internal Server / RPC Connection Error" });
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