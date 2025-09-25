import fs from 'fs';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const STATE_PATH = 'seen.json';

const loadSeen = () => new Set(fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : []);
const saveSeen = seen => fs.writeFileSync(STATE_PATH, JSON.stringify([...seen].sort()), 'utf8');

const norm = s => (s || '').toString().toLowerCase();
const contains = (text, needle) => norm(text).includes(norm(needle));
const phrase = (text, ph) => {
  const t = norm(text).replace(/\s+/g, ' ').trim();
  const p = norm(ph).replace(/\s+/g, ' ').trim();
  return t.indexOf(p) !== -1;
};

function matchRule(text, rule) {
  if (!rule) return true;
  if (rule.contains) return contains(text, rule.contains);
  if (rule.phrase) return phrase(text, rule.phrase);
  if (rule.all) return rule.all.every(r => matchRule(text, r));
  if (rule.any) return rule.any.some(r => matchRule(text, r));
  return false;
}

async function extractListings(page) {
  return await page.$$eval('a[href*="/p/"]', nodes => {
    const uniq = new Map();
    for (const a of nodes) {
      const href = a.getAttribute('href') || '';
      const url = href.startsWith('http') ? href : new URL(href, location.origin).href;
      const text = (a.innerText || '').trim().replace(/\s+/g, ' ');
      if (url && text && !uniq.has(url)) uniq.set(url, { url, text });
    }
    return [...uniq.values()];
  });
}

async function sendEmail(toList, subject, body) {
  if (!toList || toList.length === 0) {
    console.log('sendEmail: no recipients, skipping.');
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    // Optional: verify connection/auth before sending
    await transporter.verify();
    console.log('SMTP verify: OK as', process.env.SMTP_USER);

    const info = await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: toList.join(','),
      subject,
      text: body
    });
    console.log('Email queued:', info.messageId, 'to', toList.join(','));
  } catch (err) {
    console.error('sendEmail ERROR:', err);
    throw err; // surface to workflow logs
  }
}

async function main() {
    // --- one-time SMTP test mode ---
  if (process.env.FORCE_TEST_EMAIL === '1') {
    const allRecipients = (CONFIG.alerts || []).flatMap(a => a.emails || []);
    const uniqRecipients = [...new Set(allRecipients)];
    await sendEmail(
      uniqRecipients,
      'Carousell Watch: SMTP test',
      'If you can read this, SMTP is working.'
    );
    console.log('Test email attempted to:', uniqRecipients.join(', '));
    return; // exit early for this run
  }

  const seen = loadSeen();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  const page = await context.newPage();

  for (const alert of CONFIG.alerts) {
    const hits = [];
    for (const src of alert.sources) {
      try {
        await page.goto(src, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);
        const items = await extractListings(page);

        for (const it of items) {
          const key = `${alert.id}::${it.url}`;
          if (seen.has(key)) continue;

          if (matchRule(it.text, alert.match)) {
            hits.push({ ...it, source: src });
            seen.add(key);
          }
        }
      } catch (e) {
        console.error(`[${alert.id}] Source failed:`, src, e.message);
      }
    }

    if (hits.length) {
      const body = hits.map(h => `• ${h.text}\n${h.url}\n(found on ${h.source})`).join('\n\n');
      await sendEmail(alert.emails, `Carousell: ${alert.id} (${hits.length})`, body);

      // Optional Telegram: add TG_TOKEN & TG_CHAT secrets, then uncomment:
      // await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage?chat_id=${process.env.TG_CHAT}&disable_web_page_preview=true&text=` +
      //   encodeURIComponent(`🚨 ${alert.id} (${hits.length})\n\n` + body));
    }
  }

  saveSeen(seen);
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
