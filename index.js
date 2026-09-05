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
let sock; // Declared globally so the /send API endpoint can access the WhatsApp connection

// IMPORTANT: Enable JSON body parsing so Express can read payloads from cPanel PHP scripts
app.use(express.json());

// 1. CLEAN KEEP-ALIVE & STATUS ENDPOINTS
app.get('/ping', (req, res) => res.status(200).json({ status: "awake", timestamp: Date.now() }));
app.get('/', (req, res) => res.send(`Radiant Bot is Online. Status: ${botStatus}`));
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
// 2. THE MISSING OUTBOUND API ENDPOINT (Receives reports from cPanel & sends to WhatsApp)
// =========================================================================
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ status: "error", message: "Missing phone or message payload." });
    }
    if (!sock || botStatus !== "Connected") {
        return res.status(503).json({ status: "error", message: "WhatsApp socket is not connected." });
    }
    
    try {
        // Strip out spaces, dashes, or plus signs and format as a standard WhatsApp JID
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        const jid = `${cleanPhone}@s.whatsapp.net`;
        
        await sock.sendMessage(jid, { text: String(message) });
        console.log(`Outbound API message successfully dispatched to ${cleanPhone}`);
        res.status(200).json({ status: "success", message: "Message sent to WhatsApp." });
    } catch (err) {
        console.error(`Failed to send API message to ${phone}:`, err.message);
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.listen(port, '0.0.0.0', () => { setTimeout(connectToWhatsApp, 3000); });

// 3. AUTO-RETRY WEBHOOK SENDER (Prevents freezing during rapid typing)
async function sendToCrmWithRetry(socket, remoteJid, payload, maxRetries = 3) {
    const crmUrl = 'https://idigital.rad-prop.com/idigital_bot.php'; 
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const crmResponse = await axios.post(crmUrl, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 20000 // 20 seconds to allow shared hosting enough time during CPU spikes
            });

            if (crmResponse.data && crmResponse.data.reply) {
                await socket.sendMessage(remoteJid, { text: String(crmResponse.data.reply) });
            }
            return; 
        } catch (error) {
            console.log(`Webhook attempt ${attempt} failed: ${error.message}. Retrying in 1.5s...`);
            if (attempt === maxRetries) {
                console.error("All retry attempts exhausted for webhook.");
                await socket.sendMessage(remoteJid, { text: "⚠️ Our server is momentarily busy. Please resend your last message!" });
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }
}

async function connectToWhatsApp() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('auth_session_v5');

        // Assign to global sock variable
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

        // 4. UNIVERSAL MEDIA & TEXT RECEIVER
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
                    console.log("Downloading incoming WhatsApp photo...");
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    if (buffer) {
                        base64Image = buffer.toString('base64');
                        console.log("Photo downloaded! Sending to CRM...");
                    }
                } catch (imgErr) {
                    console.error("Failed to download incoming WhatsApp image:", imgErr.message);
                }
            }

            if (incomingText || (lat && lng) || base64Image) {
                const payload = {
                    message: incomingText || (base64Image ? "PHOTO_UPLOADED" : "LOCATION_SHARED"),
                    phone: senderPhone,
                    latitude: lat,
                    longitude: lng,
                    media_data: base64Image
                };

                await sendToCrmWithRetry(sock, msg.key.remoteJid, payload);
            }
        });
    } catch (err) { console.error("Initialization error:", err.message); }
}
