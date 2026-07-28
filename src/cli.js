#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { auditSite } from './engine/siteAudit.js';
import { buildSummary } from './report/buildSummary.js';
import { renderHtmlReport } from './report/html/render.js';
import { renderDocxReport } from './report/docx/render.js';
import { uploadDocxAsGoogleDoc } from './report/gdocs/upload.js';
import { slugify, timestampSlug } from './util/slug.js';
import { resolveDeviceProfile, DEVICE_PROFILE_KEYS } from './engine/deviceProfiles.js';

function parseDeviceOption(value) {
  if (!DEVICE_PROFILE_KEYS.includes(value)) {
    throw new Error(`--device must be one of: ${DEVICE_PROFILE_KEYS.join(', ')}`);
  }
  return value;
}

const program = new Command();

program
  .name('console-warrior')
  .description('Automated WCAG 2.1 AA structured accessibility audit bot (SOW S2.3.F scope)');

program
  .command('run')
  .description('Audit a list of URLs and generate a findings report')
  .option('-c, --config <path>', 'path to a site config JSON (see config/sites/example.json)')
  .option('-u, --urls <urls>', 'comma-separated URL list (overrides/supplements --config)')
  .option('-n, --name <name>', 'site name shown in the report', 'Accessibility Audit')
  .option('-o, --out <dir>', 'output directory', null)
  .option('--formats <list>', 'comma list of report formats: html,docx', 'html,docx')
  .option('--concurrency <n>', 'pages to audit in parallel', (v) => parseInt(v, 10), 3)
  .option('--device <profile>', `device profile: ${DEVICE_PROFILE_KEYS.join('|')}`, parseDeviceOption, 'desktop')
  .option('--width <px>', 'custom viewport width (with --device custom)', (v) => parseInt(v, 10))
  .option('--height <px>', 'custom viewport height (with --device custom)', (v) => parseInt(v, 10))
  .option('--gdoc-credentials <path>', 'service account JSON for optional Google Docs upload')
  .option('--gdoc-folder <id>', 'Google Drive folder ID to upload the report into')
  .action(async (opts) => {
    const config = opts.config ? JSON.parse(await fs.readFile(opts.config, 'utf8')) : {};
    const urls = [
      ...(config.urls || []),
      ...(opts.urls ? opts.urls.split(',').map((u) => u.trim()).filter(Boolean) : []),
    ];
    if (!urls.length) {
      console.error('No URLs to audit. Pass --config <file> with a "urls" array, or --urls a,b,c.');
      process.exitCode = 1;
      return;
    }

    const siteName = config.name || opts.name;
    const runId = `${slugify(siteName)}-${timestampSlug()}`;
    const outDir = opts.out || path.join('output', runId);
    await fs.mkdir(outDir, { recursive: true });

    const deviceProfile = resolveDeviceProfile({
      deviceKey: opts.device,
      width: opts.width ?? config.viewport?.width,
      height: opts.height ?? config.viewport?.height,
      engine: 'chromium',
    });

    console.log(`Console Warrior — auditing ${urls.length} URL(s) for "${siteName}"`);
    console.log(`Output: ${outDir}`);
    console.log(`Device: ${deviceProfile.label} (${deviceProfile.viewport.width}x${deviceProfile.viewport.height}, ${deviceProfile.emulationLabel})`);

    const results = await auditSite({
      urls,
      outDir,
      deviceProfile,
      concurrency: opts.concurrency,
      onPageDone: (r) => {
        if (r.error) {
          console.log(`  ✗ ${r.url} — ERROR: ${r.error.split('\n')[0]}`);
        } else {
          console.log(`  ✓ ${r.url}`);
        }
      },
    });

    const summary = buildSummary(results);

    await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

    const formats = opts.formats.split(',').map((f) => f.trim().toLowerCase());
    const report = { siteName, generatedAt: new Date().toISOString(), urls, deviceProfile, results, summary };

    let htmlPath = null;
    let docxPath = null;

    if (formats.includes('html')) {
      htmlPath = path.join(outDir, 'report.html');
      await renderHtmlReport(report, htmlPath);
      console.log(`HTML report:  ${htmlPath}`);
    }
    if (formats.includes('docx')) {
      docxPath = path.join(outDir, 'report.docx');
      await renderDocxReport(report, docxPath);
      console.log(`Word report:  ${docxPath}`);
    }
    if (formats.includes('gdocs')) {
      if (!docxPath) {
        docxPath = path.join(outDir, 'report.docx');
        await renderDocxReport(report, docxPath);
      }
      if (!opts.gdocCredentials || !opts.gdocFolder) {
        console.warn('Skipping Google Docs export: --gdoc-credentials and --gdoc-folder are both required.');
      } else {
        const link = await uploadDocxAsGoogleDoc({
          docxPath,
          credentialsPath: opts.gdocCredentials,
          folderId: opts.gdocFolder,
          name: `${siteName} — Accessibility Audit — ${report.generatedAt.slice(0, 10)}`,
        });
        console.log(`Google Doc:   ${link}`);
      }
    }

    console.log('\nSummary:');
    console.log(`  Pages audited: ${summary.pagesAudited} (errors: ${summary.pagesErrored})`);
    console.log(`  Manual review items: ${summary.manualReviewCount}`);
    console.log(`  Total flagged findings: ${Object.values(summary.totals).reduce((a, b) => a + b, 0)}`);
  });

program.parseAsync(process.argv);
