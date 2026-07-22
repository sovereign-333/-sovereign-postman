import express from 'express';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import cors from 'cors';
import axios from 'axios';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const contractAddress = process.env.CONTRACT_ADDRESS!;

// ABI ดึงข้อมูลครบ 8 ค่าตาม Smart Contract
const abi = [
    "function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)"
];

const contract = new ethers.Contract(contractAddress, abi, provider);

const formatURI = (uri: string) => {
    if (!uri) return "";
    if (uri.startsWith("ar://")) return uri.replace("ar://", "https://arweave.net/");
    if (uri.startsWith("ipfs://")) return uri.replace("ipfs://", "https://ipfs.io/ipfs/");
    return uri;
};

app.get('/metadata/:tokenId', async (req, res) => {
    // 🟢 บังคับ OpenSea ห้ามจำแคช (No-Cache) เพื่อให้อัปเดตภาพและวิดีโอทันที
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // 🛠️ WAR MACHINE FIX: ตัด .json ออกเพื่อป้องกัน Ethers Parse Error
    const rawTokenId = req.params.tokenId;
    const tokenId = rawTokenId.replace(/\.json$/, '');

    try {
        const data = await contract.getDeedData(tokenId);
        
        if (data.owner === ethers.ZeroAddress) {
            return res.status(404).json({ error: "โฉนดใบนี้ยังไม่ถูกสร้างเข้าระบบสิทธิ์ขาด" });
        }

        const metadata: Record<string, any> = {
            name: `Imperial Sovereign Deed #${tokenId}`,
            description: "The Absolute Proof of True Ownership & Identity. The Machiavellian Dark Cool.",
            image: formatURI(data.front), 
            attributes: [
                { trait_type: "Sovereign Owner", value: data.owner } // 🟢 ดึง Address สดจาก Blockchain
            ]
        };

        if (data.video && data.video.trim() !== "") metadata.animation_url = formatURI(data.video);
        if (data.back && data.back.trim() !== "") {
            metadata.attributes.push({ trait_type: "Deed Back Registry", value: formatURI(data.back) });
        }
        if (data.dna && data.dna.trim() !== "") {
            metadata.attributes.push({ trait_type: "Identity DNA (Forensic Anchor)", value: data.dna });
        }

        if (data.hidden && data.hidden.trim() !== "") {
            const hiddenUrl = formatURI(data.hidden);
            
            if (hiddenUrl.startsWith("http")) {
                try {
                    const response = await axios.get(hiddenUrl);
                    const extraData = response.data;

                    if (extraData && extraData.attributes && Array.isArray(extraData.attributes)) {
                        metadata.attributes.push(...extraData.attributes);
                    }
                } catch (err) {
                    metadata.attributes.push({ trait_type: "Hidden Property (Chrono-Map)", value: hiddenUrl });
                }
            } else {
                metadata.attributes.push({ trait_type: "Hidden Property (Chrono-Map)", value: data.hidden });
            }
        }

        res.json(metadata);
        console.log(`[SYSTEM SUCCESS] ดึงข้อมูลสดของโฉนดเบอร์ ${tokenId} สู่แพลตฟอร์มเรียบร้อย`);

    } catch (error) {
        console.error(`[ORACLE ERROR] เบอร์ ${tokenId} การเชื่อมต่อขัดข้อง:`, error);
        res.status(500).json({ error: "Network Connection Error" });
    }
});

app.get('/', (req, res) => {
    res.send("♣️ Sovereign Conditional Pass-Through Pipe is fully active.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SYSTEM] ♠️ สัญญาณเชื่อมต่อพร้อมรบที่พอร์ต ${PORT}`);
});
