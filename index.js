const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { ethers } = require('ethers');

const app = express();
app.use(cors());

// ==========================================
// ⚙️ IMPERIAL INFRASTRUCTURE CONFIG
// ==========================================
const CONTRACT_ADDRESS = "0x7d52930e1F0c6429200a0DFe02Be9Ac2d2A19Dd2"; 
const ARWEAVE_GATEWAY = "https://arweave.net/"; 

// 🔥 ยัด Alchemy ของพี่ขึ้นเป็น Node หลัก (เบอร์ 1)
const RPC_ENDPOINTS = [
    "https://base-mainnet.g.alchemy.com/v2/alch_AcCVEY7kJgG8EQ7qkQnQl",
    "https://mainnet.base.org",
    "https://base.llamarpc.com"
];

const ABI = [
    "function getDeedData(uint256 t) external view returns (address owner, bool active, bool sanctified, string memory front, string memory back, string memory video, string memory dna, string memory hidden)"
];

function formatUrl(txIdOrUrl) {
    if (!txIdOrUrl || txIdOrUrl === "UNASSIGNED" || txIdOrUrl.trim() === "") return null;
    if (txIdOrUrl.startsWith('http')) return txIdOrUrl.replace('https://gateway.irys.xyz/', ARWEAVE_GATEWAY);
    return `${ARWEAVE_GATEWAY}${txIdOrUrl}`;
}

async function isVideoFile(url) {
    if (!url) return false;
    try {
        const response = await axios.head(url, { timeout: 3000 });
        const contentType = response.headers['content-type'];
        return contentType && contentType.startsWith('video/');
    } catch (error) {
        return false;
    }
}

// 🧬 ฟังก์ชันหั่น DNA ฉบับ FINAL (ล็อคเป้าแค่ 3 ค่าเท่านั้น!)
function parseDNAString(dnaString, attributesArray) {
    if (!dnaString || dnaString === "UNASSIGNED") return;

    const parts = dnaString.split('|').map(part => part.trim());
    
    let identityDnaValue = "";
    let pixelValue = "";
    let chronoMapValue = "";

    parts.forEach(part => {
        const colonIndex = part.indexOf(':');
        if (colonIndex > -1) {
            const rawKey = part.substring(0, colonIndex).trim().toUpperCase();
            const value = part.substring(colonIndex + 1).trim();

            if (rawKey === 'NAME' || rawKey === 'ID' || rawKey === 'IDENTITY_DNA') {
                if (!identityDnaValue) identityDnaValue = value; 
            } else if (rawKey === 'COORD' || rawKey === 'PIXEL') {
                pixelValue = value; 
            } else if (rawKey === 'MAP' || rawKey === 'CHRONO-MAP') {
                chronoMapValue = value; 
            }
        }
    });

    if (identityDnaValue) attributesArray.push({ trait_type: "IDENTITY_DNA", value: identityDnaValue });
    if (pixelValue) attributesArray.push({ trait_type: "PIXEL", value: pixelValue });
    if (chronoMapValue) attributesArray.push({ trait_type: "CHRONO-MAP", value: chronoMapValue });
}

// 🚀 Route หลักที่รับ Request จาก OpenSea
app.get('/metadata/:tokenId', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    let rawTokenId = req.params.tokenId; 
    if (!rawTokenId) return res.status(400).json({ error: "Missing Token ID" });
    if (rawTokenId.endsWith('.json')) rawTokenId = rawTokenId.replace('.json', '');

    if (!/^\d+$/.test(rawTokenId)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({ error: "Invalid Token ID Format" });
    }
    const tokenId = rawTokenId;

    try {
        let deedData = null;
        for (const rpc of RPC_ENDPOINTS) {
            try {
                const provider = new ethers.JsonRpcProvider(rpc);
                const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
                deedData = await contract.getDeedData(tokenId);
                break; 
            } catch (rpcError) {
                console.warn(`RPC Failed: ${rpc}`);
            }
        }

        if (!deedData) throw new Error("CRITICAL: All RPC Endpoints Failed");

        const isActive = deedData[1];
        if (!isActive) {
            res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=59');
            return res.status(200).json({
                name: `BURNED DEED #${tokenId}`,
                description: "This Imperial Sovereign Deed has been permanently burned.",
                image: "https://arweave.net/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR",
                attributes: [{ trait_type: "Status", value: "BURNED" }]
            });
        }

        const isSanctified = deedData[2];
        const frontTxId = deedData[3]; 
        const backTxId = deedData[4];  
        const videoTxId = deedData[5]; 
        const dnaString = deedData[6];   

        if (!frontTxId || frontTxId === "UNASSIGNED") {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(404).json({ error: "Metadata not forged yet" });
        }

        const jsonUrl = formatUrl(frontTxId);
        const response = await axios.get(jsonUrl, { timeout: 5000 });
        const rawJson = response.data;

        const imageUrl = formatUrl(rawJson.image);
        const backUrl = formatUrl(backTxId);
        const videoUrl = formatUrl(videoTxId);

        let cleanAttributes = [];
        if (rawJson.attributes && Array.isArray(rawJson.attributes)) {
            const overrideKeys = ["Sanctified (NOVA)", "IDENTITY_DNA", "PIXEL", "CHRONO-MAP"];
            cleanAttributes = rawJson.attributes.filter(attr => !overrideKeys.includes(attr.trait_type));
        }

        cleanAttributes.push({ trait_type: "Sanctified (NOVA)", value: isSanctified ? "TRUE" : "FALSE" });
        
        // 🧬 เรียกใช้ฟังก์ชันหั่น DNA
        parseDNAString(dnaString, cleanAttributes);

        let enhancedDescription = rawJson.description || "";
        let finalAnimationUrl = null;

        if (videoUrl) {
            finalAnimationUrl = videoUrl;
            if (backUrl) enhancedDescription += `\n\n---\n📜 **[View Back Deed (Imperial Archives)](${backUrl})**`;
        } else if (backUrl) {
            const isVideo = await isVideoFile(backUrl);
            if (isVideo) {
                finalAnimationUrl = backUrl;
            } else {
                enhancedDescription += `\n\n---\n📜 **[View Back Deed (Imperial Archives)](${backUrl})**`;
            }
        }

        const finalMetadata = {
            name: rawJson.name || `THE IMPERIAL SOVEREIGN DEED #${tokenId}`,
            description: enhancedDescription,
            image: imageUrl, 
            attributes: cleanAttributes
        };

        if (finalAnimationUrl) {
            finalMetadata.animation_url = finalAnimationUrl;
        }

        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=59');
        return res.status(200).json(finalMetadata);

    } catch (error) {
        console.error(`Execution Error on Token ${tokenId}:`, error.message);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
            name: `THE IMPERIAL SOVEREIGN DEED #${tokenId}`,
            description: "Syncing with Imperial Archives... Please refresh metadata shortly.",
            image: "https://arweave.net/h7htGqvcxcaBF7RGj94s1GBucfAKDkVcHTSRQJRQTtR"
        });
    }
});

module.exports = app;
