// ========= SETTINGS - EDIT HERE =========
const SETTINGS = {
  BUSINESS_NAME: "YOUR BUSINESS NAME",
  BUSINESS_TYPE: "YOUR BUSINESS TYPE (restaurant / pizza shop / salon / clinic / shop)",
  CITY: "YOUR CITY",
  PHONE_FOR_CALLS: "YOUR PHONE FOR CALLS (e.g. 0300-1234567)",
  OPENING_HOURS: "YOUR OPENING HOURS (e.g. 10 AM - 10 PM)",
  BOT_WHATSAPP_NUMBER: "03326954919", // e.g. 03001234567 - used for pairing
  OWNER_NUMBER_FOR_ALERTS: "92XXXXXXXXXX", // optional, for new orders e.g. 923001234567
  FLOW: "ORDER", // ORDER / BOOKING / INFO ONLY

  MENU: [
    { id: 1, name: "Item 1 - Example Pizza", price: 500 },
    { id: 2, name: "Item 2 - Example Burger", price: 350 },
    { id: 3, name: "Item 3 - Example Fries", price: 200 },
    { id: 4, name: "Item 4 - Example Drink", price: 100 },
    { id: 5, name: "Item 5 - Example Deal", price: 999 },
  ],
  DELIVERY_FEE: 100,
  DELIVERY_TIME: "45 minutes",
  PAYMENT_METHODS: "Cash, JazzCash / EasyPaisa - Account: 03XXXXXXXXX - YOUR NAME",
  EXTRA_RULES: "YOUR EXTRA RULES",
};
// ========= END SETTINGS =========

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const logger = pino({ level: 'silent' });
const customers = new Map(); // jid -> state
let pairingRequested = false;

function getBotNumberForPairing() {
  let num = SETTINGS.BOT_WHATSAPP_NUMBER.replace(/[^0-9]/g, '');
  if (num.startsWith('0')) num = '92' + num.slice(1);
  if (!num.startsWith('92')) num = '92' + num;
  if (num.length < 12) num = '923001234567'; // placeholder fallback
  return num;
}

function parseOrder(text, menu) {
  const parts = text.split(',').map(s => s.trim()).filter(Boolean);
  const items = [];
  for (let p of parts) {
    let m = p.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (m) {
      let id = parseInt(m[1]); let qty = parseInt(m[2]);
      let found = menu.find(i => i.id === id);
      if (found) items.push({ ...found, qty });
    } else if (/^\d+$/.test(p)) {
      let id = parseInt(p);
      let found = menu.find(i => i.id === id);
      if (found) items.push({ ...found, qty: 1 });
    }
  }
  return items;
}

function cartSummary(cart) {
  let total = 0;
  let lines = cart.map(c => {
    let sub = c.price * c.qty;
    total += sub;
    return `${c.id}. ${c.name} x${c.qty} = Rs.${sub}`;
  });
  return { lines, total };
}

function genId() { return 'ORD-' + Math.floor(100000 + Math.random() * 900000); }
function genBookingId() { return 'BOOK-' + Math.floor(100000 + Math.random() * 900000); }

function menuText() {
  let txt = `*${SETTINGS.BUSINESS_NAME}* Menu 🍽️\n\n`;
  SETTINGS.MENU.forEach(i => { txt += `${i.id}. ${i.name} - Rs.${i.price}\n`; });
  txt += `\nTo order, send numbers like: 1x2, 2, 3\nExample: 1x2 means 2 quantity of item 1.\n\nSend 0 or CANCEL to cancel.`;
  return txt;
}

