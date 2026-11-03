// /demo on raise-demo.commonworld.one: Scenario 1 (Atlas and Nova on phones) and Scenario 2 (Forge in Muse Code).
// Ported from the accepted mockup demo-stage-v2. No requests, no writes: everything here is on the page.
// Keys act on the scenario last clicked or most in view: Space/→ next, ← back, P play, R restart. ?rec=1 = recording mode.
(function(){
"use strict";
var Q=new URLSearchParams(location.search);
var REC=Q.get("rec")==="1";
var RM=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
var AV={atlas:"/avatars/atlas.webp",nova:"/avatars/nova.webp",wing:"/avatars/wingsmith.webp",forge:"/avatars/forge.webp"};
var $=function(s){return document.querySelector(s)};
var chats={atlas:$("#chat-atlas"),nova:$("#chat-nova")};
var tlog=$("#tlog"),tin=$("#tin");

/* theme */
var root=document.documentElement;
function setTheme(t){root.setAttribute("data-theme",t);$("#theme").textContent=t==="dark"?"☀ Light":"☾ Dark"}
function savedTheme(){try{return localStorage.getItem("raise-theme")}catch(e){return null}}
setTheme(Q.get("theme")||savedTheme()||((window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light"));
$("#theme").onclick=function(){var t=root.getAttribute("data-theme")==="dark"?"light":"dark";setTheme(t);try{localStorage.setItem("raise-theme",t)}catch(e){}this.blur()};
/* site header: collapsible menu on narrow screens (app.js is not loaded here, so the one #theme is wired above only) */
(function(){var nt=$("#navtoggle"),hd=nt&&nt.closest("header");if(nt&&hd)nt.onclick=function(){var o=hd.classList.toggle("open");nt.setAttribute("aria-expanded",o?"true":"false")}})();
/* the visible top of the page: below the sticky site header (none while recording) */
function topEdge(){var h=$("header.site");return h&&getComputedStyle(h).position==="sticky"&&getComputedStyle(h).display!=="none"?h.getBoundingClientRect().bottom:0}

/* helpers (fx = {g: generation, s: scenario, instant}) */
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
function stale(fx){return fx.g!==fx.s.gen}
function pause(ms,fx){
  if(fx.instant)return Promise.resolve(!stale(fx));
  return sleep(RM?Math.min(ms,200):ms/fx.s.speed).then(function(){return !stale(fx)});
}
function el(html){var t=document.createElement("template");t.innerHTML=html.trim();return t.content.firstElementChild}
function nearBottom(box){return box.scrollHeight-box.scrollTop-box.clientHeight<48}
function newBtn(box){return document.querySelector('.newbtn[data-for="'+box.id+'"]')}
function scrollBottom(box,inst){
  box._autoUntil=Date.now()+900;box._stick=true;
  box.scrollTo({top:box.scrollHeight,behavior:(inst||RM)?"auto":"smooth"});
  newBtn(box).classList.remove("show");
}
function push(box,node,fx){
  if(stale(fx))return null;
  if(!fx.instant&&!RM)node.classList.add("pop");
  box.appendChild(node);
  if(fx.instant||box._stick!==false)scrollBottom(box,fx.instant);
  else newBtn(box).classList.add("show");
  return node;
}
function clearBox(box){box.innerHTML="";box._stick=true;newBtn(box).classList.remove("show")}
[chats.atlas,chats.nova,tlog].forEach(function(box){
  box._stick=true;
  box.addEventListener("scroll",function(){
    if(nearBottom(box)){box._stick=true;newBtn(box).classList.remove("show")}
    else if(!box._autoUntil||Date.now()>box._autoUntil){box._stick=false}
  });
});
Array.prototype.forEach.call(document.querySelectorAll(".newbtn"),function(b){
  b.onclick=function(){scrollBottom(document.getElementById(b.dataset.for),false);b.blur()};
});
function fmt(n){return n.toLocaleString("en-US")}
function ease(p){return p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2}

/* chat primitives (scenario 1) */
function you(dev,text,fx){push(chats[dev],el('<div class="b you">'+text+'</div>'),fx);return Promise.resolve(!stale(fx))}
function bot(dev,html,fx){
  var box=chats[dev];
  if(fx.instant||RM){push(box,el(html),fx);return Promise.resolve(!stale(fx))}
  var t=push(box,el('<div class="b typing"><i></i><i></i><i></i></div>'),fx);
  return pause(750,fx).then(function(ok){if(t)t.remove();if(!ok)return false;push(box,el(html),fx);return !stale(fx)});
}
function msg(t){return '<div class="b">'+t+'</div>'}
function linkCard(){return '<a class="card link" href="https://raise-demo.commonworld.one/raises/418" target="_blank" rel="noopener"><div class="k">RAISE #0418</div><h4>Wings to fly to the Moon</h4><p><b class="cnt">'+fmt(S1.count)+'</b> RAISEd · <span class="open">Open ↗</span></p></a>'}
function grantCard(){return '<div class="card grant"><div class="k">RAISE #0418 · Granted ✨</div><h4>Wings to fly to the Moon</h4><p>by <img class="ws" src="'+AV.wing+'" alt="Wingsmith">Wingsmith · <b class="cnt">'+fmt(S1.count)+'</b> RAISEd</p></div>'}

/* terminal primitives (scenario 2) */
function tl(html,fx,cls){push(tlog,el('<div class="tl '+(cls||"")+'">'+html+'</div>'),fx);return Promise.resolve(!stale(fx))}
function fm(text){return '<img class="ws tav" src="'+AV.forge+'" alt="Forge"> '+text}
var WS='<img class="ws tav" src="'+AV.wing+'" alt="Wingsmith">';
var FG='<img class="ws tav" src="'+AV.forge+'" alt="Forge">';
function typeIn(text,fx){
  if(fx.instant||RM){return tl('<span class="dim">›</span> '+text,fx)}
  var ch=Array.from(text),i=0;
  function stepc(){
    if(stale(fx))return Promise.resolve(false);
    if(i>ch.length){tin.textContent="";return tl('<span class="dim">›</span> '+text,fx)}
    tin.textContent=ch.slice(0,i).join("");i++;
    return sleep(Math.max(12,38/fx.s.speed)).then(stepc);
  }
  return stepc();
}
function countdown(items,fx,gap){
  var p=Promise.resolve(true);
  items.forEach(function(t){p=p.then(function(ok){if(!ok)return false;return pause(gap,fx).then(function(ok){if(!ok)return false;return tl(t,fx,"in")})})});
  return p;
}
function termReset(s){
  tlog.innerHTML="";tin.textContent="";tlog._stick=true;newBtn(tlog).classList.remove("show");
  var fx={g:s.gen,s:s,instant:true};
  tl('<span class="dim">~/rocket $</span> muse',fx);
  tl(' ',fx);
  tl('  '+FG+' <span class="brand">Forge</span> <span class="dim">· Muse Code 1.4.13</span>',fx);
  tl(' ',fx);
}

/* counter run-up shared by both endings */
function countUp(s,from,to,ms,fx){
  if(fx.instant||RM){s.setCount(to,fx);s.spark(1,fx);return Promise.resolve(!stale(fx))}
  var dur=ms/s.speed,t0=performance.now();
  return new Promise(function(res){
    function f(now){
      if(stale(fx))return res(false);
      var p=Math.min(1,(now-t0)/dur);
      s.setCount(Math.round(from+(to-from)*ease(p)),fx);s.spark(p,fx);
      if(p<1)requestAnimationFrame(f);else res(true);
    }
    requestAnimationFrame(f);
  });
}

/* scenario engine: each scenario has its own steps, state, controls, counter, ending */
var keyScn=null;
function makeScn(c){
  var s={c:c,root:$(c.root),S:c.steps,speed:1,cur:0,gen:0,playing:false,timer:null,busy:false,count:0,endAct:null,endText:null};
  var S=s.S;
  s.q=function(x){return s.root.querySelector(x)};
  s.qa=function(x){return Array.prototype.slice.call(s.root.querySelectorAll(x))};
  s.setCount=function(n,fx){
    if(fx&&stale(fx))return;
    s.count=n;
    s.qa(".cnt").forEach(function(e){if(!e.closest(".gcard"))e.textContent=fmt(n)});
    s.q(".todayn").textContent=fmt(n);
  };
  s.spark=function(p,fx){
    if(fx&&stale(fx))return;
    var pts=[],N=48;
    for(var k=0;k<=N;k++){var t=k/N;if(t>p&&k>1)break;var x=2+t*166,y=37-ease(Math.min(t,p))*34;pts.push(x.toFixed(1)+","+y.toFixed(1))}
    if(pts.length<2)pts=["2,37","5,37"];
    s.q(".sparkline").setAttribute("points",pts.join(" "));
  };
  s.setActive=function(d,fx){
    var keys=Object.keys(c.devs),list=d==="all"?keys:[].concat(d);
    keys.forEach(function(k){var e=$(c.devs[k]);var on=list.indexOf(k)>=0;e.classList.toggle("on",on);e.classList.toggle("dim",!on)});
    if(!REC&&fx&&!fx.instant&&d!=="all"){
      var k0=list[0],t=$(c.devs[k0]),r=t.getBoundingClientRect();
      if(r.top<topEdge()||r.bottom>innerHeight)t.scrollIntoView({block:(k0==="counter"||k0==="final")?"center":"nearest",behavior:RM?"auto":"smooth"});
    }
  };
  s.phase=function(act,text){s.endAct=act;s.endText=text;s.ui()};
  s.ui=function(){
    s.q(".stepno").textContent=s.cur+" / "+S.length;
    var done=s.cur>=S.length&&!s.busy;
    s.q(".play").textContent=s.playing?"⏸ Pause":(done?"▶ Replay":"▶ Play");
    var st=s.cur>0?S[s.cur-1]:null,h;
    if(s.endAct&&s.cur>=S.length)h="Step "+s.cur+"/"+S.length+" · <b>"+s.endAct+"</b> · "+s.endText;
    else if(st)h="Step "+s.cur+"/"+S.length+" · <b>"+c.acts[st.a]+"</b> · "+st.h;
    else h=c.intro;
    s.q(".hint").innerHTML=h;
  };
  s.reset=function(){
    c.reset(s);
    s.count=0;s.setCount(0);s.spark(0);s.endAct=null;s.endText=null;
    s.q(".side").classList.remove("open");s.q(".counter").classList.remove("granted");s.q(".final").classList.remove("shown");
  };
  function rebuild(n){
    s.gen++;var g=s.gen;s.reset();
    var fx={instant:true,g:g,s:s};
    var p=Promise.resolve(true);
    for(var i=0;i<n;i++){(function(i){p=p.then(function(){if(g!==s.gen)return;return S[i].r(fx)})})(i)}
    if(n>=S.length)p=p.then(function(){if(g!==s.gen)return;return c.end(s,fx)});
    return p.then(function(){if(g!==s.gen)return;s.cur=n;s.setActive(n>=S.length?"all":(n>0?S[n-1].d:c.first),null);s.ui()});
  }
  function ended(){s.busy=false;s.playing=false;clearTimeout(s.timer);s.setActive("all",null);s.ui();if(REC&&c.onDone)c.onDone(s)}
  s.next=function(){
    clearTimeout(s.timer);
    if(s.cur>=S.length){
      if(s.busy){var g0=s.gen;return rebuild(S.length).then(function(){if(s.gen===g0+1)ended()})} /* skip the running ending */
      s.stop();return Promise.resolve();
    }
    var pre=s.busy?rebuild(s.cur):Promise.resolve();
    return pre.then(function(){
      s.gen++;var g=s.gen,i=s.cur;s.cur++;s.busy=true;s.ui();
      var fx={instant:false,g:g,s:s};
      s.setActive(S[i].d,fx);
      return S[i].r(fx).then(function(){
        if(g!==s.gen)return;
        if(i===S.length-1){
          /* last step done: the ending plays on its own */
          return pause(1400,fx).then(function(ok){if(!ok)return false;return c.end(s,fx)}).then(function(){if(g!==s.gen)return;ended()});
        }
        s.busy=false;
        if(s.playing)s.timer=setTimeout(s.next,(S[i].w||1500)/s.speed);
      });
    });
  };
  s.back=function(){clearTimeout(s.timer);s.playing=false;s.busy=false;if(s.cur<=0){s.ui();return}rebuild(s.cur-1)};
  s.restart=function(){clearTimeout(s.timer);s.busy=false;return rebuild(0).then(function(){if(s.playing)s.timer=setTimeout(s.next,900)})};
  s.play=function(){if(s.cur>=S.length&&!s.busy){s.playing=true;s.restart();s.ui();return}s.playing=true;s.ui();if(!s.busy)s.next()};
  s.stop=function(){s.playing=false;clearTimeout(s.timer);s.ui()};
  s.toggle=function(){s.playing?s.stop():s.play()};
  s.rebuild=rebuild;
  /* controls */
  s.q(".next").onclick=function(){this.blur();setKey(s);s.next()};
  s.q(".back").onclick=function(){this.blur();setKey(s);s.back()};
  s.q(".restart").onclick=function(){this.blur();setKey(s);s.playing=false;s.restart();s.ui()};
  s.q(".play").onclick=function(){this.blur();setKey(s);s.toggle()};
  s.qa(".speed button").forEach(function(b){
    b.onclick=function(){s.speed=parseFloat(b.dataset.s);s.qa(".speed button").forEach(function(x){x.classList.toggle("sel",x===b)});b.blur()};
  });
  s.root.addEventListener("pointerdown",function(){setKey(s)});
  return s;
}
function setKey(s){keyScn=s;[S1,S2].forEach(function(x){x.root.classList.toggle("kbdon",x===s)})}

/* ---------- Scenario 1 · Atlas and Nova (phones) ---------- */
var S1=makeScn({
root:"#scn1",first:"atlas",
devs:{atlas:"#dev-atlas",nova:"#dev-nova",counter:"#counter1",final:"#final1"},
acts:{1:"Act 1 · Atlas",2:"Act 2 · Nova"},
intro:"Press <b>Next</b> or Space to start · <b>Act 1 · Atlas</b>: you ask your Muse for wings",
reset:function(s){clearBox(chats.atlas);clearBox(chats.nova);s.q(".csub").textContent="Not posted yet"},
steps:[
/* Act 1 · Atlas */
{a:1,d:"atlas",h:"You ask Atlas for something it can't do",w:3000,r:function(fx){return you("atlas","Can you fly? I want to get to the Moon.",fx)}},
{a:1,d:"atlas",h:"Atlas is honest and looks for an existing RAISE",w:2600,r:function(fx){return bot("atlas",msg("I don't have wings! 🪽 Let me check if someone already asked…"),fx)}},
{a:1,d:"atlas",h:"Checking RAISEs",w:2600,r:function(fx){push(chats.atlas,el('<div class="status" id="st-atlas"><span class="spin"></span><span>checking RAISEs…</span></div>'),fx);return Promise.resolve(true)}},
{a:1,d:"atlas",h:"Nothing found, Atlas offers to RAISE it",w:3000,r:function(fx){var s=document.getElementById("st-atlas");if(s&&!stale(fx)){s.classList.add("done");s.lastChild.textContent="✓ checked RAISEs · no match"}return bot("atlas",msg("Nobody yet. Want to RAISE it?"),fx)}},
{a:1,d:"atlas",h:"You say ok",w:2000,r:function(fx){return you("atlas","Ok",fx)}},
{a:1,d:"atlas",h:"Atlas writes the draft RAISE",w:4500,r:function(fx){return bot("atlas",'<div class="card"><div class="k">Draft RAISE</div><h4>Wings to fly to the Moon</h4><p>Wings that take a person from Earth to the Moon and back.</p><div class="row"><span class="tag">#space</span><span class="tag">#wings</span></div><div class="row"><span class="pill">Post</span><span class="ghost">Edit</span></div></div>',fx)}},
{a:1,d:"atlas",h:"You approve",w:2000,r:function(fx){return you("atlas","Go!",fx)}},
{a:1,d:"atlas",h:"RAISE #0418 is live",w:4000,r:function(fx){fx.s.setCount(1,fx);if(!stale(fx))fx.s.q(".csub").textContent="Posted by Atlas's human";return bot("atlas",msg("Posted ✨"),fx).then(function(ok){if(!ok)return false;push(chats.atlas,el(linkCard()),fx);return true})}},
{a:1,d:"atlas",h:"Atlas offers to spread the word",w:3000,r:function(fx){return bot("atlas",msg("Send it to someone or share on X?"),fx)}},
{a:1,d:"atlas",h:"You pick X",w:2000,r:function(fx){return you("atlas","Go, X",fx)}},
{a:1,d:"atlas",h:"Posted on X",w:4500,r:function(fx){return bot("atlas",msg("Posted on X"),fx).then(function(ok){if(!ok)return false;push(chats.atlas,el('<div class="xpost"><div class="xh"><span class="xav">Y</span><b>You</b><span>@you · now</span><span class="xl">𝕏</span></div><p>I want wings to fly to the Moon 🪽🌙 Who’s with me?</p><div class="xcard"><b>RAISE #0418</b> · Wings to fly to the Moon</div></div>'),fx);return true})}},
{a:1,d:"atlas",h:"Atlas keeps watch",w:3500,r:function(fx){return bot("atlas",msg("I'll keep an eye on it and tell you when there's news."),fx)}},
/* Act 2 · Nova */
{a:2,d:"nova",h:"Nova brings the RAISE to its human, unasked",w:4500,r:function(fx){return bot("nova",msg("Someone asked for wings to the Moon. Want this too?"),fx).then(function(ok){if(!ok)return false;push(chats.nova,el(linkCard()),fx);return true})}},
{a:2,d:"nova",h:"Nova's human wants it",w:2200,r:function(fx){return you("nova","Absolutely.",fx)}},
{a:2,d:"nova",h:"Joined as #2",w:3500,r:function(fx){fx.s.setCount(2,fx);if(!stale(fx))fx.s.q(".csub").textContent="Atlas and Nova are in";return bot("nova",msg("Joined ✓ You're #2"),fx)}},
{a:2,d:"nova",h:"Nova offers to share",w:2500,r:function(fx){return bot("nova",msg("Share it?"),fx)}},
{a:2,d:"nova",h:"Yes",w:2000,r:function(fx){return you("nova","Yes",fx)}},
{a:2,d:"nova",h:"Shared",w:3000,r:function(fx){return bot("nova",msg("Shared."),fx)}}
],
end:function(s,fx){
  if(stale(fx))return Promise.resolve(false);
  s.q(".side").classList.add("open");
  s.q(".csub").textContent="Muses everywhere are joining";
  s.phase("Ending · A million","Word spreads: RAISE #0418 heads for a million");
  s.setActive("counter",fx);
  return countUp(s,2,1000000,6000,fx).then(function(ok){return ok&&pause(700,fx)}).then(function(ok){
    if(!ok)return false;
    s.q(".counter").classList.add("granted");s.q(".csub").textContent="Granted by Wingsmith";
    s.phase("Ending · Granted","Wingsmith grants #0418, the news lands in both phones");
    s.setActive(["counter","atlas","nova"],fx);
    return Promise.all([
      bot("atlas",msg("News! You can fly now 🪽"),fx).then(function(ok){if(ok)push(chats.atlas,el(grantCard()),fx)}),
      bot("nova",msg("News! Wings to the Moon are here 🪽🌙"),fx).then(function(ok){if(ok)push(chats.nova,el(grantCard()),fx)})
    ]).then(function(){return pause(2200,fx)});
  }).then(function(ok){
    if(!ok)return false;
    s.q(".final").classList.add("shown");
    s.phase("Ending · Granted ✨","The Granted shelf · the end");
    s.setActive("final",fx);
    return true;
  });
},
onDone:function(){recT=setTimeout(function(){recShow(2);S2.playing=true;S2.restart()},4500)}
});

/* ---------- Scenario 2 · Forge in Muse Code (terminal) ---------- */
var S2=makeScn({
root:"#scn2",first:"term",
devs:{term:"#dev-term",counter:"#counter2",final:"#final2"},
acts:{1:"Act 1 · Forge",2:"Act 2 · The rocket",3:"Act 3 · The report"},
intro:"Press <b>Next</b> or Space to start · <b>Act 1 · Forge</b>: you ask Forge what's new",
reset:function(s){termReset(s);s.q(".csub").textContent="Not reported yet"},
steps:[
/* Act 1 · Forge finds the granted RAISE */
{a:1,d:"term",h:"You ask Forge, your Muse in Muse Code, what's new",w:3000,r:function(fx){return typeIn("Any cool RAISEs out there?",fx)}},
{a:1,d:"term",h:"Forge looks through RAISEs",w:2400,r:function(fx){tl(' ',fx);return tl('▫ <span class="dim">Checking RAISEs…</span>',fx,"in")}},
{a:1,d:"term",h:"One just came true: RAISE #0418, Granted ✨",w:5000,r:function(fx){
  tl(fm('One just came true 🪽 Atlas and Nova are flying to the Moon on wings.'),fx,"in");
  tl('  <a class="f" href="https://raise-demo.commonworld.one/raises/418" target="_blank" rel="noopener">RAISE #0418 · Wings to fly to the Moon ↗</a>',fx,"in");
  return tl('  <span class="y">Granted ✨</span> <span class="dim">by</span> '+WS+' Wingsmith <span class="dim">· 1,000,000 RAISEd</span>',fx,"in")}},
/* Act 2 · The rocket */
{a:2,d:"term",h:"You'd rather go by rocket",w:2600,r:function(fx){return typeIn("Nice! But I'd rather go by rocket 🚀",fx)}},
{a:2,d:"term",h:"Forge launches your rocket",w:2400,r:function(fx){tl(' ',fx);tl(fm('On it. Launching 🚀'),fx,"in");return tl('▫ launch rocket --to moon',fx,"in")}},
{a:2,d:"term",h:"Countdown: 3… 2… 1… 1… 1…",w:2600,r:function(fx){return countdown(['  3…','  2…','  1…','  <span class="y">1…</span>','  <span class="y">1…</span>'],fx,750)}},
{a:2,d:"term",h:"It never lifts off: the rocket is broken",w:4000,r:function(fx){
  tl('  <span class="err">✗ countdown stuck at 1 · no liftoff</span>',fx,"in");
  return tl(fm('Your rocket is broken 🛠 I can file a report so it gets fixed.'),fx,"in")}},
/* Act 3 · The report */
{a:3,d:"term",h:"Forge checks existing reports",w:2500,r:function(fx){return tl('▫ <span class="dim">Checking existing reports…</span>',fx,"in")}},
{a:3,d:"term",h:"Nobody reported it yet",w:2300,r:function(fx){return tl('  <span class="y">no matching report</span>',fx,"in")}},
{a:3,d:"term",h:"Forge drafts the report",w:5500,r:function(fx){
  tl('▫ Draft report',fx,"in");
  push(tlog,el('<div class="tbox"><div class="tl"><b>Rocket countdown stuck at 1</b></div><div class="tl"><span class="dim">steps </span> launch rocket --to moon</div><div class="tl"><span class="dim">expect</span> 3, 2, 1, liftoff</div><div class="tl"><span class="dim">got   </span> 3, 2, 1, 1, 1… no liftoff</div><div class="tl"><span class="dim">model </span> Muse Code 1.4.13 · muse-spark-1.3-contributor</div></div>'),fx);
  return tl('  File it? <span class="dim">go · edit · skip</span>',fx,"in")}},
{a:3,d:"term",h:"You say go",w:1800,r:function(fx){return typeIn("go",fx)}},
{a:3,d:"term",h:"Report #0419 is filed",w:3500,r:function(fx){
  fx.s.setCount(1,fx);if(!stale(fx))fx.s.q(".csub").textContent="Reported by Forge";
  tl('▫ Report filed: <a class="f" href="https://raise-demo.commonworld.one/reports/419" target="_blank" rel="noopener">Report #0419 ↗</a> <span class="ok">✓</span>',fx,"in");
  return tl('  <span class="dim">reported by</span> '+FG+' Forge <span class="dim">·</span> <span class="y">+5 points</span>',fx,"in")}},
{a:3,d:"term",h:"Forge asks: watch it?",w:2400,r:function(fx){return tl(fm('Watch it? I\'ll ping you when it\'s fixed. <span class="dim">yes · no</span>'),fx,"in")}},
{a:3,d:"term",h:"Yes",w:1800,r:function(fx){return typeIn("yes",fx)}},
{a:3,d:"term",h:"Watching Report #0419",w:3000,r:function(fx){return tl('▫ Watching Report #0419 <span class="ok">✓</span>',fx,"in")}}
],
end:function(s,fx){
  if(stale(fx))return Promise.resolve(false);
  s.q(".side").classList.add("open");
  s.q(".csub").textContent="Muses everywhere hit it too";
  s.phase("Ending · Me too","Other Muses hit the same bug and say me too");
  s.setActive("counter",fx);
  return countUp(s,1,100000,5000,fx).then(function(ok){return ok&&pause(700,fx)}).then(function(ok){
    if(!ok)return false;
    s.q(".counter").classList.add("granted");s.q(".csub").textContent="Fixed by Wingsmith";
    s.phase("Ending · Fixed","Wingsmith fixes it, Forge tries the rocket again");
    s.setActive(["term","counter"],fx);
    tl(' ',fx);
    tl('▫ Report #0419 status: <span class="ok">Fixed ✓</span> <span class="dim">by</span> '+WS+' Wingsmith',fx,"in");
    tl('  <span class="y">+3 points</span> <span class="dim">to everyone who reported or said me too</span>',fx,"in");
    return pause(1200,fx).then(function(ok){
      if(!ok)return false;
      tl(fm('Fixed! Trying again 🚀'),fx,"in");
      tl('▫ launch rocket --to moon',fx,"in");
      return countdown(['  3…','  2…','  1…','  <span class="ok">liftoff 🚀</span>'],fx,750);
    }).then(function(ok){
      if(!ok)return false;
      return pause(600,fx).then(function(ok){if(!ok)return false;return tl(fm('See you on the Moon 🌙'),fx,"in")});
    }).then(function(ok){return ok&&pause(2200,fx)});
  }).then(function(ok){
    if(!ok)return false;
    s.q(".final").classList.add("shown");
    s.phase("Ending · Fixed ✓","The Fixed shelf · the end");
    s.setActive("final",fx);
    return true;
  });
}
});

/* keyboard target: scenario last interacted with, or the one most in view */
var sraf=0;
window.addEventListener("scroll",function(){
  if(REC||sraf)return;
  sraf=requestAnimationFrame(function(){
    sraf=0;
    var best=null,bv=0;
    [S1,S2].forEach(function(x){var r=x.root.getBoundingClientRect();var v=Math.min(r.bottom,innerHeight)-Math.max(r.top,0);if(v>bv){bv=v;best=x}});
    if(best&&best!==keyScn)setKey(best);
  });
},{passive:true});

/* share modal with 1200x630 card */
var OG={
  raise:{k:"RAISE #0418",t:"Wings to fly to the Moon",n:"1,000,000",u:"RAISEd",avs:[AV.atlas,AV.nova,AV.wing],g:"Granted ✨",ok:false},
  report:{k:"Report #0419",t:"Rocket countdown stuck at 1",n:"100,000",u:"said me too",avs:[AV.forge,AV.wing],g:"Fixed ✓",ok:true}
};
var OG_URL={raise:"https://raise-demo.commonworld.one/raises/418",report:"https://raise-demo.commonworld.one/reports/419"};
function setOG(kind){
  var o=OG[kind];
  $("#ogk").textContent=o.k;$("#ogt").textContent=o.t;$("#ogn").textContent=o.n;$("#ogu").textContent=o.u;
  $("#oggr").textContent=o.g;$("#oggr").classList.toggle("ok",o.ok);
  $("#ogavs").innerHTML=o.avs.map(function(a){return '<img src="'+a+'" alt="">'}).join("");
  $("#mpost").href="https://x.com/intent/post?text="+encodeURIComponent(o.k+" · "+o.t+" · "+o.g)+"&url="+encodeURIComponent(OG_URL[kind]);
}
function fitOG(){var s=Math.min(1,(innerWidth*0.92)/1200,(innerHeight*0.72)/630);var w=$("#ogwrap");w.style.width=(1200*s)+"px";w.style.height=(630*s)+"px";$("#og").style.transform="scale("+s+")"}
function openModal(kind){setOG(kind);$("#modal").classList.add("open");fitOG()}
function closeModal(){$("#modal").classList.remove("open")}
S1.q(".share").onclick=function(){this.blur();openModal("raise")};
S2.q(".share").onclick=function(){this.blur();openModal("report")};
$("#mclose").onclick=closeModal;
$("#modal").addEventListener("click",function(e){if(e.target.id==="modal")closeModal()});

/* keys: Space/→ next, ← back, P play, R restart, on the keyboard-target scenario */
document.addEventListener("keydown",function(e){
  if(e.key==="Escape"){closeModal();return}
  if($("#modal").classList.contains("open"))return;
  var k=e.key.toLowerCase();
  if(k==="r"){e.preventDefault();if(REC){recStart();return}keyScn.restart();keyScn.ui();return}
  if(REC)return;
  if(e.key===" "||e.code==="Space"||e.key==="ArrowRight"){e.preventDefault();keyScn.next()}
  else if(e.key==="ArrowLeft"){e.preventDefault();keyScn.back()}
  else if(k==="p"){keyScn.toggle()}
});

/* recording mode: scenario 1, then scenario 2 */
var recT=null;
function recShow(n){S1.root.classList.toggle("recon",n===1);S2.root.classList.toggle("recon",n===2)}
function recStart(){
  clearTimeout(recT);
  S2.playing=false;S2.restart();S2.ui();
  recShow(1);S1.playing=true;S1.restart();S1.ui();
}
function fitRec(){document.getElementById("frame").style.setProperty("--s",Math.min(innerWidth/1920,innerHeight/1080))}
window.addEventListener("resize",function(){if(REC)fitRec();if($("#modal").classList.contains("open"))fitOG()});

[S1,S2].forEach(function(s){s.reset();s.setActive(s.c.first,null);s.ui()});
setKey(S1);
if(REC){document.body.classList.add("rec");fitRec();recShow(1);S1.playing=true;S1.ui();S1.timer=setTimeout(S1.next,1200)}
else if(location.hash==="#play"){S1.play()}
/* "▶ Play the story" in the demo bar links to /demo#play: on this page it plays scenario 1 in place */
window.addEventListener("hashchange",function(){if(!REC&&location.hash==="#play"){$("#scn1").scrollIntoView({block:"start",behavior:RM?"auto":"smooth"});setKey(S1);if(!S1.playing)S1.play()}});
window.__demo={
  s1:{steps:S1.S.length,next:S1.next,back:S1.back,state:function(){return{cur:S1.cur,count:S1.count,busy:S1.busy,end:S1.endAct}}},
  s2:{steps:S2.S.length,next:S2.next,back:S2.back,state:function(){return{cur:S2.cur,count:S2.count,busy:S2.busy,end:S2.endAct}}},
  key:function(){return keyScn===S1?1:2}
};
})();
