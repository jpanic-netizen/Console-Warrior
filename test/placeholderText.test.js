import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, newAuditContext } from '../src/engine/browser.js';
import { installDomHelpers } from '../src/engine/domHelpers.js';
import { auditPlaceholderText } from '../src/engine/checks/placeholderText.js';

async function withPage(t, html, fn) {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await newAuditContext(browser);
  const page = await context.newPage();
  await page.setContent(html);
  await installDomHelpers(page);
  await fn(page);
}

test('auditPlaceholderText flags an exact "Test" heading but never a real page whose text merely contains "test" as a substring', async (t) => {
  await withPage(
    t,
    `<h2>Test</h2>
     <h3>Testimonials</h3>
     <p>Read our latest contest results and attestation of quality.</p>`,
    async (page) => {
      const result = await auditPlaceholderText(page);
      assert.equal(result.found.length, 1);
      assert.equal(result.found[0].text, 'Test');
      assert.equal(result.found[0].pattern, '"Test" placeholder');
    }
  );
});

test('auditPlaceholderText flags common CMS/Webflow placeholder patterns', async (t) => {
  await withPage(
    t,
    `<h2>Heading 2</h2>
     <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
     <button>TBD</button>
     <span>[Insert content here]</span>
     <a href="/x">Click here to edit</a>`,
    async (page) => {
      const result = await auditPlaceholderText(page);
      const texts = result.found.map((f) => f.text);
      assert.ok(texts.includes('Heading 2'));
      assert.ok(texts.some((t) => t.startsWith('Lorem ipsum')));
      assert.ok(texts.includes('TBD'));
      assert.ok(texts.includes('[Insert content here]'));
      assert.ok(texts.includes('Click here to edit'));
      assert.equal(result.found.length, 5);
    }
  );
});

test('auditPlaceholderText does not flag real, legitimate content resembling but not matching the exact patterns', async (t) => {
  await withPage(
    t,
    `<h1>Welcome to Our Company</h1>
     <p>We provide top-tier consulting services for growing businesses.</p>
     <button>Learn more about our pricing</button>
     <h2>Heading to the beach this summer</h2>`,
    async (page) => {
      const result = await auditPlaceholderText(page);
      assert.equal(result.found.length, 0);
    }
  );
});

test('auditPlaceholderText ignores hidden elements and dedupes identical repeated placeholder text', async (t) => {
  await withPage(
    t,
    `<h2 style="display:none">Test</h2>
     <p>TBD</p>
     <p>TBD</p>`,
    async (page) => {
      const result = await auditPlaceholderText(page);
      assert.equal(result.found.length, 1, 'the hidden "Test" heading must not count, and the two visible "TBD" paragraphs dedupe to one');
      assert.equal(result.found[0].text, 'TBD');
    }
  );
});

test('auditPlaceholderText skips wrapper elements that have element children, scanning only the leaf text node', async (t) => {
  await withPage(t, `<li><a href="/x">Test</a></li>`, async (page) => {
    const result = await auditPlaceholderText(page);
    assert.equal(result.found.length, 1, 'the <li> wrapper must not also be flagged alongside its <a> child');
    assert.equal(result.found[0].tag, 'A');
  });
});
