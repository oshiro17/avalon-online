// server.js — Express + Socket.IO
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const G = require("./game");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// メモリ上の全ルーム  code -> room
const rooms = {};
// 役職確認の ready 管理  code -> Set(playerId)
const readySets = {};
// socket.id -> {code, playerId}
const sessions = {};

function getRoom(code) {
  return code ? rooms[code.toUpperCase()] : null;
}

// 瞬断（Render無料枠のWebSocket切断など）で部屋が消えないように、
// 切断しても即削除せず、この時間だけ再接続を待つ。
const GRACE_MS = 60 * 1000;

// 再接続したらメンバー削除タイマーを取り消す
function clearRemoval(room, playerId) {
  const p = room && room.players.find((x) => x.id === playerId);
  if (p && p._removeTimer) {
    clearTimeout(p._removeTimer);
    p._removeTimer = null;
  }
}

// 切断後、猶予を置いてから席を整理する（その間に戻ってこなければ削除）
function scheduleRemoval(room, playerId) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return;
  if (p._removeTimer) clearTimeout(p._removeTimer);
  p._removeTimer = setTimeout(() => {
    const cur = room.players.find((x) => x.id === playerId);
    if (!cur || cur.connected) return; // 戻ってきたので何もしない
    // ロビー中だけ席を整理（人数調整しやすく）。進行中は席を残す。
    if (room.phase === "LOBBY") {
      room.players = room.players.filter((x) => x.id !== playerId);
      if (room.hostId === playerId && room.players.length > 0) {
        room.hostId = room.players[0].id;
      }
      if (room.players.length === 0) {
        delete rooms[room.code];
        delete readySets[room.code];
        return;
      }
    }
    if (rooms[room.code]) broadcast(room);
  }, GRACE_MS);
}

// プレイヤーごとに「自分視点」の安全な状態を作る（他人の役職は出さない）
function publicState(room, playerId) {
  const me = room.players.find((p) => p.id === playerId);
  const leader = room.players[room.leaderIndex];

  const base = {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    youAreHost: room.hostId === playerId,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, connected: p.connected,
      isLeader: p === leader,
      onTeam: room.team.includes(p.id),
      voted: room.votes.hasOwnProperty(p.id),
      acted: room.missionActions.hasOwnProperty(p.id),
    })),
    leaderId: leader ? leader.id : null,
    youAreLeader: leader ? leader.id === playerId : false,
    questIndex: room.questIndex,
    questResults: room.questResults,
    questPlays: room.questPlays || [],
    rejectCount: room.rejectCount,
    questTeamSizes: room.players.length >= 5
      ? G.QUEST_TEAM[room.players.length] : null,
    failsTable: room.players.length >= 5
      ? G.QUEST_TEAM[room.players.length].map((_, i) =>
          G.failsNeeded(room.players.length, i))
      : null,
    teamSize: (room.phase === "TEAM_BUILD" && room.players.length >= 5)
      ? G.teamSize(room) : null,
    you: me ? { id: me.id, name: me.name } : null,
  };

  // 役職フェーズ以降は自分の役職と見える情報を付与
  if (me && me.role && room.phase !== "LOBBY") {
    base.myRole = me.role;
    base.mySide = me.side;
    base.visibility = G.visibilityFor(room, me);
  }
  // 自分がチームに居て投票済みかどうか
  if (me) base.myVote = room.votes[me.id];
  if (me) base.onMyTeam = room.team.includes(me.id);

  // 直近の投票の開示結果（誰が賛成/反対したか）。投票結果は公開情報。
  base.lastVote = room._lastVote
    ? { approved: room._lastVote.approved, tally: room._lastVote.tally }
    : null;

  // 役職確認フェーズの進捗（誰がまだ「確認した」を押していないか）
  if (room.phase === "ROLE_REVEAL") {
    const rs = readySets[room.code] || new Set();
    base.readyIds = room.players.filter((p) => rs.has(p.id)).map((p) => p.id);
  }

  // 終了時は全役職公開
  if (room.phase === "END") {
    base.winner = room.winner;
    base.winReason = room.winReason;
    base.reveal = room.players.map((p) => ({
      name: p.name, role: p.role, side: p.side,
    }));
    base.assassinTarget = room.assassinTarget;
  }
  return base;
}

function broadcast(room) {
  room.players.forEach((p) => {
    if (p.socketId) {
      io.to(p.socketId).emit("state", publicState(room, p.id));
    }
  });
}

