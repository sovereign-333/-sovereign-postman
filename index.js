const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { ethers } = require('ethers');

const app = express();
app.use(cors());

// =====================================================
// ⚙️ CONFIGURATION (HARDCODED DIRECTLY)
// =====================================================
const PORT = 3000;
const RPC_URL = "https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl"; 
const CONTRACT_ADDRESS = "0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2";
const BURNED_IMAGE_TXID = "https://gateway.irys.xyz/YOUR_BURNED_IMAGE_ID"; 

// =====================================================
// ⚡ INITIALIZE ON-CHAIN CONTRACT
// =====================================================
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

    const fetchFromGateway = async (url) => {
        let contentType = '';
        try {
            const headRes = await axios.head(url, { timeout: 1800 });
            contentType = (headRes.headers['content-type'] || '').toLowerCase();
        } catch (headErr) {
            // Gateway บล็อก HEAD ให้ปล่อยผ่านไปเช็ค GET
        }

        if (contentType.includes('json')) {
            const getRes = await axios.get(url, { timeout: 1800, maxContentLength: 5000000 });
            return { type: 'json', data: getRes.data, url };
        } else if (contentType.includes('video') || contentType.includes('mp4')) {
            return { type: 'video', url };
        } else if (contentType.includes('image')) {
            return { type: 'image', url };
        } else {
            const getRes = await axios.get(url, { timeout: 1800, maxContentLength: 5000000 });
            const fetchedType = (getRes.headers['content-type'] || '').toLowerCase();
            
            if (typeof getRes.data === 'object') {
                return { type: 'json', data: getRes.data, url };
            } else if (fetchedType.includes('video') || fetchedType.includes('mp4')) {
                return { type: 'video', url };
            } else if (fetchedType.includes('image')) {
                return { type: 'image', url };
            }
            
            throw new Error(`Invalid media payload from ${url}`);
        }
    };

    try {
        return await Promise.any(urlsToTry.map(url => fetchFromGateway(url)));
    } catch (aggregateError) {
        console.warn(`[Gateway Failure] All nodes failed for TXID: ${txId}`);
        return null;
    }
};

// =====================================================
// 🚀 MAIN METADATA ENDPOINT (VERCEL EDGE CACHED)
// =====================================================
app.get('/metadata/:tokenId', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    let rawTokenId = req.params.tokenId;
    if (rawTokenId.endsWith('.json')) rawTokenId = rawTokenId.replace('.json', '');

    if (!/^\d+$/.test(rawTokenId)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({ error: "Invalid Token ID Format" });
    }
    const tokenId = rawTokenId;

    try {
        // ⚡ SMART CONTRACT DIRECT FETCH
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
            const burnedMetadata = {
                name: `BURNED DEED #${tokenId}`,
                description: "This Imperial Sovereign Deed has been permanently burned and sanitized from the registry.",
                image: BURNED_IMAGE_TXID.startsWith("http") ? BURNED_IMAGE_TXID : `https://gateway.irys.xyz/${BURNED_IMAGE_TXID}`,
                attributes: [{ trait_type: "Status", value: "BURNED" }]
            };
            res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=31536000, immutable');
            return res.status(200).json(burnedMetadata);
        }

        const isSanctified = deedData[2];
        const stringsToParse = [deedData[3], deedData[4], deedData[5]]; 
        const dnaString = deedData[6]; 

        const parsedMedia = await Promise.all(stringsToParse.map(txId => detectAndFetchMedia(txId)));

        let finalMetadata = {
            name: `THE IMPERIAL SOVEREIGN DEED #${tokenId}`,
            description: "",
            image: null,
            animation_url: null,
            attributes: []
        };

        let externalLinks = [];

        // 🟢 แกะ JSON ชั้นในเพื่อดึง URL รูปภาพ
        parsedMedia.forEach((media, index) => {
            if (!media) return;
            const originField = index === 0 ? "Front" : index === 1 ? "Back" : "Extra";

            if (media.type === 'json') {
                if (media.data.name) finalMetadata.name = media.data.name;
                if (media.data.description) finalMetadata.description = media.data.description;
                
                // ดึง URL รูปภาพจาก Key "image" ด้านใน JSON Manifest
                if (media.data.image) {
                    finalMetadata.image = media.data.image.startsWith("http") ? media.data.image : `https://gateway.irys.xyz/${media.data.image}`;
                }
                
                if (media.data.attributes && Array.isArray(media.data.attributes)) {
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
            return res.status(404).json({ error: "Artwork data is empty or unassigned" });
        }

        finalMetadata.attributes.push({ trait_type: "Sanctified (NOVA)", value: isSanctified ? "TRUE" : "FALSE" });
        
        // ⚡ UNIVERSAL DNA PARSER (รองรับทั้งแบบคั่นด้วย | และแบบช่องว่างเคาะ spacebar)
        if (dnaString && dnaString !== "UNASSIGNED" && dnaString.trim()) {
            finalMetadata.attributes.push({ trait_type: "Raw Identity DNA", value: dnaString });
            
            if (dnaString.includes('|')) {
                // กรณีเป็น Format เดิม: KEY:VAL|KEY:VAL
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
            } else {
                // กรณีเป็น Format ใหม่: KEY:VAL KEY : VAL
                const regex = /([A-Z0-9_-]+)\s*:\s*(\S+)/g;
                let match;
                while ((match = regex.exec(dnaString)) !== null) {
                    let rawKey = match[1].trim();
                    let val = match[2].trim();
                    let dynamicKey = rawKey.replace(/[-_]/g, ' ').replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
                    finalMetadata.attributes.push({ trait_type: dynamicKey, value: val });
                }
            }
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

// =====================================================
// 🟢 UNIVERSAL SERVER BINDING
// =====================================================
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Imperial Metadata API listening on port ${PORT}`);
    });
}

module.exports = app;