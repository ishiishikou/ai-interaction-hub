const assert = require("node:assert/strict");
const modulePath = process.env.AI_HUB_PLAYWRIGHT_PATH || "playwright";
const {chromium} = require(modulePath);
const base = process.env.AI_HUB_URL || "http://127.0.0.1:18777";
(async () => {
 const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
 const page=await browser.newPage({viewport:{width:393,height:852},isMobile:true});
 const events=(id,text)=>({events:[{seq:id==="A"?1:2,id:id+"-1",session_id:id,
  author:id==="A"?"chatgpt":"codex",kind:"message",source:"test",
  content:text,content_format:"markdown",created_at:"2026-11-16T01:00:00Z",rich:null,metadata:null}]});
 let failA=false, delayA=false, unblockA=null, signalA=null;
 await page.route("**/api/sessions", r=>r.fulfill({json:{sessions:[
  {id:"A",title:"Alpha",message_count:1},{id:"B",title:"Bravo",message_count:1}]}}));
 await page.route("**/api/sessions/*/events?*",async route=>{
  const url=new URL(route.request().url());
  const id=decodeURIComponent(url.pathname.split("/")[3]);
  if(Number(url.searchParams.get("after"))>0) return route.fulfill({json:{events:[]}});
  if(id==="A"){
    if(failA){failA=false;return route.abort("failed");}
    if(delayA){delayA=false;signalA?.();await new Promise(resolve=>{unblockA=resolve;});}
  }
  return route.fulfill({json:events(id,id==="A"?"A-SOURCE":"B-SOURCE")});
 });
 await page.goto(base,{waitUntil:"networkidle"});
 await page.waitForFunction(()=>document.querySelector(".message")?.textContent.includes("A-SOURCE"));
 assert.equal(await page.locator(".message").count(),1);
 failA=true;
 await page.click("#reload");
 await page.waitForFunction(()=>document.querySelector(".empty")?.textContent.includes("読み込み失敗"));
 await page.click("#reload");
 await page.waitForFunction(()=>document.querySelector(".message")?.textContent.includes("A-SOURCE"));
 assert.equal(await page.locator(".empty").count(),0,"recovered history after identical successful result");
 let announced;const entered=new Promise(resolve=>{announced=resolve;});
 delayA=true;signalA=announced;
 await page.click("#reload");
 await entered;
 await page.selectOption("#sessions","B");
 assert.ok(unblockA,"delayed A response is pending");
 unblockA();
 await page.waitForFunction(()=>document.querySelector(".message")?.textContent.includes("B-SOURCE"));
 assert.equal(await page.locator("#sessions").inputValue(),"B");
 assert.equal(await page.locator(".message").count(),1);
 assert.equal(await page.locator(".message").first().textContent().then(t=>t.includes("A-SOURCE")),false,"never show stale A in B view");
 await browser.close();
 console.log("PASS browser regressions: recovery after failed fetch; concurrent session switch");
})().catch(e=>{console.error(e);process.exit(1)});