io.on("connection", (socket) => {
  // ── 部屋を作る ──
  socket.on("createRoom", ({ playerId, name }, cb) => {
    if (!name || !playerId) return cb && cb({ error: "名前が必要です" });
    const room = G.createRoom(playerId, name.slice(0, 12));
    rooms[room.code] = room;
    readySets[room.code] = new Set();
    room.players.push({
      id: playerId, name: name.slice(0, 12),
      connected: true, socketId: socket.id, role: null, side: null,
    });
    sessions[socket.id] = { code: room.code, playerId };
    cb && cb({ code: room.code });
    broadcast(room);
  });

  // ── 部屋に参加 ──
  socket.on("joinRoom", ({ playerId, name, code }, cb) => {
    const room = getRoom(code);
    if (!room) return cb && cb({ error: "その合言葉の部屋はありません" });

    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      // 再接続：削除予約をキャンセル
      clearRemoval(room, playerId);
      existing.connected = true;
      existing.socketId = socket.id;
      if (name) existing.name = name.slice(0, 12);
    } else {
      if (room.phase !== "LOBBY")
        return cb && cb({ error: "ゲームは既に始まっています" });
      if (room.players.length >= 10)
        return cb && cb({ error: "満員です（最大10人）" });
      if (!name) return cb && cb({ error: "名前が必要です" });
      room.players.push({
        id: playerId, name: name.slice(0, 12),
        connected: true, socketId: socket.id, role: null, side: null,
      });
    }
    sessions[socket.id] = { code: room.code, playerId };
    cb && cb({ code: room.code });
    broadcast(room);
  });

  // ── 明示的に状態を要求（リロード復帰用） ──
  socket.on("resume", ({ playerId, code }, cb) => {
    const room = getRoom(code);
    if (!room) return cb && cb({ error: "部屋が見つかりません" });
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return cb && cb({ error: "この部屋にあなたの席がありません" });
    clearRemoval(room, playerId); // 再接続：削除予約をキャンセル
    p.connected = true;
    p.socketId = socket.id;
    sessions[socket.id] = { code: room.code, playerId };
    cb && cb({ ok: true });
    socket.emit("state", publicState(room, playerId));
    broadcast(room);
  });

  // ── ゲーム開始（ホストのみ） ──
  socket.on("startGame", ({ playerId, code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== playerId) return;
    if (room.players.length < 5 || room.players.length > 10) return;
    readySets[room.code] = new Set();
    G.startGame(room);
    broadcast(room);
  });

  // ── 役職確認完了 ──
  socket.on("ready", ({ playerId, code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== "ROLE_REVEAL") return;
    readySets[room.code].add(playerId);
    if (G.allReady(room, readySets[room.code])) {
      G.beginTeamBuild(room);
    }
    broadcast(room);
  });

  // ── チーム提出（リーダーのみ） ──
  socket.on("submitTeam", ({ playerId, code, teamIds }) => {
    const room = getRoom(code);
    if (!room || room.phase !== "TEAM_BUILD") return;
    if (G.currentLeader(room).id !== playerId) return;
    if (teamIds.length !== G.teamSize(room)) return;
    G.submitTeam(room, teamIds);
    broadcast(room);
  });

  // ── チーム投票 ──
  socket.on("vote", ({ playerId, code, approve }) => {
    const room = getRoom(code);
    if (!room || room.phase !== "TEAM_VOTE") return;
    G.castVote(room, playerId, approve);
    if (G.allVoted(room)) {
      const res = G.resolveVote(room);
      room._lastVote = res; // 表示用
    }
    broadcast(room);
  });

  // ── ミッション実行（選抜メンバーのみ） ──
  socket.on("mission", ({ playerId, code, action }) => {
    const room = getRoom(code);
    if (!room || room.phase !== "MISSION") return;
    const ok = G.submitMissionAction(room, playerId, action);
    if (!ok) return;
    if (G.allMissionActed(room)) {
      const res = G.resolveMission(room);
      room._lastMission = res;
    }
    broadcast(room);
  });

  // ── 暗殺（暗殺者のみ） ──
  socket.on("assassinate", ({ playerId, code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== "ASSASSINATE") return;
    const me = room.players.find((p) => p.id === playerId);
    if (!me || me.role !== "assassin") return;
    G.resolveAssassination(room, targetId);
    broadcast(room);
  });

  // ── もう一度遊ぶ（ロビーに戻す・ホストのみ） ──
  socket.on("playAgain", ({ playerId, code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== playerId) return;
    room.phase = "LOBBY";
    room.questResults = [];
    room.questPlays = [];
    room.questIndex = 0;
    room.rejectCount = 0;
    room.winner = null;
    room.winReason = null;
    room.assassinTarget = null;
    room.players.forEach((p) => { p.role = null; p.side = null; });
    G.resetRound(room);
    readySets[room.code] = new Set();
    broadcast(room);
  });

  // ── 切断 ──
  socket.on("disconnect", () => {
    const s = sessions[socket.id];
    if (!s) return;
    const room = getRoom(s.code);
    if (room) {
      const p = room.players.find((x) => x.id === s.playerId);
      // 既に別ソケットで再接続済みなら、古いソケットのdisconnectは無視
      if (p && p.socketId === socket.id) {
        p.connected = false;
        p.socketId = null;
        // 即削除せず、猶予を置いて再接続を待つ（瞬断で部屋が消えるのを防ぐ）
        scheduleRemoval(room, s.playerId);
      }
      // 役職確認中に誰かが抜けたら、残りの接続者が全員確認済みなら開始する
      if (room.phase === "ROLE_REVEAL" && readySets[room.code]
          && G.allReady(room, readySets[room.code])) {
        G.beginTeamBuild(room);
      }
      if (rooms[room.code]) broadcast(room);
    }
    delete sessions[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Avalon server on :" + PORT));