function welcomeText() {
  return `Hello! Welcome to *${SETTINGS.BUSINESS_NAME}* 👋\n📍 ${SETTINGS.CITY}\n📞 For calls: ${SETTINGS.PHONE_FOR_CALLS}\n⏰ ${SETTINGS.OPENING_HOURS}\n\nReply *1* or *MENU* to see the menu.\nReply *0* to cancel anytime.`;
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
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (!state.creds.registered) {
        const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
        console.log(`QR LINK: ${qrLink}`);
        console.log('Scan QR from link or use pairing code below.');
        if (!pairingRequested) {
          pairingRequested = true;
          try {
            await new Promise(r => setTimeout(r, 1000));
            const pairingNumber = getBotNumberForPairing();
            const code = await sock.requestPairingCode(pairingNumber);
            console.log(`PAIRING CODE: ${code}`);
            console.log(`Go to WhatsApp > Linked Devices > Link with phone number > Enter: ${code}`);
          } catch (e) {
            console.log('Pairing code error:', e.message);
            pairingRequested = false;
          }
        }
      }
    }

    if (connection === 'open') {
      console.log('✅ Bot is live! Connected as:', sock.user?.id);
      pairingRequested = false;
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
      console.log('Connection closed. Logged out?', !shouldReconnect);
      if (!shouldReconnect) {
        console.log('Deleting session_bot and starting fresh...');
        try { fs.rmSync('session_bot', { recursive: true, force: true }); } catch {}
        pairingRequested = false;
        setTimeout(startBot, 2000);
      } else {
        console.log('Reconnecting in 4 seconds...');
        setTimeout(startBot, 4000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJidAlt || msg.key.remoteJid;
        if (!jid) continue;
        if (msg.key.fromMe) continue;
        if (jid.includes('@g.us')) continue;
        if (jid.includes('@broadcast')) continue;
        if (jid.includes('@newsletter')) continue;

        const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
        if (!text) continue;

        const lower = text.toLowerCase();

        if (!customers.has(jid)) {
          customers.set(jid, { step: 'WELCOME', cart: [], booking: {} });
        }
        const cust = customers.get(jid);

        // Global cancel
        if (lower === '0' || lower === 'cancel') {
          customers.set(jid, { step: 'WELCOME', cart: [], booking: {} });
          await safeSend(sock, jid, `Order cancelled ✅\n\n${welcomeText()}`);
          continue;
        }

        // First message welcome
        if (cust.step === 'WELCOME') {
          if (['menu', '1', 'hi', 'hello', 'salam', 'hey'].includes(lower) || true) {
            // any first message triggers welcome + menu hint
            if (lower === 'menu' || lower === '1') {
              cust.step = SETTINGS.FLOW === 'BOOKING' ? 'BOOKING_SERVICE' : 'MENU';
              let reply = SETTINGS.FLOW === 'BOOKING' ? bookingServiceText() : menuText();
              await safeSend(sock, jid, reply);
            } else {
              // first ever message
              await safeSend(sock, jid, welcomeText());
              cust.step = 'WELCOME_WAIT';
            }
            continue;
          }
        }

        if (cust.step === 'WELCOME_WAIT') {
          if (lower === 'menu' || lower === '1') {
            cust.step = SETTINGS.FLOW === 'BOOKING' ? 'BOOKING_SERVICE' : 'MENU';
            let reply = SETTINGS.FLOW === 'BOOKING' ? bookingServiceText() : menuText();
            await safeSend(sock, jid, reply);
          } else {
            await safeSend(sock, jid, `Please reply *1* or *MENU* to see menu 😊\nReply 0 to cancel.`);
          }
          continue;
        }

        // ===== INFO ONLY FLOW =====
        if (SETTINGS.FLOW === 'INFO ONLY') {
          if (lower === 'menu' || lower === '1') {
            await safeSend(sock, jid, menuText() + `\n\n📞 Call: ${SETTINGS.PHONE_FOR_CALLS}\n⏰ ${SETTINGS.OPENING_HOURS}`);
          } else {
            await safeSend(sock, jid, welcomeText());
          }
          continue;
        }

        // ===== BOOKING FLOW =====
        if (SETTINGS.FLOW === 'BOOKING') {
          await handleBooking(sock, jid, cust, text, lower);
          continue;
        }

        // ===== ORDER FLOW =====
        await handleOrder(sock, jid, cust, text, lower);

      } catch (e) {
        console.log('Handler error:', e.message);
      }
    }
  });
}

function bookingServiceText() {
  let txt = `*${SETTINGS.BUSINESS_NAME}* - Booking 📅\nPick a service:\n\n`;
  SETTINGS.MENU.forEach(i => { txt += `${i.id}. ${i.name} - Rs.${i.price}\n`; });
  txt += `\nReply with service number (e.g. 1)\nSend 0 to cancel.`;
  return txt;
}

