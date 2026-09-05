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

// QR & Status Endpoints[cite: 2]
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

// Outbound API Endpoint[cite: 2]
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ status: "error", message: "Missing phone or message payload." });
    if (!sock || botStatus !== "Connected") return res.status(503).json({ status: "error", message: "WhatsApp socket is not connected." });
    
    try {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        const jid = `${cleanPhone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: String(message) });
        res.status(200).json({ status: "success", message: "Message sent to WhatsApp." });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.listen(port, '0.0.0.0', () => { setTimeout(connectToWhatsApp, 3000); });

// Webhook Sender to cPanel[cite: 2]
async function sendToCrmWithRetry(socket, remoteJid, payload, maxRetries = 3) {
    // UPDATE THIS URL TO YOUR CPANEL PHP FILE
    const crmUrl = 'https://idigital.rad-prop.com/idigital_bot.php'; 
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const crmResponse = await axios.post(crmUrl, payload, {
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                timeout: 20000 
            });

            if (crmResponse.data && crmResponse.data.reply) {
                await socket.sendMessage(remoteJid, { text: String(crmResponse.data.reply) });
            }
            return; 
        } catch (error) {
            if (attempt === maxRetries) {
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
        const { state, saveCreds } = await useMultiFileAuthState('auth_session_idigital');

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

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const content = msg.message.ephemeralMessage?.message || 
                            msg.message.viewOnceMessage?.message || 
                            msg.message.viewOnceMessageV2?.message || 
                            msg.message.documentWithCaptionMessage?.message || 
                            msg.message;

            const incomingText = (content.conversation || content.extendedTextMessage?.text || "").trim();
            let senderPhone = msg.key.remoteJid.split('@')[0];

// If it's a multi-device LID or internal Baileys identifier (contains non-standard length or letters)
if (msg.key.participant) {
    senderPhone = msg.key.participant.split('@')[0];
}

// Ensure we only pass clean digits to your PHP webhook
senderPhone = senderPhone.replace(/[^0-9]/g, '');
            if (incomingText) {
                const payload = { message: incomingText, phone: senderPhone };
                await sendToCrmWithRetry(sock, msg.key.remoteJid, payload);
            }
        });
    } catch (err) { console.error("Initialization error:", err.message); }
}
