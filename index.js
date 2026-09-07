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

        // 🟢 ตรรกะแกะ JSON และดึง URL รูปภาพ (ทำงานตามรูป 1000078435.jpg 100%)
        parsedMedia.forEach((media, index) => {
            if (!media) return;
            const originField = index === 0 ? "Front" : index === 1 ? "Back" : "Extra";

            if (media.type === 'json') {
                if (media.data.name) finalMetadata.name = media.data.name;
                if (media.data.description) finalMetadata.description = media.data.description;
                // เจาะทะลวงดึง TXID รูปภาพที่ซ่อนอยู่ใน JSON
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
            return res.status(404).json({ error: "Artwork data is empty or unassigned" });
        }

        finalMetadata.attributes.push({ trait_type: "Sanctified (NOVA)", value: isSanctified ? "TRUE" : "FALSE" });
        
        // ⚡ ตรรกะใหม่: แกะ DNA String ด้วย Regex สแกนข้าม Spacebar
        // ตัวอย่างเป้าหมาย: IDENTITY_DNA:SAKSIT  PIXEL :X=1014,Y=1754 CHRONO-MAP:12S:FR1-5
        if (dnaString && dnaString !== "UNASSIGNED" && dnaString.trim()) {
            finalMetadata.attributes.push({ trait_type: "Raw Identity DNA", value: dnaString });
            
            // Regex: ดึงตัวอักษรพิมพ์ใหญ่/ขีด (Key) ตามด้วยช่องว่าง(ถ้ามี) โคลอน ช่องว่าง(ถ้ามี) และข้อมูล (Value)
            const regex = /([A-Z0-9_-]+)\s*:\s*(\S+)/g;
            let match;
            
            while ((match = regex.exec(dnaString)) !== null) {
                let rawKey = match[1].trim(); // เช่น IDENTITY_DNA, PIXEL, CHRONO-MAP
                let val = match[2].trim();    // เช่น SAKSIT, X=1014,Y=1754, 12S:FR1-5
                
                // จัด Format Key ให้ดูดีบน OpenSea (เช่น IDENTITY_DNA -> Identity Dna)
                let dynamicKey = rawKey.replace(/[-_]/g, ' ').replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
                
                finalMetadata.attributes.push({ trait_type: dynamicKey, value: val });
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