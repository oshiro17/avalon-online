// game.js — アヴァロンのゲームエンジン（DBなし・メモリ上で完結）
// フェーズ: LOBBY → ROLE_REVEAL → TEAM_BUILD → TEAM_VOTE → MISSION → (ASSASSINATE) → END

// ───────────────── 標準テーブル ─────────────────

// 人数ごとの [善, 悪] の数
const GOOD_EVIL = {
  5: [3, 2], 6: [4, 2], 7: [4, 3],
  8: [5, 3], 9: [6, 3], 10: [6, 4],
};

// 人数ごとの各クエストのチーム人数（クエスト1〜5）
const QUEST_TEAM = {
  5:  [2, 3, 2, 3, 3],
  6:  [2, 3, 4, 3, 4],
  7:  [2, 3, 3, 4, 4],
  8:  [3, 4, 4, 5, 5],
  9:  [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

// 7人以上では第4クエストのみ2フェイルで失敗
function failsNeeded(numPlayers, questIndex) {
  if (numPlayers >= 7 && questIndex === 3) return 2;
  return 1;
}

// ───────────────── ユーティリティ ─────────────────

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function genRoomCode() {
  // 紛らわしい文字を除いた4桁
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ───────────────── ルーム生成 ─────────────────

function createRoom(hostPlayerId, hostName) {
  return {
    code: genRoomCode(),
    phase: "LOBBY",
    hostId: hostPlayerId,
    players: [],          // {id, name, connected, role, side}
    // ゲーム進行
    leaderIndex: 0,       // players配列上のリーダー位置
    questIndex: 0,        // 0..4
    questResults: [],     // "success" | "fail"
    rejectCount: 0,       // 連続否決回数
    // 現クエストの一時状態
    team: [],             // 選抜されたplayerIdの配列
    votes: {},            // playerId -> true/false
    missionActions: {},   // playerId -> "success"|"fail"
    // 終了情報
    winner: null,         // "good" | "evil"
    winReason: null,
    assassinTarget: null,
  };
}

// ───────────────── 役職配布 ─────────────────

function assignRoles(room) {
  const n = room.players.length;
  const [goodCount, evilCount] = GOOD_EVIL[n];

  // シンプル版固定役: 善=マーリン,パーシヴァル + 忠臣 / 悪=モルガナ,暗殺者 + ミニオン
  const goodRoles = ["merlin", "percival"];
  while (goodRoles.length < goodCount) goodRoles.push("loyal");
  const evilRoles = ["morgana", "assassin"];
  while (evilRoles.length < evilCount) evilRoles.push("minion");

  const allRoles = shuffle(goodRoles.concat(evilRoles));
  room.players.forEach((p, i) => {
    p.role = allRoles[i];
    p.side = goodRoles.includes(p.role) || p.role === "loyal"
      ? "good" : "evil";
    // sideは役職から直接判定した方が安全
    p.side = ["merlin", "percival", "loyal"].includes(p.role) ? "good" : "evil";
  });
}

// 各プレイヤーが「見える情報」を返す（夜フェーズの確認）
function visibilityFor(room, player) {
  const others = room.players.filter((p) => p.id !== player.id);
  switch (player.role) {
    case "merlin": {
      // 悪が全員見える（このシンプル版ではモードレッド無しなので全悪可視）
      const evils = others.filter((p) => p.side === "evil").map((p) => p.name);
      return { text: "あなたに見えている悪の陣営：", names: shuffle(evils) };
    }
    case "percival": {
      // マーリンとモルガナが、どちらか分からない形で2人見える
      const targets = others
        .filter((p) => p.role === "merlin" || p.role === "morgana")
        .map((p) => p.name);
      return {
        text: "この2人のどちらかがマーリンです：",
        names: shuffle(targets),
      };
    }
    case "morgana":
    case "assassin":
    case "minion": {
      // 悪は仲間が見える（オベロン無しなので全悪相互可視）
      const allies = others.filter((p) => p.side === "evil").map((p) => p.name);
      return { text: "あなたの悪の仲間：", names: shuffle(allies) };
    }
    default: // loyal
      return { text: "あなたは何も知りません。推理で善を勝たせましょう。", names: [] };
  }
}

// ───────────────── 進行ロジック ─────────────────

function currentLeader(room) {
  return room.players[room.leaderIndex];
}

function startGame(room) {
  assignRoles(room);
  room.phase = "ROLE_REVEAL";
  room.leaderIndex = Math.floor(Math.random() * room.players.length);
  room.questIndex = 0;
  room.questResults = [];
  room.rejectCount = 0;
  resetRound(room);
}

function resetRound(room) {
  room.team = [];
  room.votes = {};
  room.missionActions = {};
}

// 接続中の人が全員確認を終えたらチーム編成へ。
// 切断中の人は確認しようがないので待たない（全員不在の時だけ不成立）。
function allReady(room, readySet) {
  const present = room.players.filter((p) => p.connected);
  return present.length > 0 && present.every((p) => readySet.has(p.id));
}

function beginTeamBuild(room) {
  room.phase = "TEAM_BUILD";
  resetRound(room);
}

function teamSize(room) {
  return QUEST_TEAM[room.players.length][room.questIndex];
}

function submitTeam(room, teamIds) {
  room.team = teamIds.slice();
  room.votes = {};
  room._lastVote = null; // 新しい投票が始まるので前回の開示結果は消す
  room.phase = "TEAM_VOTE";
}

function castVote(room, playerId, approve) {
  room.votes[playerId] = !!approve;
}

function allVoted(room) {
  return room.players.every((p) => room.votes.hasOwnProperty(p.id));
}

// 投票集計 → 承認ならMISSION、否決ならリーダー交代
function resolveVote(room) {
  const approvals = room.players.filter((p) => room.votes[p.id]).length;
  const approved = approvals > room.players.length / 2;
  const tally = room.players.map((p) => ({
    id: p.id, name: p.name, approve: !!room.votes[p.id],
  }));

  if (approved) {
    room.rejectCount = 0;
    room.phase = "MISSION";
    room.missionActions = {};
    return { approved: true, tally };
  } else {
    room.rejectCount += 1;
    if (room.rejectCount >= 5) {
      room.phase = "END";
      room.winner = "evil";
      room.winReason = "チーム編成が5連続で否決されました（悪の勝利）";
      return { approved: false, tally, gameOver: true };
    }
    room.leaderIndex = (room.leaderIndex + 1) % room.players.length;
    room.phase = "TEAM_BUILD";
    return { approved: false, tally, gameOver: false };
  }
}

function submitMissionAction(room, playerId, action) {
  if (!room.team.includes(playerId)) return false;
  // 善は成功しか出せない。悪は選択可。
  const p = room.players.find((x) => x.id === playerId);
  if (p.side === "good") action = "success";
  room.missionActions[playerId] = action;
  return true;
}

function allMissionActed(room) {
  return room.team.every((id) => room.missionActions.hasOwnProperty(id));
}

// ミッション集計 → 勝敗判定/暗殺/次クエスト
function resolveMission(room) {
  const fails = room.team.filter((id) => room.missionActions[id] === "fail").length;
  const need = failsNeeded(room.players.length, room.questIndex);
  const success = fails < need;

  room.questResults.push(success ? "success" : "fail");
  const result = { fails, need, success, questIndex: room.questIndex };

  const successes = room.questResults.filter((r) => r === "success").length;
  const failures = room.questResults.filter((r) => r === "fail").length;

  if (failures >= 3) {
    room.phase = "END";
    room.winner = "evil";
    room.winReason = "3つのクエストが失敗しました（悪の勝利）";
    result.gameOver = true;
    return result;
  }
  if (successes >= 3) {
    // 善が3勝 → 暗殺フェーズへ
    room.phase = "ASSASSINATE";
    result.toAssassinate = true;
    return result;
  }
  // 次のクエストへ
  room.questIndex += 1;
  room.leaderIndex = (room.leaderIndex + 1) % room.players.length;
  room.phase = "TEAM_BUILD";
  resetRound(room);
  return result;
}

// 暗殺者がマーリンを指す
function resolveAssassination(room, targetId) {
  const target = room.players.find((p) => p.id === targetId);
  room.assassinTarget = targetId;
  room.phase = "END";
  if (target && target.role === "merlin") {
    room.winner = "evil";
    room.winReason = "暗殺者がマーリンを討ち取りました（悪の逆転勝利）";
  } else {
    room.winner = "good";
    room.winReason = "暗殺者はマーリンを外しました（善の勝利）";
  }
  return { targetName: target ? target.name : "?", winner: room.winner };
}

module.exports = {
  GOOD_EVIL, QUEST_TEAM, failsNeeded,
  createRoom, genRoomCode,
  startGame, assignRoles, visibilityFor,
  currentLeader, beginTeamBuild, teamSize, submitTeam,
  castVote, allVoted, resolveVote,
  submitMissionAction, allMissionActed, resolveMission,
  resolveAssassination, allReady, resetRound,
};
