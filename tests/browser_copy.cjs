const assert = require("node:assert/strict");
const playwright = require(process.env.AI_HUB_PLAYWRIGHT_PATH || "playwright");
const {chromium} = playwright;
const origin = process.env.AI_HUB_TEST_URL || "http://127.0.0.1:18777";
(async () => {
  const browser = await chromium.launch({
    headless:true, args:["--no-sandbox"],
    ...(process.env.AI_HUB_PROXY ? {proxy:{server:process.env.AI_HUB_PROXY}} : {})
  });
  const page = await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
  const errors = [];
  page.on("pageerror",error=>errors.push(error.message));
  const expected = "Copy test: 日本語\nLine 2\n\n```python\nprint(1)\n```";
  await page.route("**/api/sessions",route=>route.fulfill({json:{sessions:[
    {id:"clipboard-test",title:"Copy test",message_count:1}
  ]}}));
  await page.route("**/api/sessions/clipboard-test/events?*",route=>route.fulfill({json:{events:[{
    id:"test-1",seq:1,session_id:"clipboard-test",author:"user",
    kind:"message",source:"test",created_at:"2026-11-16T04:00:00Z",
    content:expected,content_format:"markdown",metadata:null,rich:null
  }]}}));
  await page.goto(origin,{waitUntil:"networkidle"});
  assert.equal(await page.evaluate(()=>window.isSecureContext),false,"test requires HTTP origin");
  await page.evaluate(()=>{
    window.__copied = null;
    document.addEventListener("copy",()=>{
      window.__copied = document.activeElement?.value ?? null;
    });
  });
  const copyButton = page.locator(".message.user .mini-btn");
  await copyButton.click();
  assert.equal(await copyButton.textContent(),"コピーしました");
  assert.equal(await page.evaluate(()=>window.__copied),expected,"exact source copied, no truncation");
  await page.evaluate(()=>{document.execCommand=()=>false;});
  await copyButton.click();
  const modal=page.locator(".copy-dialog");
  await modal.waitFor();
  assert.equal(await modal.locator("textarea").inputValue(),expected);
  assert.equal(await modal.locator("textarea").getAttribute("readonly"),"");
  await modal.getByRole("button",{name:"閉じる"}).click();
  assert.equal(await page.locator(".copy-overlay").count(),0);
  assert.deepEqual(errors,[]);
  await browser.close();
  console.log("PASS HTTP copy fallback: exact source, success label, manual-select modal on failure");
})().catch(e=>{console.error(e);process.exit(1);});
