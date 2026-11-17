"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn, execFileSync} = require("node:child_process");
const {chromium} = require(process.env.AI_HUB_PLAYWRIGHT_PATH || "/opt/runtime/node_modules/playwright");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join("/workspace", ".hub-ui-e2e-"));
const port = 18878;
const env = {...process.env, AI_HUB_DATA_DIR: temp};
const py = [
  "from hub_store import Store",
  "s = Store()",
  "a = s.create_session('MCP UI検証', 'chat-a')",
  "b = s.create_session('Muse調査', 'chat-b')",
  "s.append(a, 'chatgpt', '最初の依頼\\r\\n改行を保持\\n<script>globalThis.INJECTED=true</script>', kind='delegation', source='chatgpt-to-codex-cli', metadata={'task_id':'task-one','revision_type':'initial'})",
  "s.append(a, 'chatgpt', '# 追加依頼\\n\\n- テストする', kind='delegation', source='chatgpt-to-codex-cli', metadata={'task_id':'task-one','revision_type':'followup'})",
  "s.append(a, 'codex', '回答', kind='result')",
  "s.append(b, 'chatgpt', 'Museに調査を依頼します。', kind='delegation', source='chatgpt-to-muse-sdk')"
].join("\n");
execFileSync("python3",["-c",py], {cwd:root,env,stdio:"pipe"});
const proc = spawn("python3", ["hub_app.py", "serve", "--host", "127.0.0.1", "--port", String(port)],
  {cwd:root,env,stdio:"ignore"});
const base = "http://127.0.0.1:" + port;
async function health() {
  for (let i=0;i<60;i++) {
    try {if ((await fetch(base + "/healthz")).ok) return;}
    catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error("test server could not start");
}
(async()=>{
  let browser;
  try {
    await health();
    browser = await chromium.launch({headless:true,args:["--no-sandbox"]});
    const context = await browser.newContext({viewport:{width:393,height:852},isMobile:true,
      permissions:["clipboard-read","clipboard-write"]});
    const page = await context.newPage();
    const errors=[];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", msg=>{if(msg.type()==="error") errors.push("console: " + msg.text());});
    await page.goto(base, {waitUntil:"networkidle"});
    await page.locator(".request-card").first().waitFor({timeout:5000});
    assert.equal(await page.locator(".request-card").count(), 3);
    assert.equal(await page.locator("#requests-pane").isVisible(),true);
    assert.equal(await page.locator("#history-pane").isVisible(),false);
    assert.ok(await page.locator(".request-card").first().textContent().then(x=>x.includes("Muse")));
    assert.ok(await page.locator(".request-card").last().textContent().then(x=>x.includes("Codex")));
    await page.locator(".request-card").last().click();
    await page.locator(".request-full-text").waitFor();
    assert.ok(await page.locator(".request-full-text").textContent().then(x=>x.includes("<script>globalThis.INJECTED=true</script>")));
    assert.equal(await page.evaluate("globalThis.INJECTED"),undefined);
    assert.equal(await page.locator(".version-button").count(),2);
    assert.equal(await page.locator(".request-full-text").textContent(), "最初の依頼\r\n改行を保持\n<script>globalThis.INJECTED=true</script>");
    await page.locator(".request-copy").click();
    assert.equal(await page.evaluate("navigator.clipboard.readText()"),"最初の依頼\r\n改行を保持\n<script>globalThis.INJECTED=true</script>");
    await page.locator(".version-button").last().click();
    await page.waitForFunction(()=>document.querySelector(".request-full-text")?.textContent.includes("追加依頼"));
    await page.locator(".format-button").last().click();
    assert.equal(await page.locator(".request-rich h1").textContent(),"追加依頼");
    await page.locator("#request-back").click();
    await page.locator(".request-card").first().waitFor();
    await page.selectOption("#request-session","chat-b");
    await page.waitForFunction(()=>document.querySelectorAll(".request-card").length===1);
    assert.ok(await page.locator(".request-card").first().textContent().then(x=>x.includes("Muse")));
    await page.locator("#history-tab").click();
    await page.locator("#timeline").waitFor({state:"visible"});
    await page.locator(".message").first().waitFor();
    await page.locator("#requests-tab").click();
    assert.equal(await page.locator(".request-card").count(),1);
    await page.goto(base + "/#request/2", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>document.querySelector(".request-full-text")?.textContent.includes("追加依頼"));
    assert.ok((await page.evaluate("document.documentElement.scrollWidth")) <= 394, "no horizontal overflow");
    assert.deepEqual(errors,[],"no JS runtime errors");
    await page.screenshot({path:path.join(temp,"request-detail-393.png"),fullPage:true});
    console.log("PASS mobile e2e: 1-tap original, exact CRLF+copy, grouping, filter, history, deep link, XSS, viewport");
  } finally {
    await browser?.close();
    proc.kill("SIGTERM");
  }
})().catch(e=>{console.error(e);proc.kill("SIGTERM");process.exitCode=1});