async function handleBooking(sock, jid, cust, text, lower) {
  if (cust.step === 'BOOKING_SERVICE' || cust.step === 'MENU') {
    let id = parseInt(text);
    let found = SETTINGS.MENU.find(i => i.id === id);
    if (!found) {
      await safeSend(sock, jid, `Please send a valid service number from the list.\n\n${bookingServiceText()}`);
      return;
    }
    cust.booking.service = found;
    cust.step = 'BOOKING_DATETIME';
    await safeSend(sock, jid, `Great! You picked *${found.name}* ✅\n\nSend your preferred date & time like:\n*Tomorrow 5pm* or *30 Oct 7:30pm*\n\nReply 0 to cancel.`);
    return;
  }
  if (cust.step === 'BOOKING_DATETIME') {
    cust.booking.datetime = text;
    cust.step = 'BOOKING_NAME';
    await safeSend(sock, jid, `Perfect 📝\nNow send your full name to confirm booking.\n\nReply 0 to cancel.`);
    return;
  }
  if (cust.step === 'BOOKING_NAME') {
    cust.booking.name = text;
    const bookingId = genBookingId();
    cust.step = 'WELCOME';
    await safeSend(sock, jid, `✅ Booking Confirmed!\n\n*ID:* ${bookingId}\n*Service:* ${cust.booking.service.name}\n*When:* ${cust.booking.datetime}\n*Name:* ${cust.booking.name}\n\n📍 ${SETTINGS.CITY}\n📞 ${SETTINGS.PHONE_FOR_CALLS}\n⏰ ${SETTINGS.OPENING_HOURS}\n\nThank you! See you soon 😊`);
    await notifyOwner(sock, `🔔 NEW BOOKING ${bookingId}\nService: ${cust.booking.service.name}\nWhen: ${cust.booking.datetime}\nName: ${cust.booking.name}\nFrom: ${jid}`);
    customers.set(jid, { step: 'WELCOME', cart: [], booking: {} });
    return;
  }
}

