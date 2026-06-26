// client.js
const socket = io();

// ── 永続ID（再接続用） ──
// テスト用: URLに ?u=1 のように付けると、同じブラウザでも別プレイヤーとして扱える
// （localStorageのキーを ?u の値で分離する）。本番は付けないので従来通り。
const NS = new URLSearchParams(location.search).get("u") || "";
const K = (key) => (NS ? `${key}__${NS}` : key);

let playerId = localStorage.getItem(K("avalon_pid"));
if (!playerId) {
  playerId = "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem(K("avalon_pid"), playerId);
}
let myName = localStorage.getItem(K("avalon_name")) || "";
let roomCode = localStorage.getItem(K("avalon_room")) || "";

const ROLE_INFO = {
  merlin:   { name: "マーリン",     side: "good", desc: "悪が全員見えるが、暗殺者に正体を知られてはいけない" },
  percival: { name: "パーシヴァル", side: "good", desc: "マーリンとモルガナの2人が見える（どちらかは不明）" },
  loyal:    { name: "アーサーの忠臣", side: "good", desc: "情報なし。推理でクエストを成功させよう" },
  morgana:  { name: "モルガナ",     side: "evil", desc: "パーシヴァルにマーリンと紛れて見える" },
  assassin: { name: "暗殺者",       side: "evil", desc: "善が3勝したら、最後にマーリンを討てる" },
  minion:   { name: "モードレッドの手先", side: "evil", desc: "クエストを失敗させよう" },
};

// ── DOM ──
const $ = (id) => document.getElementById(id);
const screens = ["home","lobby","role","board","assassinate","end"];
function show(name){
  screens.forEach(s => $("screen-"+s).classList.toggle("hidden", s!==name));
}

// ── 入口 ──
$("nameInput").value = myName;
$("codeInput").value = roomCode;

$("btnCreate").onclick = () => {
  const name = $("nameInput").value.trim();
  if(!name){ $("homeError").textContent="名前を入れてください"; return; }
  myName = name; localStorage.setItem(K("avalon_name"), name);
  socket.emit("createRoom", { playerId, name }, (res) => {
    if(res.error){ $("homeError").textContent=res.error; return; }
    roomCode = res.code; localStorage.setItem(K("avalon_room"), roomCode);
  });
};

$("btnJoin").onclick = () => {
  const name = $("nameInput").value.trim();
  const code = $("codeInput").value.trim().toUpperCase();
  if(!name){ $("homeError").textContent="名前を入れてください"; return; }
  if(!code){ $("homeError").textContent="合言葉を入れてください"; return; }
  myName = name; localStorage.setItem(K("avalon_name"), name);
  socket.emit("joinRoom", { playerId, name, code }, (res) => {
    if(res.error){ $("homeError").textContent=res.error; return; }
    roomCode = res.code; localStorage.setItem(K("avalon_room"), roomCode);
  });
};

// ── リロード復帰 ──
socket.on("connect", () => {
  if(roomCode){
    socket.emit("resume", { playerId, code: roomCode }, (res) => {
      if(res && res.error){
        // 部屋が消えていたらホームへ
        localStorage.removeItem(K("avalon_room")); roomCode="";
        show("home");
      }
    });
  } else {
    show("home");
  }
});

// ── 選択状態（リーダーのチーム選び/暗殺） ──
let selected = new Set();

// ── 状態受信＝唯一の描画起点 ──
let S = null;
socket.on("state", (state) => {
  S = state;
  render();
});

function render(){
  if(!S) return;
  switch(S.phase){
    case "LOBBY": renderLobby(); show("lobby"); break;
    case "ROLE_REVEAL": renderRole(); show("role"); break;
    case "TEAM_BUILD":
    case "TEAM_VOTE":
    case "MISSION": renderBoard(); show("board"); break;
    case "ASSASSINATE": renderAssassinate(); show("assassinate"); break;
    case "END": renderEnd(); show("end"); break;
  }
}

// ── ロビー ──
function renderLobby(){
  $("roomCode").textContent = S.code;
  const list = $("playerList"); list.innerHTML="";
  S.players.forEach(p => {
    const li=document.createElement("li");
    li.innerHTML = `<span><span class="dot ${p.connected?"":"off"}"></span>${esc(p.name)}</span>`
      + (p.id===S.hostId ? `<span class="tag leader">ホスト</span>` : "");
    list.appendChild(li);
  });
  const n = S.players.length;
  $("lobbyMsg").textContent = `${n}人 参加中（5〜10人で開始できます）`;
  const canStart = S.youAreHost && n>=5 && n<=10;
  $("btnStart").classList.toggle("hidden", !S.youAreHost);
  $("btnStart").disabled = !canStart;
}
$("btnStart").onclick = () => socket.emit("startGame",{playerId,code:S.code});

