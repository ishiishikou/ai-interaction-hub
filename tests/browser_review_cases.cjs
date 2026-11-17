"use strict";
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {chromium, webkit} = require("/opt/runtime/node_modules/playwright");
const root = require("node:path").resolve(__dirname, "..");
const port = 18879;
const base = "http://127.0.0.1:" + port;
const proc = spawn("python3", ["hub_app.py", "serve", "--host", "127.0.0.1", "--port", String(port)],
  {cwd:root,stdio:"ignore"});
async function health() {
  for(let n=0;n<60;n++){
    try {if((await fetch(base+"/healthz")).ok)return;} catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error("server did not start");
}
const veryLongTitle = "https://internal.example/" + "A".repeat(1000);
const all = Array.from({length:85},(_,i)=>({
  seq:85-i,id:"entry-"+(85-i),session_id:"long",session_title:veryLongTitle,
  source:i===0?"chatgpt-to-muse-sdk":"chatgpt-to-codex-cli",
  created_at:"2026-11-17T00:00:00Z",metadata:null,
  characters:20,excerpt:"依頼の本文 "+String(85-i)
}));
function detail(seq) {
  return {delegation:{
    seq,id:"entry-"+seq,session_id:"long",session_title:veryLongTitle,
    author:"chatgpt",kind:"delegation",
    source:seq===85?"chatgpt-to-muse-sdk":"chatgpt-to-codex-cli",
    created_at:"2026-11-17T00:00:00Z",metadata:null,
    content:"Exact prompt "+seq,content_format:"markdown",rich:null
  },related:seq===80?[
    {seq:79,revision_type:"followup",source:"chatgpt-to-codex-cli"},
    {seq:80,revision_type:"retry",source:"chatgpt-to-codex-cli"}
  ]:[]};
}
async function run(engine) {
  const browser=await engine.launch({headless:true,args:engine===chromium?["--no-sandbox"]:[]});
  const page=await browser.newPage({viewport:{width:393,height:852},isMobile:true});
  const errors=[];
  page.on("pageerror", e=>errors.push(e.message));
  let stall=false;
  const backlog=[];
  async function serveList(route) {
    const url=new URL(route.request().url());
    const limit=Number(url.searchParams.get("limit")||40);
    const before=Number(url.searchParams.get("before")||Number.MAX_SAFE_INTEGER);
    const remaining=all.filter(x=>x.seq<before);
    const records=remaining.slice(0,limit);
    const output={delegations:records,next_before:remaining.length>limit?records.at(-1).seq:null};
    if (stall) {
      await new Promise(resolve=>backlog.push(resolve));
    }
    await route.fulfill({json:output});
  }
  await page.route("**/api/sessions",route=>route.fulfill({json:{sessions:[{
    id:"long",title:veryLongTitle,message_count:86
  }]}}));
  await page.route("**/api/sessions/*/events?*",route=>route.fulfill({json:{events:[{
    seq:1,id:"muse-history",session_id:"long",author:"chatgpt",kind:"delegation",
    source:"chatgpt-to-muse-sdk",created_at:"2026-11-17T00:00:00Z",
    content:"Muse prompt",content_format:"text",metadata:null,rich:null
  }]}}));
  await page.route(/\/api\/delegations\/\d+$/,route=>{
    const seq=Number(new URL(route.request().url()).pathname.split("/").at(-1));
    return route.fulfill({json:detail(seq)});
  });
  await page.route("**/api/delegations?*",serveList);
  try {
    await page.goto(base,{waitUntil:"domcontentloaded"});
    await page.locator(".request-card").first().waitFor();
    assert.equal(await page.locator(".request-card").count(),40);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),
      engine.name()+" long URL should not overflow mobile width");
    await page.locator("#request-more").click();
    await page.waitForFunction(()=>document.querySelectorAll(".request-card").length===80);
    await page.locator(".request-card").nth(49).scrollIntoViewIfNeeded();
    const anchor=await page.evaluate(()=>{
      const item=document.querySelectorAll(".request-card")[49];
      return {seq:item.dataset.seq,top:item.getBoundingClientRect().top,scroll:scrollY};
    });
    await page.locator("#reload").click();
    await page.waitForFunction(()=>document.querySelectorAll(".request-card").length===80);
    const after=await page.evaluate(seq=>{
      const item=[...document.querySelectorAll(".request-card")].find(x=>x.dataset.seq===seq);
      return {count:document.querySelectorAll(".request-card").length,top:item?.getBoundingClientRect().top,scroll:scrollY};
    },anchor.seq);
    assert.equal(after.count,80, "refresh must preserve loaded page count");
    assert.ok(Math.abs(after.top-anchor.top)<12, "refresh should retain visible anchor");
    await page.locator(".request-card").filter({hasText:"依頼の本文 80"}).first().click();
    await page.locator(".request-full-text").waitFor();
    const labels=await page.locator(".version-button").allTextContents();
    assert.deepEqual(labels,["追記","再試行（最新）"]);
    await page.locator("#request-back").click();
    await page.locator("#history-tab").click();
    await page.locator(".message .kind").waitFor();
    assert.equal(await page.locator(".message .kind").first().textContent(),"Museへの依頼");
    const direct=await browser.newPage({viewport:{width:393,height:852},isMobile:true});
    await direct.route("**/api/sessions", route=>route.fulfill({json:{sessions:[]}}));
    await direct.route("**/api/delegations?*", async route=>{
      await new Promise(resolve=>backlog.push(resolve));
      await route.fulfill({json:{delegations:[],next_before:null}});
    });
    await direct.route(/\/api\/delegations\/\d+$/,route=>route.fulfill({json:detail(80)}));
    await direct.goto(base+"/#request/80",{waitUntil:"domcontentloaded"});
    await direct.locator(".request-full-text").waitFor({timeout:4000});
    assert.equal(await direct.locator(".request-full-text").textContent(),"Exact prompt 80");
    while (backlog.length) backlog.shift()();
    await direct.close();
    assert.deepEqual(errors,[]);
    console.log("PASS "+engine.name()+" review fixes: overflow, 80-card refresh, retry labels, Muse history, delayed list deep link");
  } finally {
    stall=false;while(backlog.length)backlog.shift()();
    await browser.close();
  }
}
(async()=>{
  try {
    await health();
    await run(chromium);
    await run(webkit);
  } finally {proc.kill("SIGTERM");}
})().catch(e=>{console.error(e);proc.kill("SIGTERM");process.exitCode=1});