async function handleOrder(sock, jid, cust, text, lower) {
  if (cust.step === 'MENU') {
    const items = parseOrder(text, SETTINGS.MENU);
    if (items.length === 0) {
      await safeSend(sock, jid, `Please send valid item numbers like *1x2, 2, 3*\n\n${menuText()}`);
      return;
    }
    // merge to cart
    items.forEach(it => {
      let ex = cust.cart.find(c => c.id === it.id);
      if (ex) ex.qty += it.qty; else cust.cart.push(it);
    });
    cust.step = 'CART';
    await sendCart(sock, jid, cust);
    return;
  }

  if (cust.step === 'CART') {
    if (lower === 'confirm' || lower === '1') {
      cust.step = 'PAYMENT';
      await safeSend(sock, jid, `How do you want to pay? 💳\n\n1. Cash on Delivery\n2. Online Payment (${SETTINGS.PAYMENT_METHODS})\n\nReply *1* for Cash or *2* for Online.\nReply 0 to cancel, or send *MENU* to add more.`);
      return;
    }
    if (lower === 'menu' || lower === '2' || lower.includes('add')) {
      cust.step = 'MENU';
      await safeSend(sock, jid, menuText());
      return;
    }
    // allow adding more directly
    const more = parseOrder(text, SETTINGS.MENU);
    if (more.length > 0) {
      more.forEach(it => {
        let ex = cust.cart.find(c => c.id === it.id);
        if (ex) ex.qty += it.qty; else cust.cart.push(it);
      });
      await sendCart(sock, jid, cust);
      return;
    }
    await safeSend(sock, jid, `Reply *1* to Confirm, *2* or *MENU* to add more, *0* to cancel.`);
    return;
  }

  if (cust.step === 'PAYMENT') {
    if (lower === '1' || lower.includes('cash')) {
      cust.payment = 'Cash on Delivery';
      cust.step = 'ADDRESS';
      await safeSend(sock, jid, `You selected *Cash on Delivery* ✅\n\nPlease send your *full address* with street, city, and near landmark.\n\nReply 0 to cancel.`);
      return;
    }
    if (lower === '2' || lower.includes('online') || lower.includes('jazz') || lower.includes('easy')) {
      cust.payment = 'Online';
      cust.step = 'PAYMENT_WAIT';
      await safeSend(sock, jid, `Online payment details:\n*${SETTINGS.PAYMENT_METHODS}*\n\nAfter payment, please send screenshot or type *PAID*.\n\nReply 0 to cancel.`);
      return;
    }
    if (lower === 'menu') {
      cust.step = 'MENU';
      await safeSend(sock, jid, menuText());
      return;
    }
    await safeSend(sock, jid, `Please reply *1* for Cash or *2* for Online.\nReply 0 to cancel.`);
    return;
  }

  if (cust.step === 'PAYMENT_WAIT') {
    if (lower === 'paid' || msgHasImage(text, lower)) {
      cust.step = 'ADDRESS';
      await safeSend(sock, jid, `Payment received ✅ Thank you!\n\nNow send your *full address* with street & landmark.\n\nReply 0 to cancel.`);
      return;
    }
    // allow any text as confirmation if they sent image
    if (lower.length > 1) {
      cust.step = 'ADDRESS';
      await safeSend(sock, jid, `Got it ✅\n\nNow send your *full address* with street & landmark.`);
      return;
    }
    await safeSend(sock, jid, `Please send screenshot or type *PAID* to confirm payment.`);
    return;
  }

  if (cust.step === 'ADDRESS') {
    if (text.length < 8) {
      await safeSend(sock, jid, `Please send a complete address (at least street, area, city) 📍\nReply 0 to cancel.`);
      return;
    }
    const orderId = genId();
    const { lines, total } = cartSummary(cust.cart);
    const finalTotal = total + SETTINGS.DELIVERY_FEE;
    const summary = `✅ Order Confirmed!\n\n*Order ID:* ${orderId}\n\n${lines.join('\n')}\nDelivery Fee: Rs.${SETTINGS.DELIVERY_FEE}\n*Total: Rs.${finalTotal}*\nPayment: ${cust.payment}\nAddress: ${text}\n\nYour order will reach you in *${SETTINGS.DELIVERY_TIME}* ⏱️🚚\n\nThank you for choosing ${SETTINGS.BUSINESS_NAME}! 😊`;

    await safeSend(sock, jid, summary);
    await notifyOwner(sock, `🔔 NEW ORDER ${orderId}\nFrom: ${jid}\n${lines.join('\n')}\nDelivery: Rs.${SETTINGS.DELIVERY_FEE}\nTotal: Rs.${finalTotal}\nPayment: ${cust.payment}\nAddress: ${text}`);

    customers.set(jid, { step: 'WELCOME', cart: [], booking: {} });
    return;
  }

  // fallback
  await safeSend(sock, jid, welcomeText());
}

function msgHasImage(text, lower) { return lower.includes('paid'); }

async function sendCart(sock, jid, cust) {
  if (cust.cart.length === 0) {
    await safeSend(sock, jid, menuText());
    return;
  }
  const { lines, total } = cartSummary(cust.cart);
  const finalTotal = total + SETTINGS.DELIVERY_FEE;
  const txt = `🛒 Your Cart:\n\n${lines.join('\n')}\n\nSubtotal: Rs.${total}\nDelivery Fee: Rs.${SETTINGS.DELIVERY_FEE}\n*Total: Rs.${finalTotal}*\n\nReply *1* or *CONFIRM* to confirm order.\nReply *2* or *MENU* to add more.\nReply *0* to cancel.`;
  await safeSend(sock, jid, txt);
}

async function safeSend(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    console.log(`Sent to ${jid}: ${text.slice(0, 60)}...`);
  } catch (e) {
    console.log(`Send failed to ${jid}: ${e.message}`);
  }
}

async function notifyOwner(sock, text) {
  try {
    if (!SETTINGS.OWNER_NUMBER_FOR_ALERTS) return;
    let ownerJid = SETTINGS.OWNER_NUMBER_FOR_ALERTS.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    if (ownerJid.length < 15) return;
    await sock.sendMessage(ownerJid, { text });
  } catch (e) {
    console.log('Owner notify failed:', e.message);
  }
}

startBot();
