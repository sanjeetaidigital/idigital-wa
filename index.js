const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode');
const pino = require('pino');

process.on('uncaughtException', err => console.error('Caught exception:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err.message));

const app = express();
const port = process.env.PORT || 10000;
let qrCodeDataURL = "";
let botStatus = "Starting...";
let sock; 

app.use(express.json());

// =========================================================================
// ANTI-BAN QUEUE & HUMAN SIMULATION ENGINE
// =========================================================================
const messageQueue = [];
let isProcessingQueue = false;

function getRandomDelay(min = 4000, max = 10000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const task = messageQueue.shift();
        try {
            await task();
        } catch (err) {
            console.error("Queue task execution error:", err.message);
        }
        await new Promise(resolve => setTimeout(resolve, getRandomDataSpacing()));
    }
    isProcessingQueue = false;
}

function getRandomDataSpacing() {
    return Math.floor(Math.random() * 2000) + 2000; // 2 to 4 seconds gap between separate users
}

// 1. CLEAN KEEP-ALIVE & STATUS ENDPOINTS
app.get('/ping', (req, res) => res.status(200).json({ status: "awake", timestamp: Date.now() }));
app.get('/', (req, res) => res.send(`iDigital Bot is Online. Status: ${botStatus}`));
app.get('/qr', (req, res) => {
    if (botStatus === "Connected") {
        return res.send("<h2 style='font-family:Arial; color:green; text-align:center; margin-top:50px;'>✅ Bot is securely connected to WhatsApp!</h2>");
    }
    if (!qrCodeDataURL) {
        return res.send("<meta http-equiv='refresh' content='2'><h2 style='font-family:Arial; text-align:center; margin-top:50px;'>⏳ Generating your secure QR code... Please wait.</h2>");
    }
    res.send(`
        <html><body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h2>Scan this QR Code with your Central WhatsApp</h2>
            <img src="${qrCodeDataURL}" style="width: 300px; height: 300px; border-radius: 10px;" />
            <script>setTimeout(() => location.reload(), 10000);</script>
        </body></html>
    `);
});

// =========================================================================
// 2. OUTBOUND API ENDPOINT (With Anti-Ban Throttling)
// =========================================================================
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ status: "error", message: "Missing phone or message payload." });
    }
    if (!sock || botStatus !== "Connected") {
        return res.status(503).json({ status: "error", message: "WhatsApp socket is not connected." });
    }
    
    messageQueue.push(async () => {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        const jid = `${cleanPhone}@s.whatsapp.net`;
        
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 4000)));
        await sock.sendPresenceUpdate('paused', jid);

        await sock.sendMessage(jid, { text: String(message) });
        console.log(`Throttled outbound API message dispatched to ${cleanPhone}`);
    });

    processQueue();
    res.status(200).json({ status: "success", message: "Message queued for throttled delivery." });
});

app.listen(port, '0.0.0.0', () => { setTimeout(connectToWhatsApp, 3000); });

// 3. AUTO-RETRY WEBHOOK SENDER WITH HUMAN SIMULATION
async function sendToCrmWithRetry(socket, remoteJid, payload, maxRetries = 3) {
    const crmUrl = 'https://idigital.rad-prop.com/idigital_bot.php'; 
    
    try {
        await socket.presenceSubscribe(remoteJid);
        await socket.sendPresenceUpdate('composing', remoteJid);
        
        // ⏳ UPDATED: Random typing delay between 4 to 10 seconds
        await new Promise(resolve => setTimeout(resolve, getRandomDelay(4000, 10000)));
        
        await socket.sendPresenceUpdate('paused', remoteJid);
    } catch (presErr) {}

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const crmResponse = await axios.post(crmUrl, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 20000 
            });

            if (crmResponse.data && crmResponse.data.reply) {
                await socket.sendMessage(remoteJid, { text: String(crmResponse.data.reply) });
            }
            return; 
        } catch (error) {
            console.log(`Webhook attempt ${attempt} failed: ${error.message}. Retrying in 2s...`);
            if (attempt === maxRetries) {
                console.error("All retry attempts exhausted for webhook. Failing silently.");
                break; // Just exits silently without messaging the user
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

async function connectToWhatsApp() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('auth_session_v5');

        sock = makeWASocket({
            version, auth: state,
            browser: ["Mac OS", "Chrome", "120.0.0"], 
            logger: pino({ level: 'silent' }), 
            printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { botStatus = "Waiting for Scan"; qrCodeDataURL = await qrcode.toDataURL(qr); }
            if (connection === 'close') {
                if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(connectToWhatsApp, 5000); 
                } else { botStatus = "Logged Out."; }
            } else if (connection === 'open') {
                botStatus = "Connected"; qrCodeDataURL = "";
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // 4. UNIVERSAL MEDIA & TEXT RECEIVER WITH QUEUE ENFORCEMENT
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const content = msg.message.ephemeralMessage?.message || 
                            msg.message.viewOnceMessage?.message || 
                            msg.message.viewOnceMessageV2?.message || 
                            msg.message.viewOnceMessageV2Extension?.message || 
                            msg.message.documentWithCaptionMessage?.message || 
                            msg.message;

            const incomingText = (content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || "").trim();
            const senderPhone = msg.key.remoteJid.split('@')[0]; 

            const lat = content.locationMessage?.degreesLatitude || null;
            const lng = content.locationMessage?.degreesLongitude || null;

            const isImage = content.imageMessage || 
                            (content.documentMessage && content.documentMessage.mimetype?.includes('image'));

            let base64Image = null;
            if (isImage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    if (buffer) {
                        base64Image = buffer.toString('base64');
                    }
                } catch (imgErr) {
                    console.error("Failed to download incoming WhatsApp image:", imgErr.message);
                }
            }

            if (incomingText || (lat && lng) || base64Image) {
                messageQueue.push(async () => {
                    const payload = {
                        message: incomingText || (base64Image ? "PHOTO_UPLOADED" : "LOCATION_SHARED"),
                        phone: senderPhone,
                        latitude: lat,
                        longitude: lng,
                        media_data: base64Image
                    };
                    await sendToCrmWithRetry(sock, msg.key.remoteJid, payload);
                });

                processQueue();
            }
        });
    } catch (err) { console.error("Initialization error:", err.message); }
}
