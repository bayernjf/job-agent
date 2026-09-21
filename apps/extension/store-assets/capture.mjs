/**
 * Chrome Web Store asset capture script (reproducible, not part of the shipped extension).
 *
 * Produces:
 *   screenshots/01..05-*.png  - 1280x800, square corners, full bleed (CWS requirement)
 *   promo/small-440x280.png    - required small promotional tile
 *   promo/marquee-1400x560.png - optional marquee tile
 *
 * Prerequisites (local full stack on real data):
 *   - API + worker on API_BASE (default http://127.0.0.1:4123) with a complete profile
 *   - Report SSR on REPORT_BASE (default http://127.0.0.1:4321) reading the same DB
 *   - apps/extension/dist built (pnpm --filter @jobagent/extension build)
 *
 * Run:
 *   PROFILE_ID=<uuid> node apps/extension/store-assets/capture.mjs
 *
 * The extension panel talks to the REAL local API (exportable profile + real job matches);
 * only the ATS host page is a local mock (ats-job.html), routed in like the extension E2E.
 */
import { chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const EXT_DIST = path.join(ROOT, 'apps/extension/dist');
const OUT_SHOTS = path.join(here, 'screenshots');
const OUT_PROMO = path.join(here, 'promo');
const ATS_HTML = readFileSync(path.join(here, 'ats-job.html'), 'utf8');
const ATS_URL = 'https://example.com/jobs';

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:4123';
const REPORT_BASE = process.env.REPORT_BASE ?? 'http://127.0.0.1:4321';
const PROFILE_ID = process.env.PROFILE_ID;
const LOGIN = process.env.LOGIN ?? 'bayernjf';

if (!PROFILE_ID) {
  console.error('PROFILE_ID env is required (a complete profile id in the local DB).');
  process.exit(2);
}
if (!existsSync(path.join(EXT_DIST, 'manifest.json'))) {
  console.error(`Extension build not found at ${EXT_DIST}. Run pnpm --filter @jobagent/extension build.`);
  process.exit(2);
}
mkdirSync(OUT_SHOTS, { recursive: true });
mkdirSync(OUT_PROMO, { recursive: true });

const W = 1280;
const H = 800;

async function captureExtensionShots() {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'ja-cws-ext-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    locale: 'en-US',
    viewport: { width: W, height: H },
    args: [
      `--disable-extensions-except=${EXT_DIST}`,
      `--load-extension=${EXT_DIST}`,
      '--headless=new',
    ],
  });

  await context.route(ATS_URL, (route) =>
    route.fulfill({ contentType: 'text/html', body: ATS_HTML }),
  );
  await context.route('**/analyze', (route) =>
    route.fulfill({ json: { profileId: PROFILE_ID } }),
  );
  await context.route('**/profiles/*/exportable', async (route) => {
    const res = await fetch(`${API_BASE}/profiles/${PROFILE_ID}/exportable`);
    return route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });
  await context.route('**/job-postings/match', async (route) => {
    const res = await fetch(`${API_BASE}/job-postings/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: PROFILE_ID, limit: 5 }),
    });
    return route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: W, height: H });
  await page.goto(ATS_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('.ja-fab').waitFor({ timeout: 10_000 });

  const panel = page.locator('#jobagent-autofill-panel');
  const panelBox = () => page.locator('#jobagent-autofill-overlay').locator('.ja-panel');
  const openPanel = async () => {
    if ((await panel.count()) === 0 || !(await panel.isVisible())) {
      await page.locator('.ja-fab').click();
    }
    await panel.waitFor({ state: 'visible', timeout: 5000 });
  };

  await openPanel();
  await page.getByPlaceholder('e.g. sindresorhus').fill(LOGIN);
  // Clear the build-time localhost API base so the advanced field shows its placeholder
  // instead of a localhost URL (routing is intercepted, so this does not affect data).
  await page.locator('.ja-panel input.ja-input').nth(1).fill('');
  await page.getByRole('button', { name: 'Load verified profile' }).click();
  await page.locator('.ja-match-list .ja-match-item').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await panelBox().evaluate((el) => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(400);

  // Shot 1: panel with real job matches
  await page.screenshot({ path: path.join(OUT_SHOTS, '01-extension-job-matches.png') });
  console.log('  -> 01-extension-job-matches.png');

  // Shot 2: expanded match basis with evidence trace
  const firstItem = page.locator('.ja-match-list .ja-match-item').first();
  const basisSummary = firstItem.locator('.ja-match-basis summary');
  await basisSummary.scrollIntoViewIfNeeded({ block: 'center' });
  await basisSummary.click();
  await firstItem.locator('.ja-match-breakdown').waitFor({ timeout: 5000 });
  await firstItem.locator('.ja-match-breakdown').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_SHOTS, '02-match-basis-evidence.png') });
  console.log('  -> 02-match-basis-evidence.png');

  // Shot 3: one-click autofill, panel closed, form populated
  const detailsSummary = panel.locator('.ja-details summary');
  await detailsSummary.scrollIntoViewIfNeeded();
  await detailsSummary.click();
  await page.waitForTimeout(300);
  const details = panel.locator('.ja-details');
  const fieldByLabel = (labelText) =>
    details.locator('label').filter({ hasText: labelText }).locator('input');
  for (const [labelText, value] of [
    ['Email', 'bay@example.dev'],
    ['Phone', '+1 555 010 2048'],
    ['Location', 'Remote'],
    ['LinkedIn', 'https://linkedin.com/in/bayernjf'],
  ]) {
    const input = fieldByLabel(labelText);
    await input.scrollIntoViewIfNeeded();
    await input.fill(value);
  }
  const fillBtn = page.getByRole('button', { name: 'Fill the form' });
  await fillBtn.scrollIntoViewIfNeeded();
  await fillBtn.click();
  const note = panel.getByText(/Filled \d+ field/);
  await note.waitFor({ timeout: 5000 });
  console.log('  fill result:', (await note.textContent())?.trim());
  await page.waitForTimeout(500);

  // Verify the ATS form was actually populated before capturing.
  const formValues = await page.locator('#job-application-form').evaluate((form) => {
    const get = (sel) => form.querySelector(sel)?.value ?? '';
    return {
      name: get('input[name="name"]'),
      email: get('input[name="email"]'),
      phone: get('input[name="phone"]'),
      linkedin: get('input[name*="LinkedIn"]'),
      github: get('input[name*="GitHub"]'),
      why: get('textarea[name*="why"]'),
    };
  });
  console.log('  form values:', JSON.stringify(formValues));

  // Hide the whole overlay (equivalent to dismissing the panel) for a clean form shot.
  await page.evaluate(() => {
    const host = document.getElementById('jobagent-autofill-overlay');
    if (host) host.style.display = 'none';
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_SHOTS, '03-one-click-autofill.png') });
  console.log('  -> 03-one-click-autofill.png');

  await context.close();
}

async function captureWebShots(browser) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  await page.goto(`${REPORT_BASE}/en/report/${PROFILE_ID}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT_SHOTS, '04-verified-profile.png') });
  console.log('  -> 04-verified-profile.png');

  await page.goto(`${REPORT_BASE}/en/recruit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_SHOTS, '05-talent-pool.png') });
  console.log('  -> 05-talent-pool.png');

  await context.close();
}

async function capturePromo(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`file://${path.join(here, 'promo.html')}`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.locator('#small').screenshot({ path: path.join(OUT_PROMO, 'small-440x280.png') });
  await page.locator('#marquee').screenshot({ path: path.join(OUT_PROMO, 'marquee-1400x560.png') });
  console.log('  -> promo/small-440x280.png + promo/marquee-1400x560.png');
  await context.close();
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
await captureExtensionShots();
await captureWebShots(browser);
await capturePromo(browser);
await browser.close();
console.log('Done. Assets in apps/extension/store-assets/{screenshots,promo}.');
