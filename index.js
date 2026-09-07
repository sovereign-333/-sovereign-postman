const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { ethers } = require('ethers');

const app = express();
app.use(cors());

// =====================================================
// ⚙️ CONFIGURATION
// =====================================================
const PORT = 3000;
const RPC_URL = "https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl"; 
const CONTRACT_ADDRESS = "0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2";
const BURNED_IMAGE_TXID = "https://gateway.irys.xyz/YOUR_BURNED_IMAGE_ID"; 

const provider = new ethers.JsonRpcProvider(RPC_URL);
const abi = [
    "function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string front, string back, string video, string dna, string hidden)"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

// =====================================================
// 🛠️ DYNAMIC MEDIA DETECTOR (CONCURRENT ENGINE)
// =====================================================
const detectAndFetchMedia = async (txId) => {
    if (!txId || txId === "UNASSIGNED" || !txId.trim()) return null;

    let urlsToTry = [];
    if (txId.startsWith("ipfs://")) {
        const ipfsHash = txId.replace("ipfs://", "");
        urlsToTry.push(`https://ipfs.io/ipfs/${ipfsHash}`);
        urlsToTry.push(`https://cloudflare-ipfs.com/ipfs/${ipfsHash}`);
    } else if (!txId.startsWith("http")) {
        urlsToTry.push(`https://gateway.irys.xyz/${txId}`);
        urlsToTry.push(`https://arweave.net/${txId}`);
    } else {
        urlsToTry.push(txId);
    }

    // ขยาย Timeout เป็น 7.5s (เซฟโซนก่อนโดน Vercel 10s Limit ตัด)
    const AXIOS_TIMEOUT = 7500; 

    const fetchFromGateway = async (url) => {
        let contentType = '';
        try {
            const headRes = await axios.head(url, { timeout: AXIOS_TIMEOUT });
            contentType = (headRes.headers['content-type'] || '').toLowerCase();
        } catch (error) {
            // ปล่อยผ่านไปเช็คตอน GET
        }

        try {
            if (contentType.includes('json')) {
                const getRes = await axios.get(url, { timeout: AXIOS_TIMEOUT, maxContentLength: 5000000 });
                return { type: 'json', data: getRes.data, url };
            } else if (contentType.includes('video') || contentType.includes('mp4')) {
                return { type: 'video', url };
            } else if (contentType.includes('image')) {
                return { type: 'image', url };
            } else {
                // Fallback ยิง GET เต็มรูปแบบถ้า HEAD อ่าน Type ไม่ได้
                const getRes = await axios.get(url, { timeout: AXIOS_TIMEOUT, maxContentLength: 5000000 });
                const fetchedType = (getRes.headers['content-type'] || '').toLowerCase();
                
                if (typeof getRes.data === 'object') return { type: 'json', data: getRes.data, url };
                if (fetchedType.includes('video') || fetchedType.includes('mp4')) return { type: 'video', url };
                if (fetchedType.includes('image')) return { type: 'image', url };
                
                return { type: 'unknown_media', url }; 
            }
        } catch (error) {
            // ดัก Error ของ Axios GET ป้องกัน Promise.any พัง
            throw new Error(`GET failed for ${url}`);
        }
    };

    try {
        return await Promise.any(urlsToTry.map(url => fetchFromGateway(url)));
    } catch (aggregateError) {
        console.warn(`[Gateway Failure] All nodes failed or timed out for TXID: ${txId}`);
        return null; // ปล่อยให้เป็น null เพื่อเข้าสู่กระบวนการประกอบร่าง Metadata ต่อไป
    }
};

// =====================================================
// 🚀 MAIN METADATA ENDPOINT (VERCEL SAFE-ROUTING)
// =====================================================
// ใช้ Wildcard '*' เพื่อแก้ปัญหา Vercel Rewrite ทำ path หาย แล้วใช้ Regex จับ Token ID แทน
app.get('*', async (req, res) => {
    // กรองเอาเฉพาะ Request ที่วิ่งมาหา Metadata
    const match = req.url.match(/metadata\/(\d+)(?:\.json)?/);
    if (!match) {
        return res.status(404).json({ error: "Invalid Route. Use /metadata/:tokenId" });
    }

    const tokenId = match[1];
    res.setHeader('Content-Type', 'application/json');

    try {
        let deedData;
        try {
            deedData = await contract.getDeedData(tokenId);
        } catch (error) {
            if (error.message.includes("NonexistentToken") || error.message.includes("revert")) {
                res.setHeader('Cache-Control', 'no-store');
                return res.status(404).json({ error: "Artwork not forged yet" });
            }
            throw error;
        }

        const isBurned = deedData[0] === "0x0000000000000000000000000000000000000000" && deedData[1] === false;
        if (isBurned || deedData[1] === false) {
            res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=31536000, immutable');
            return res.status(200).json({
                name: `BURNED DEED #${tokenId}`,
                description: "This Imperial Sovereign Deed has been permanently burned and sanitized from the registry.",
                image: BURNED_IMAGE_TXID.startsWith("http") ? BURNED_IMAGE_TXID : `https://gateway.irys.xyz/${BURNED_IMAGE_TXID}`,
                attributes: [{ trait_type: "Status", value: "BURNED" }]
            });
        }

        const isSanctified = deedData[2];
        const stringsToParse = [deedData[3], deedData[4], deedData[5]]; 
        const dnaString = deedData[6]; 

        const parsedMedia = await Promise.all(stringsToParse.map(txId => detectAndFetchMedia(txId)));

        let finalMetadata = {
            name: `THE IMPERIAL SOVEREIGN DEED #${tokenId}`,
            description: "",
            attributes: []
        };

        let externalLinks = [];

        parsedMedia.forEach((media, index) => {
            if (!media) return;
            const originField = index === 0 ? "Front" : index === 1 ? "Back" : "Extra";

            if (media.type === 'json') {
                if (media.data.name) finalMetadata.name = media.data.name;
                if (media.data.description) finalMetadata.description = media.data.description;
                if (media.data.image) finalMetadata.image = media.data.image.startsWith("http") ? media.data.image : `https://gateway.irys.xyz/${media.data.image}`;
                if (media.data.attributes) {
                    const overrideKeys = ["Sanctified (NOVA)", "Raw Identity DNA", "Sovereign Identity", "Identity ID", "Forensic Pixel Coordinates", "Chrono-Map Anchor", "Back Deed"];
                    finalMetadata.attributes = finalMetadata.attributes.concat(
                        media.data.attributes.filter(attr => !overrideKeys.includes(attr.trait_type))
                    );
                }
            } else if (media.type === 'video') {
                if (!finalMetadata.animation_url) {
                    finalMetadata.animation_url = media.url;
                } else {
                    externalLinks.push(`🎥 **[View ${originField} Video](${media.url})**`);
                }
            } else {
                if (!finalMetadata.image) {
                    finalMetadata.image = media.url;
                } else {
                    externalLinks.push(`🖼️ **[View ${originField} Artwork](${media.url})**`);
                }
            }
        });

        if (!finalMetadata.image && !finalMetadata.animation_url && !finalMetadata.attributes.length) {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(404).json({ error: "Artwork data is empty or unassigned (Gateway Timeout)" });
        }

        finalMetadata.attributes.push({ trait_type: "Sanctified (NOVA)", value: isSanctified ? "TRUE" : "FALSE" });
        
        if (dnaString && dnaString !== "UNASSIGNED" && dnaString.trim()) {
            finalMetadata.attributes.push({ trait_type: "Raw Identity DNA", value: dnaString });
            const dnaSegments = dnaString.split('|').map(s => s.trim()).filter(Boolean);
            dnaSegments.forEach(segment => {
                const colonIndex = segment.indexOf(':');
                if (colonIndex !== -1) {
                    let rawKey = segment.substring(0, colonIndex).trim();
                    const val = segment.substring(colonIndex + 1).trim();
                    let dynamicKey = rawKey.replace(/[-_]/g, ' ').replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
                    finalMetadata.attributes.push({ trait_type: dynamicKey, value: val });
                }
            });
        }

        if (externalLinks.length > 0) {
            finalMetadata.description += `\n\n---\n**Imperial Archives**\n` + externalLinks.join('\n');
        }

        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
        return res.status(200).json(finalMetadata);

    } catch (error) {
        console.error(`Execution Error on Token ${tokenId}:`, error.message);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.status(503).json({
            error: "Service Temporarily Unavailable",
            message: "Syncing with Imperial Archives..."
        });
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Imperial Metadata API listening on port ${PORT}`);
    });
}

module.exports = app;