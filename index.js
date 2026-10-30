// ========= SETTINGS =========
const SETTINGS = {
  BUSINESS_NAME: "RGD",
  BUSINESS_TYPE: "Restaurant",
  CITY: "YOUR CITY",
  PHONE_FOR_CALLS: "0349-1404543",
  OPENING_HOURS: "10 AM - 10 PM",
  BOT_WHATSAPP_NUMBER: "03326954919",
  OWNER_NUMBER_FOR_ALERTS: "923491404543",
  FLOW: "ORDER", // ORDER / BOOKING / INFO ONLY
  MENU: [
    { id: 1, name: "Item 1 - Example Pizza", price: 500 },
    { id: 2, name: "Item 2 - Example Burger", price: 350 },
    { id: 3, name: "Item 3 - Fries", price: 200 },
  ],
  DELIVERY_FEE: 100,
  DELIVERY_TIME: "45 minutes",
  PAYMENT_METHODS: "Cash, JazzCash 03491404543",
  // --- AI SETTINGS - صرف یہ 2 لائن آپ نے بدلنی ہیں ---
  GROQ_API_KEY: process.env.GROQ_API_KEY || "gsk_yahan_apni_key_dalen",
  GROQ_MODEL: "llama-3.1-8b-instant",
};
// ========= END SETTINGS =========

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const logger = pino({ level: 'silent' });
const customers = new Map();
let pairingRequested = false;

function getBotNumberForPairing() {
  let num = SETTINGS.BOT_WHATSAPP_NUMBER.replace(/[^0-9]/g, '');
  if (num.startsWith('0')) num = '92' + num.slice(1);
  if (!num.startsWith('92')) num = '92' + num;
  return num.length < 12 ? '923001234567' : num;
}

// --- AI FUNCTION - پہلے AI سے کوشش، فیل ہو تو null ---
async function askAI(userMsg, contextInfo) {
  try {
    if (!SETTINGS.GROQ_API_KEY || SETTINGS.GROQ_API_KEY.includes('yahan_apni_key')) return null;
    const system = `You are human-like WhatsApp assistant for ${SETTINGS.BUSINESS_NAME} in ${SETTINGS.CITY}. Phone ${SETTINGS.PHONE_FOR_CALLS}, Hours ${SETTINGS.OPENING_HOURS}. Menu: ${SETTINGS.MENU.map(i=>`${i.id}.${i.name} Rs${i.price}`).join(', ')}. Current step: ${contextInfo}. Reply short friendly English with 1 emoji. If user wants to order, guide to send like 1x2. Max 2 lines.`;
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SETTINGS.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SETTINGS.GROQ_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        temperature: 0.7,
        max_tokens: 180
      })
    });
    const data = await res.json();
    if (data.error) { console.log('Groq fail, going normal:', data.error.message); return null; }
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.log('AI fail, fallback to normal board:', e.message);
    return null;
  }
}

