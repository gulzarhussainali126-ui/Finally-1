// ========= SETTINGS =========
const SETTINGS = {
  BUSINESS_NAME: "RGD",
  CITY: "khanqah Dogran",
  PHONE_FOR_CALLS: "0349-1404543",
  OPENING_HOURS: "10 AM - 10 PM",
  BOT_WHATSAPP_NUMBER: "03326954919",
  OWNER_NUMBER_FOR_ALERTS: "923491404543",
  MENU: [
    { id: 1, name: "Pizza - Example", price: 500 },
    { id: 2, name: "Burger - Example", price: 350 },
    { id: 3, name: "Fries - Example", price: 200 },
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
  try {
    if (!SETTINGS.GROQ_API_KEY || SETTINGS.GROQ_API_KEY.length < 20) {
      console.log("KEY MISSING - normal reply");
      return null;
    }
    
    const MODELS = [
      "llama-3.3-70b-versatile",
      "llama-3.1-70b-versatile",
      "llama3-70b-8192",
      "llama3-8b-8192",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
      "llama-3.1-8b-instant"
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
              { role: 'system', content: `You are a friendly human-like WhatsApp assistant for ${SETTINGS.BUSINESS_NAME} in ${SETTINGS.CITY}. Reply in same language user uses (Urdu/Hindi/English). Be short, natural. If asked who are you, say you are assistant of ${SETTINGS.BUSINESS_NAME}. Menu: ${SETTINGS.MENU.map(i=>`${i.id}.${i.name} Rs${i.price}`).join(', ')}. Delivery ${SETTINGS.DELIVERY_TIME}, Fee Rs${SETTINGS.DELIVERY_FEE}. Guide to order like '1x2'` },
              { role: 'user', content: userMsg }
            ],
            temperature: 0.8,
            max_tokens: 200
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
        console.log(`Error with ${model}: ${e.message}`);
        continue;
      }
    }
    return null;
  } catch (e) { console.log("AI Error:", e.message); return null; }
}

async function safeSend(sock, jid, text) { 
  try { await sock.sendMessage(jid, { text }); } catch (e) { console.log("Send fail"); } 
}

function menuText() { 
  let t = `*${SETTINGS.BUSINESS_NAME}* Menu 🍽️\n\n`; 
  SETTINGS.MENU.forEach(i=>{ t+=`${i.id}. ${i.name} - Rs.${i.price}\n`; }); 
  t+=`\nOrder likhein: 1x2, 2\n0 = cancel`; 
  return t; 
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('session_bot');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ 
    auth: state, 
    version, 
    logger, 
    printQRInTerminal: false, 
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', async (u)=>{
    const { connection, qr } = u;
    if(qr && !state.creds.registered && !pairingRequested){
      console.log(`QR: https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`);
      pairingRequested=true; 
      await new Promise(r=>setTimeout(r,1000));
      try{ const code=await sock.requestPairingCode(getBotNumberForPairing()); console.log(`PAIRING CODE: ${code}`);}catch(e){ pairingRequested=false; }
    }
    if(connection==='open'){ console.log('Bot live! AI Active'); pairingRequested=false; }
    if(connection==='close'){ setTimeout(startBot, 4000); }
  });

  sock.ev.on('messages.upsert', async ({type, messages})=>{
    if(type!=='notify') return;
    for(const msg of messages){
      const jid = msg.key.remoteJid; 
      if(!jid || msg.key.fromMe || jid.includes('@g.us') || jid.includes('@broadcast')) continue;
      const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim(); 
      if(!text) continue;
      
      console.log(`Message from ${jid}: ${text}`);
      
      if(text.toLowerCase()==='0' || text.toLowerCase()==='cancel'){ 
        customers.set(jid,{cart:[]}); 
        await safeSend(sock,jid,`Cancelled ✅\n\n${menuText()}`); 
        continue; 
      }

      // STEP 1: Hamesha pehle AI try karo
      const aiReply = await askAI(text);
      if (aiReply) {
        // Agar sirf number bheja hai to order samjho warna AI ka jawab bhejo
        if (!/^\d+[x\d, ]*$/.test(text)) {
          await safeSend(sock, jid, aiReply);
          if (!customers.has(jid)) { 
            customers.set(jid,{cart:[]}); 
            await safeSend(sock, jid, menuText()); 
          }
          continue;
        }
      }

      // STEP 2: Normal menu
      if(!customers.has(jid)){ 
        customers.set(jid,{cart:[]}); 
        await safeSend(sock,jid,`Salam! ${SETTINGS.BUSINESS_NAME} me khush amdeed 👋\n${menuText()}`); 
        continue; 
      }
      await safeSend(sock, jid, aiReply || menuText());
    }
  });
}
startBot();
