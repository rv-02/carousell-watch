// watch.js (ESM)
// Multi-alert watcher for Carousell with robust extraction, de-dup, and email notifications.

import fs from 'fs';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';

// ---------- Load config & state ----------
const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const STATE_PATH = 'seen.json';

const loadSeen = () =>
  new Set(fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : []);
const saveSeen = (seen) => fs.writeFileSync(STATE_PATH, JSON.stringify([...seen].sort()), 'utf8');

// ---------- Matching helpers ----------
const norm = (s) => (s || '').toString().toLowerCase();
const contains = (text, needle) => norm(text).includes(norm(needle));
const phrase = (text, ph) => {
  // exact back-to-back phrase (whitespace-normalized, case-insensitive)
  const t = norm(text).replace(/\s+/g, ' ').trim();
  const p = norm(ph).replace(/\s+/g, ' ').trim();
  return t.indexOf(p) !== -1;
};

// Evaluate a rule object against text: supports {contains}, {phrase}, {all:[…]}, {any:[…]}
function matchRule(text, rule) {
  if (!rule) return true;
  if (rule.contains) return contains(text, rule.contains);
  if (rule.phrase) return phrase(text, rule.phrase);
  if (rule.all) return rule.all.every((r) => matchRule(text, r));
  if (rule.any) return rule.any.some((r) => matchRule(text, r));
  return false;
}

// ---------- Extract listings (robust) ----------
async function extractListings(page) {
  // Collect unique listing links + human-readable text from the card container (not just the <a>)
  return await page.$$eval('a[href*="/p/"], a[href^="/p/"]', (nodes) => {
    const byUrl = new Map();

    function getCardText(node) {
      // Walk up a few levels to find a reasonable card container, then use its text
      let cur = node;
      for (let i = 0; i < 6 && cur; i++) {
        // Prefer elements that look like listing cards
        if (
          cur.matches?.(
            '[data-testid*="listing"], [data-testid*="card"], article, li, div[class*="Card"], div[class*="card"]'
          )
        )
          break;
        cur = cur.parentElement;
      }
      const container = cur || node.parentElement || node;
      const raw = (container.innerText || container.textContent || '')
        .trim()
        .replace(/\s+/g, ' ');
      return raw;
    }

    for (const a of nodes) {
      const href = a.getAttribute('href') || '';
      const abs = href.startsWith('http') ? href : new URL(href, location.origin).href;
      if (!abs.includes('/p/')) continue; // keep it to product pages
      const text = getCardText(a);
      if (abs && text && !byUrl.has(abs)) {
        byUrl.set(abs, { url: abs, text });
      }
    }
    return [...byUrl.values()];
  });
}

// ---------- Email ----------
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

    // Verify connection/auth before sending for clearer logs
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

// ---------- Main ----------
async function main() {
  const seen = loadSeen();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  const page = await context.newPage();

  // One-run flags
  const FORCE_TEST_EMAIL = process.env.FORCE_TEST_EMAIL === '1'; // (used earlier during SMTP test)
  const FORCE_ALL = process.env.FORCE_ALL_MATCHES === '1'; // send even if seen

  // Optional: one-time SMTP test mode (kept for convenience; not used unless env is set)
  if (FORCE_TEST_EMAIL) {
    const allRecipients = (CONFIG.alerts || []).flatMap((a) => a.emails || []);
    const uniqRecipients = [...new Set(allRecipients)];
    await sendEmail(uniqRecipients, 'Carousell Watch: SMTP test', 'If you can read this, SMTP is working.');
    console.log('Test email attempted to:', uniqRecipients.join(', '));
    await browser.close();
    return;
  }

  for (const alert of CONFIG.alerts) {
    const hits = [];

    for (const src of alert.sources) {
      try {
        await page.goto(src, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // Give client JS a moment to render cards
        await page.waitForTimeout(2000);

        const items = await extractListings(page);
        console.log(`[${alert.id}] ${src} -> items found:`, items.length);
        if (items.length) {
          console.log(
            `[${alert.id}] sample 1-3:`,
            items.slice(0, 3).map((i) => i.text.slice(0, 120))
          );
        }

        for (const it of items) {
          const key = `${alert.id}::${it.url}`;
          if (matchRule(it.text, alert.match)) {
            if (!seen.has(key) || FORCE_ALL) {
              hits.push({ ...it, source: src });
              if (!FORCE_ALL) seen.add(key); // mark as seen only in normal mode
            }
          }
        }
      } catch (e) {
        console.error(`[${alert.id}] Source failed:`, src, e.message);
      }
    }

    if (hits.length) {
      const body =
        hits.map((h) => `• ${h.text}\n${h.url}\n(found on ${h.source})`).join('\n\n') ||
        '(no body text)';
      await sendEmail(alert.emails, `Carousell: ${alert.id} (${hits.length})`, body);

      // Optional Telegram (later): add TG_TOKEN & TG_CHAT secrets, then uncomment:
      // await fetch(
      //   `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage` +
      //     `?chat_id=${process.env.TG_CHAT}&disable_web_page_preview=true&text=` +
      //     encodeURIComponent(`🚨 ${alert.id} (${hits.length})\n\n` + body)
      // );
    }
  }

  saveSeen(seen);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