function genId() { return 'ORD-' + Math.floor(100000 + Math.random() * 900000); }
function menuText() { let t = `*${SETTINGS.BUSINESS_NAME}* Menu 🍽️\n\n`; SETTINGS.MENU.forEach(i=>{ t+=`${i.id}. ${i.name} - Rs.${i.price}\n`; }); t+=`\nOrder like: 1x2, 2\n0=cancel`; return t; }
function welcomeText() { return `Hello! Welcome to *${SETTINGS.BUSINESS_NAME}* 👋\n📍 ${SETTINGS.CITY}\n📞 ${SETTINGS.PHONE_FOR_CALLS}\n⏰ ${SETTINGS.OPENING_HOURS}\n\nReply *1* or *MENU* for menu`; }
function parseOrder(txt){ const p=txt.split(','); let out=[]; for(let s of p){ s=s.trim(); let m=s.match(/^(\d+)x(\d+)$/i); if(m){ let f=SETTINGS.MENU.find(x=>x.id==m[1]); if(f) out.push({...f, qty:parseInt(m[2])}); } else if(/^\d+$/.test(s)){ let f=SETTINGS.MENU.find(x=>x.id==s); if(f) out.push({...f, qty:1}); } } return out; }
async function safeSend(sock,jid,txt){ try{ await sock.sendMessage(jid,{text:txt}); }catch(e){ console.log('send fail',e.message); } }

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('session_bot');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, version, logger, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome') });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u)=>{
    const { connection, lastDisconnect, qr } = u;
    if(qr && !state.creds.registered){
      console.log(`QR LINK: https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`);
      if(!pairingRequested){ pairingRequested=true; await new Promise(r=>setTimeout(r,1000)); try{ const c=await sock.requestPairingCode(getBotNumberForPairing()); console.log(`PAIRING CODE: ${c}`);}catch(e){ pairingRequested=false; } }
    }
    if(connection==='open'){ console.log('Bot live'); pairingRequested=false; }
    if(connection==='close'){
      const rec = lastDisconnect?.error?.output?.statusCode !== 401;
      if(!rec){ try{ fs.rmSync('session_bot',{recursive:true,force:true}); }catch{} setTimeout(startBot,2000); } else setTimeout(startBot,4000);
    }
  });

  sock.ev.on('messages.upsert', async ({type, messages})=>{
    if(type!=='notify') return;
    for(const msg of messages){
      try{
        const jid = msg.key.remoteJidAlt || msg.key.remoteJid;
        if(!jid || msg.key.fromMe || jid.includes('@g.us') || jid.includes('@broadcast') || jid.includes('@newsletter')) continue;
        const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
        if(!text) continue;
        const lower = text.toLowerCase();

        if(!customers.has(jid)) customers.set(jid,{step:'WELCOME', cart:[]});
        const cust = customers.get(jid);

        if(lower==='0' || lower==='cancel'){ customers.set(jid,{step:'WELCOME', cart:[]}); await safeSend(sock,jid,`Cancelled ✅\n\n${welcomeText()}`); continue; }

        // --- WELCOME : پہلے AI کوشش ---
        if(cust.step==='WELCOME'){
          let ai = await askAI(text, 'new user said hi, welcome him warmly');
          await safeSend(sock,jid, ai || welcomeText());
          cust.step='WAIT_MENU'; continue;
        }

        if(cust.step==='WAIT_MENU'){
          if(lower==='1' || lower==='menu'){ await safeSend(sock,jid, menuText()); cust.step='MENU'; continue; }
          let ai = await askAI(text, 'user is chatting before menu, answer human-like and ask to type MENU');
          await safeSend(sock,jid, ai || `Reply *1* or *MENU* to see menu 😊`);
          continue;
        }

        if(cust.step==='MENU'){
          let items = parseOrder(text, SETTINGS.MENU);
          if(items.length===0){
            let ai = await askAI(text, 'user typed wrong order format, explain to order like 1x2, 2');
            await safeSend(sock,jid, ai || menuText()); continue;
          }
          cust.cart=items; cust.step='CONFIRM';
          let total = items.reduce((s,i)=>s+i.price*i.qty,0)+SETTINGS.DELIVERY_FEE;
          await safeSend(sock,jid,`🛒 Cart: ${items.map(i=>`${i.name} x${i.qty}`).join(', ')}\nTotal Rs.${total}\n\nReply YES to confirm, MENU to add, 0 to cancel`);
          continue;
        }

        if(cust.step==='CONFIRM'){
          if(lower.includes('yes') || lower==='1'){
            let ai = await askAI(text, 'user confirmed cart, now ask for full address politely');
            await safeSend(sock,jid, ai || `Thanks! Please send your full address 📍 with landmark`);
            cust.step='ADDRESS'; continue;
          }
          let ai = await askAI(text, 'user in confirm step, guide to say YES or MENU');
          await safeSend(sock,jid, ai || `Reply YES to confirm`);
          continue;
        }

        if(cust.step==='ADDRESS'){
          let id=genId();
          await safeSend(sock,jid,`✅ Order Confirmed! *${id}*\nWill reach in *${SETTINGS.DELIVERY_TIME}* 🚚\nAddress: ${text}\nThank you ❤️`);
          if(SETTINGS.OWNER_NUMBER_FOR_ALERTS){ try{ await sock.sendMessage(SETTINGS.OWNER_NUMBER_FOR_ALERTS.replace(/[^0-9]/g,'')+'@s.whatsapp.net',{text:`🔔 NEW ORDER ${id}\nFrom ${jid}\nItems: ${cust.cart.map(c=>c.name+' x'+c.qty).join(', ')}\nAddr: ${text}`}); }catch{} }
          customers.set(jid,{step:'WELCOME', cart:[]}); continue;
        }

      }catch(e){ console.log(e.message); }
    }
  });
}
startBot();
