const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const playwright = require(process.env.AI_HUB_PLAYWRIGHT_PATH || "playwright");
const browserEngine = process.env.AI_HUB_BROWSER || "chromium";
const browserType = playwright[browserEngine];
if (!browserType) throw new Error("Unknown browser engine: " + browserEngine);
const origin = process.env.AI_HUB_TEST_URL || "http://127.0.0.1:18777";
(async () => {
  const browser = await browserType.launch({
    headless:true, args:browserEngine === "chromium" ? ["--no-sandbox"] : [],
    ...(process.env.AI_HUB_PROXY ? {proxy:{server:process.env.AI_HUB_PROXY}} : {})
  });
  const page = await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true,acceptDownloads:true});
  const errors=[];
  page.on("pageerror", error=>errors.push(error.message));
  const expected="Copy test: 日本語 🤖\r\nLine 2\rLine 3\n" +
    "many lines:\r\n" + "絵文字🙂 CRLF\r\n".repeat(200) +
    "\r\n\r\n\`\`\`python\r\nprint(1)\r\n\`\`\`\r\n";
  await page.route("**/api/sessions", route=>route.fulfill({json:{sessions:[
    {id:"clipboard-test",title:"Copy test",message_count:1}
  ]}}));
  await page.route("**/api/sessions/clipboard-test/events?*",route=>route.fulfill({json:{events:[{
    id:"test-1",seq:1,session_id:"clipboard-test",author:"user",
    kind:"message",source:"test",created_at:"2026-11-16T04:00:00Z",
    content:expected,content_format:"markdown",metadata:null,rich:null
  }]}}));
  await page.goto(origin,{waitUntil:"networkidle"});
  await page.click("#history-tab");
  assert.equal(await page.evaluate(()=>window.isSecureContext),false,"test requires HTTP origin");
  await page.evaluate(()=>{
    window.__copied = null;
    window.__selection = null;
    document.addEventListener("copy",event=>{
      window.__copied = event.clipboardData?.getData("text/plain") ?? null;
      const el = document.activeElement;
      window.__selection = {
        from: el.selectionStart, to: el.selectionEnd, total: el.value?.length
      };
    });
  });
  const copyButton=page.locator(".message.user .mini-btn");
  await copyButton.click();
  assert.equal(await copyButton.textContent(),"コピーしました");
  const copied = await page.evaluate(()=>window.__copied);
  assert.equal(copied,expected,"ClipboardEvent data must be exact UTF-8 source, including CR/CRLF/emoji");
  const selection=await page.evaluate(()=>window.__selection);
  assert.deepEqual({from:selection.from,to:selection.to},{from:0,to:selection.total},"full selected text, not partial");
  await page.evaluate(()=>{document.execCommand=()=>false;});
  await copyButton.click();
  const modal=page.locator(".copy-dialog");
  await modal.waitFor();
  const displayText=await modal.locator("textarea").inputValue();
  assert.equal(displayText,expected.replace(/\r\n?/g,"\n"),"textarea only presents normalized text");
  assert.equal(await modal.locator("textarea").getAttribute("readonly"),"");
  const downloadPromise=page.waitForEvent("download");
  await modal.getByRole("button",{name:"原文をTXT保存"}).click();
  const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),"interaction-message.txt");
  const downloaded=await fs.readFile(await download.path(),"utf8");
  assert.equal(downloaded,expected,"download must preserve CRLF/CR/trailing newline exactly");
  await modal.getByRole("button",{name:"閉じる"}).click();
  assert.equal(await page.locator(".copy-overlay").count(),0);
  assert.deepEqual(errors,[]);
  await browser.close();
  console.log("PASS "+browserEngine+" HTTP exact ClipboardEvent payload, full selection, lossless TXT, manual fallback");
})().catch(e=>{console.error(e);process.exit(1)});