// ── 役職確認 ──
function renderRole(){
  const info = ROLE_INFO[S.myRole] || {name:"?",side:"good",desc:""};
  const card=$("roleCard");
  card.className = "role-card " + S.mySide;
  card.innerHTML = `${info.name}<small>${info.desc}</small>`;
  $("roleVisText").textContent = S.visibility ? S.visibility.text : "";
  const ul=$("roleVisList"); ul.innerHTML="";
  (S.visibility?.names||[]).forEach(nm=>{
    const li=document.createElement("li"); li.textContent=esc(nm); ul.appendChild(li);
  });
  // 確認の進捗（誰が未確認か）と、自分が確認済みか（サーバーが正）
  const readyIds = S.readyIds || [];
  const total = S.players.length;
  const pending = S.players.filter(p=>!readyIds.includes(p.id)).map(p=>p.name);
  const iAmReady = readyIds.includes(S.you.id);
  $("btnReady").disabled = iAmReady;
  $("btnReady").textContent = iAmReady ? "確認済み" : "確認した";
  $("roleWait").textContent = `確認済み ${readyIds.length}/${total}`
    + (pending.length ? `（待ち：${pending.join("・")}）` : "（まもなく開始）");
}
$("btnReady").onclick = () => {
  socket.emit("ready",{playerId,code:S.code});
  $("btnReady").disabled = true; // 二重送信防止。届かなければ次の更新で押し直せる
  $("roleWait").textContent = "送信しました…他のプレイヤーを待っています";
};

// ── メインボード ──
function renderBoard(){
  // クエストトラック
  const track=$("questTrack"); track.innerHTML="";
  const sizes = S.questTeamSizes||[];
  const fails = S.failsTable||[];
  for(let i=0;i<5;i++){
    const q=document.createElement("div");
    let cls="q";
    if(S.questResults[i]==="success") cls+=" success";
    else if(S.questResults[i]==="fail") cls+=" fail";
    if(i===S.questIndex && !S.questResults[i]) cls+=" current";
    q.className=cls;
    const need = fails[i] || 1; // このクエストが失敗する「失敗の数」
    let label = "";
    if(S.questResults[i]==="success") label = "成功";
    else if(S.questResults[i]==="fail") label = "失敗";
    else if(i===S.questIndex) label = "進行中";
    q.innerHTML=`<span class="qtop ${need>=2?'warn':''}">✕${need}</span>`
      + `<span class="num">${sizes[i]||""}<small class="pp">人</small></span>`
      + `<span class="qlabel">${label}</span>`;
    track.appendChild(q);
  }

  const leader = S.players.find(p=>p.isLeader);
  // 勝敗スコア：先に3つで決着（成功3=善の勝利／失敗3=悪の勝利）
  const succ = S.questResults.filter(r=>r==="success").length;
  const fl   = S.questResults.filter(r=>r==="fail").length;
  $("scoreBar").innerHTML =
    `<span class="sc good">✅ 成功 ${succ}/3</span>`
    + `<span class="sc evil">❌ 失敗 ${fl}/3</span>`
    + `<span class="sc note">失敗が3つで悪の勝利／成功が3つで善の勝利</span>`;

  $("boardStatus").innerHTML =
    `クエスト ${S.questIndex+1} ／ リーダー：<b>${esc(leader?leader.name:"")}</b>`
    + (S.rejectCount>0 ? `<div class="rejects">連続否決 ${S.rejectCount}/5</div>` : "");

  // 自分の役職を常に小さく表示
  const info = ROLE_INFO[S.myRole];
  let myInfoText = info ? `あなた：${info.name}` : "";
  if(S.visibility && S.visibility.names.length){
    myInfoText += `｜${S.visibility.text}${S.visibility.names.map(esc).join("・")}`;
  }
  $("myInfo").textContent = myInfoText;

  // 全ボタン隠す→フェーズで出す
  $("btnSubmitTeam").classList.add("hidden");
  $("voteButtons").classList.add("hidden");
  $("missionButtons").classList.add("hidden");

  const ul=$("boardPlayers"); ul.innerHTML="";
  S.players.forEach(p=>{
    const li=document.createElement("li");
    if(!p.connected) li.classList.add("offline");
    let tags="";
    if(p.isLeader) tags+=`<span class="tag leader">リーダー</span>`;
    if(p.onTeam) tags+=`<span class="tag on">出撃</span>`;
    // 全員そろうと「投票済」が各自の「賛成/反対」に変わる
    const voteInfo = S.lastVote && S.lastVote.tally && S.lastVote.tally.find(t=>t.id===p.id);
    if(voteInfo){
      tags+= voteInfo.approve ? `<span class="tag yes">賛成</span>` : `<span class="tag no">反対</span>`;
    } else if(S.phase==="TEAM_VOTE" && p.voted){
      tags+=`<span class="tag ok">投票済</span>`;
    }
    if(S.phase==="MISSION" && p.onTeam && p.acted) tags+=`<span class="tag ok">実行済</span>`;
    li.innerHTML=`<span>${esc(p.name)}</span><span>${tags}</span>`;

    // リーダーのチーム選択
    if(S.phase==="TEAM_BUILD" && S.youAreLeader){
      li.onclick=()=>{
        if(selected.has(p.id)) selected.delete(p.id);
        else { if(selected.size>=S.teamSize) return; selected.add(p.id); }
        li.classList.toggle("selected", selected.has(p.id));
        $("btnSubmitTeam").disabled = selected.size!==S.teamSize;
      };
      if(selected.has(p.id)) li.classList.add("selected");
    }
    ul.appendChild(li);
  });

  // フェーズごとの指示と操作
  if(S.phase==="TEAM_BUILD"){
    if(S.youAreLeader){
      $("instruction").textContent = `クエストに出す ${S.teamSize} 人を選んでください`;
      $("btnSubmitTeam").classList.remove("hidden");
      $("btnSubmitTeam").disabled = selected.size!==S.teamSize;
    } else {
      $("instruction").textContent = `${esc(leader?leader.name:"")} がメンバーを選んでいます…`;
    }
  }
  else if(S.phase==="TEAM_VOTE"){
    selected.clear();
    const voted = S.players.find(p=>p.id===S.you.id)?.voted;
    if(voted){
      $("instruction").textContent = "全員の投票を待っています…";
    } else {
      $("instruction").textContent = "この編成に賛成？反対？";
      $("voteButtons").classList.remove("hidden");
    }
  }
  else if(S.phase==="MISSION"){
    if(S.onMyTeam){
      const acted = S.players.find(p=>p.id===S.you.id)?.acted;
      if(acted){
        $("instruction").textContent = "結果が出るのを待っています…";
      } else {
        $("instruction").textContent = (S.mySide==="evil")
          ? "成功か失敗を選んでください"
          : "クエストに貢献しましょう";
        $("missionButtons").classList.remove("hidden");
        // 善は失敗ボタンを無効化
        $("btnFail").disabled = (S.mySide==="good");
        $("btnFail").style.opacity = (S.mySide==="good") ? .3 : 1;
      }
    } else {
      $("instruction").textContent = "出撃メンバーの結果を待っています…";
    }
  }
}
$("btnSubmitTeam").onclick = () => {
  socket.emit("submitTeam",{playerId,code:S.code,teamIds:[...selected]});
};
$("btnApprove").onclick = () => sendVote(true);
$("btnReject").onclick  = () => sendVote(false);
function sendVote(v){
  socket.emit("vote",{playerId,code:S.code,approve:v});
  $("voteButtons").classList.add("hidden");
  $("instruction").textContent = "投票を送信しました…";
}
$("btnSuccess").onclick = () => sendMission("success");
$("btnFail").onclick    = () => sendMission("fail");
function sendMission(a){
  socket.emit("mission",{playerId,code:S.code,action:a});
  $("missionButtons").classList.add("hidden");
  $("instruction").textContent = "実行しました…";
}

