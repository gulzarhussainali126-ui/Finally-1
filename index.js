// ========= SETTINGS FOR RGD =========
const SETTINGS = {
  BUSINESS_NAME: "RGD",
  CITY: "Khanqah Dogran",
  PHONE_FOR_CALLS: "03326954919",
  OPENING_HOURS: "10 AM - 10 PM",
  BOT_WHATSAPP_NUMBER: "03326954919",
  OWNER_NUMBER_FOR_ALERTS: "923491404543",
  MENU: [
    { id: 1, name: "Chicken Biryani", price: 350 },
    { id: 2, name: "Zinger Burger", price: 450 },
    { id: 3, name: "Pizza Small", price: 650 },
  ],
  DELIVERY_FEE: 100,
  DELIVERY_TIME: "45 minutes",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
};
// ========= END =========

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const logger = pino({ level: 'silent' });
const customers = new Map();
let pairingRequested = false;

function getBotNumberForPairing() {
  let num = SETTINGS.BOT_WHATSAPP_NUMBER.replace(/[^0-9]/g, '');
  if (num.startsWith('0')) num = '92' + num.slice(1);
  if (!num.startsWith('92')) num = '92' + num;
  return num;
}

async function askAI(userMsg) {
  if (!SETTINGS.GROQ_API_KEY || SETTINGS.GROQ_API_KEY.length < 20) {
    console.log("KEY MISSING");
    return null;
  }
  // October 2026 - Naye active models
  const MODELS = [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b"
  ];

  for (let model of MODELS) {
    try {
      console.log(`Trying model: ${model} for: ${userMsg}`);
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SETTINGS.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: `You are friendly human assistant for RGD food business in Khanqah Dogran. Reply in same language as user (Urdu/English). Be short natural. If asked who are you, say 'Me RGD ka assistant hon'. Menu: ${SETTINGS.MENU.map(i=>`${i.id}.${i.name} Rs${i.price}`).join(', ')}. Delivery ${SETTINGS.DELIVERY_TIME}, Fee Rs${SETTINGS.DELIVERY_FEE}. Guide to order like '1x2, 2' and owner number ${SETTINGS.PHONE_FOR_CALLS}` },
            { role: 'user', content: userMsg }
          ],
          temperature: 0.8,
          max_tokens: 250
        })
      });
      const data = await res.json();
      if (data.error) {
        console.log(`${model} FAIL: ${data.error.message}`);
        continue;
      }
      console.log(`SUCCESS with ${model}`);
      return data.choices[0].message.content;
    } catch (e) {
      console.log(`Error ${model}: ${e.message}`);
      continue;
    }
  }
  return null;
}

async function safeSend(sock, jid, text) { try { await sock.sendMessage(jid, { text }); } catch(e){} }
function menuText() { let t = `*RGD* - Khanqah Dogran Menu 🍽️\n\n`; SETTINGS.MENU.forEach(i=>{ t+=`${i.id}. ${i.name} - Rs.${i.price}\n`; }); t+=`\nOrder: 1x2, 2 likhein\n0 = cancel`; return t; }

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('session_bot');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, version, logger, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), syncFullHistory: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u)=>{
    const { connection, qr } = u;
    if(qr && !state.creds.registered && !pairingRequested){
      console.log(`QR Link: https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`);
      pairingRequested=true; await new Promise(r=>setTimeout(r,2000));
      try{ const code=await sock.requestPairingCode(getBotNumberForPairing()); console.log(`PAIRING CODE: ${code}`);}catch(e){ pairingRequested=false; }
    }
    if(connection==='open'){ console.log('RGD Bot live! AI Active'); pairingRequested=false; }
    if(connection==='close'){ setTimeout(startBot, 4000); }
  });

  sock.ev.on('messages.upsert', async ({type, messages})=>{
    if(type!=='notify') return;
    for(const msg of messages){
      const jid = msg.key.remoteJid; if(!jid || msg.key.fromMe || jid.includes('@g.us') || jid.includes('@broadcast')) continue;
      const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim(); if(!text) continue;
      console.log(`Msg from ${jid}: ${text}`);
      if(text.toLowerCase()==='0' || text.toLowerCase()==='cancel'){ customers.set(jid,{cart:[]}); await safeSend(sock,jid,`Cancelled ✅\n\n${menuText()}`); continue; }

      const aiReply = await askAI(text);
      if (aiReply) {
        if (!/^\d+[x\d, ]*$/.test(text)) {
          await safeSend(sock, jid, aiReply);
          if (!customers.has(jid)) { customers.set(jid,{cart:[]}); await safeSend(sock, jid, menuText()); }
          continue;
        }
      }
      if(!customers.has(jid)){ customers.set(jid,{cart:[]}); await safeSend(sock,jid,`Salam! RGD Khanqah Dogran me khush amdeed 👋\n${menuText()}`); continue; }
      await safeSend(sock, jid, aiReply || menuText());
    }
  });
}
startBot();