// ── 暗殺 ──
function renderAssassinate(){
  const amAssassin = S.myRole==="assassin";
  $("assassinText").textContent = amAssassin
    ? "善が3勝しました。マーリンだと思う相手を1人選んで討ち取れば逆転勝利です。"
    : "暗殺者がマーリンを探しています…";
  const ul=$("assassinList"); ul.innerHTML="";
  selected.clear();
  S.players.forEach(p=>{
    if(p.id===S.you.id) return; // 自分は対象外
    const li=document.createElement("li");
    li.innerHTML=`<span>${esc(p.name)}</span>`;
    if(amAssassin){
      li.onclick=()=>{
        selected.clear(); selected.add(p.id);
        [...ul.children].forEach(c=>c.classList.remove("selected"));
        li.classList.add("selected");
        $("btnAssassinate").classList.remove("hidden");
        $("btnAssassinate").disabled=false;
      };
    }
    ul.appendChild(li);
  });
  $("btnAssassinate").classList.toggle("hidden", !amAssassin || selected.size===0);
}
$("btnAssassinate").onclick = () => {
  const t=[...selected][0]; if(!t) return;
  socket.emit("assassinate",{playerId,code:S.code,targetId:t});
};

// ── 結果 ──
function renderEnd(){
  const t=$("endTitle");
  t.className = S.winner;
  t.textContent = S.winner==="good" ? "善（アーサー側）の勝利！" : "悪（モードレッド側）の勝利！";
  $("endReason").textContent = S.winReason||"";
  const ul=$("revealList"); ul.innerHTML="";
  (S.reveal||[]).forEach(p=>{
    const li=document.createElement("li");
    li.className=p.side;
    const r=ROLE_INFO[p.role];
    li.innerHTML=`<span>${esc(p.name)}</span><span class="r">${r?r.name:p.role}</span>`;
    ul.appendChild(li);
  });
  $("btnPlayAgain").classList.toggle("hidden", !S.youAreHost);
  $("endWait").textContent = S.youAreHost ? "" : "ホストが次のゲームを始めるのを待っています…";
}
$("btnPlayAgain").onclick = () => {
  selected.clear();
  $("btnReady").disabled=false;
  socket.emit("playAgain",{playerId,code:S.code});
};

// reset ready button when re-entering role screen
socket.on("state",()=>{ if(S && S.phase==="ROLE_REVEAL"){ /* keep */ } });

function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
