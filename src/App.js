
import React, { useEffect, useMemo, useState } from "react";
import { ref, onValue, set, update, runTransaction } from "firebase/database";
import { db } from "./firebase";

/** ========= PRD 常量 ========= */
const ADMIN_PASSWORD = "ennebei";
const UNANSWERED_PENALTY_MS = 120000;

const LS_PARTICIPANT_ID = "quiz_participant_id";
const LS_DEVICE_ID = "quiz_device_id";

/** ========= 题库（示例） ========= */
const allQuestions = [
  {
    id: 1,
    question:
      "以下哪个是 JavaScript 的原始数据类型？\nWhich of the following is a primitive data type in JavaScript?",
    options: [
      { id: "A", text: "Array" },
      { id: "B", text: "Object" },
      { id: "C", text: "Symbol" },
      { id: "D", text: "Function" },
    ],
    correctAnswer: "C",
  },
  {
    id: 2,
    question:
      "React 中，以下哪个 Hook 用于处理副作用？\nIn React, which Hook is used to handle side effects?",
    options: [
      { id: "A", text: "useState" },
      { id: "B", text: "useEffect" },
      { id: "C", text: "useContext" },
      { id: "D", text: "useMemo" },
    ],
    correctAnswer: "B",
  },
  {
    id: 3,
    question: "HTTP 状态码 404 表示什么？\nWhat does HTTP status code 404 mean?",
    options: [
      { id: "A", text: "服务器错误 Server Error" },
      { id: "B", text: "请求成功 Request Successful" },
      { id: "C", text: "资源未找到 Resource Not Found" },
      { id: "D", text: "重定向 Redirect" },
    ],
    correctAnswer: "C",
  },
  {
    id: 4,
    question:
      "CSS 中，哪个属性用于设置弹性布局？\nIn CSS, which property is used to set flex layout?",
    options: [
      { id: "A", text: "display: block" },
      { id: "B", text: "display: flex" },
      { id: "C", text: "display: grid" },
      { id: "D", text: "display: inline" },
    ],
    correctAnswer: "B",
  },
];

/** ========= 工具函数 ========= */
const now = () => Date.now();
const normalizeName = (s) => (s || "").trim();
const normalizeNameKey = (s) => normalizeName(s).toLowerCase();
const normalizeRecoveryCode = (s) => (s || "").trim().toUpperCase();

function formatMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "-";
  const sec = Math.floor(ms / 1000);
  const d = Math.floor((ms % 1000) / 100);
  return `${sec}.${d}s`;
}

function randomId(len = 18) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function getOrCreateDeviceId() {
  let did = localStorage.getItem(LS_DEVICE_ID);
  if (!did) {
    did = `d_${randomId(24)}`;
    localStorage.setItem(LS_DEVICE_ID, did);
  }
  return did;
}

function generateParticipantId() {
  return `p_${now().toString(36)}_${randomId(8)}`;
}

function generateRecoveryCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

/** ========= 初始数据（含 deviceIndex） ========= */
function buildInitialData(totalQuestions) {
  return {
    quizStatus: "running",
    stoppedAt: null,
    currentQuestionIndex: 0,
    totalQuestions,

    users: {},
    userNameIndex: {},
    recoveryCodeIndex: {},
    deviceIndex: {},

    startTimes: {},
    submissions: {},
  };
}

/** ========= 排行榜（Running vs Final） ========= */
function computeLeaderboard({ users, submissions }, totalQuestions, { includePenalty }) {
  const questions = allQuestions.slice(0, totalQuestions);

  const userEntries = Object.entries(users || {}).map(([participantId, u]) => ({
    participantId,
    userName: u.userName,
    createdAt: u.createdAt || 0,
  }));

  const subs = submissions || {};

  const rows = userEntries.map((u) => {
    let answeredCount = 0;
    let correctCount = 0;
    let liveTime = 0;

    for (const q of questions) {
      const key = `${u.participantId}_${q.id}`;
      const s = subs[key];
      if (s) {
        answeredCount += 1;
        liveTime += Number(s.duration || 0);
        if (s.isCorrect) correctCount += 1;
      }
    }

    const unansweredCount = totalQuestions - answeredCount;
    const penalty = includePenalty ? unansweredCount * UNANSWERED_PENALTY_MS : 0;

    const accuracy = totalQuestions > 0 ? correctCount / totalQuestions : 0;
    const totalTime = liveTime + penalty;

    return {
      participantId: u.participantId,
      userName: u.userName,
      createdAt: u.createdAt,
      answeredCount,
      unansweredCount,
      correctCount,
      accuracy,
      liveTime,
      totalTime,
    };
  });

  rows.sort((a, b) => {
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    if (a.totalTime !== b.totalTime) return a.totalTime - b.totalTime;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  let rank = 0;
  let lastKey = null;
  return rows.map((r, i) => {
    const k = `${r.accuracy}-${r.totalTime}`;
    if (k !== lastKey) {
      rank = i + 1;
      lastKey = k;
    }
    return { ...r, rank };
  });
}

/** ========= App ========= */
export default function App() {
  const totalQuestions = allQuestions.length;
  const initialData = useMemo(() => buildInitialData(totalQuestions), [totalQuestions]);

  const [data, setData] = useState(initialData);
  const [isConnected, setIsConnected] = useState(false);

  const [mode, setMode] = useState("participant");
  const [participantScreen, setParticipantScreen] = useState("entry");

  const [participantId, setParticipantId] = useState("");
  const [user, setUser] = useState(null);

  const [deviceHit, setDeviceHit] = useState(null);

  const [adminLoginOpen, setAdminLoginOpen] = useState(false);
  const [recoveryModal, setRecoveryModal] = useState({ open: false, code: "" });

  const [exitStep1Open, setExitStep1Open] = useState(false);
  const [exitStep2Open, setExitStep2Open] = useState(false);
  const [exitClearDevice, setExitClearDevice] = useState(false);

  useEffect(() => {
    const rootRef = ref(db, "/");
    const unsub = onValue(rootRef, (snap) => {
      const val = snap.val();
      if (!val) {
        set(rootRef, initialData);
        setData(initialData);
        setIsConnected(true);
        return;
      }
      setData({
        quizStatus: val.quizStatus ?? "running",
        stoppedAt: val.stoppedAt ?? null,
        currentQuestionIndex: val.currentQuestionIndex ?? 0,
        totalQuestions: val.totalQuestions ?? totalQuestions,

        users: val.users ?? {},
        userNameIndex: val.userNameIndex ?? {},
        recoveryCodeIndex: val.recoveryCodeIndex ?? {},
        deviceIndex: val.deviceIndex ?? {},

        startTimes: val.startTimes ?? {},
        submissions: val.submissions ?? {},
      });
      setIsConnected(true);
    });
    return () => unsub();
  }, [initialData, totalQuestions]);

  useEffect(() => {
    const savedPid = localStorage.getItem(LS_PARTICIPANT_ID);
    if (savedPid && data.users?.[savedPid]) {
      setParticipantId(savedPid);
      setUser({ participantId: savedPid, ...data.users[savedPid] });
      return;
    }
    if (savedPid && !data.users?.[savedPid]) {
      localStorage.removeItem(LS_PARTICIPANT_ID);
    }
    setParticipantId("");
    setUser(null);
  }, [data.users]);

  useEffect(() => {
    const did = getOrCreateDeviceId();
    if (localStorage.getItem(LS_PARTICIPANT_ID)) {
      setDeviceHit(null);
      return;
    }
    const hitPid = data.deviceIndex?.[did];
    if (hitPid && data.users?.[hitPid]) {
      setDeviceHit({ participantId: hitPid, userName: data.users[hitPid].userName });
    } else {
      setDeviceHit(null);
    }
  }, [data.deviceIndex, data.users]);

  const isStopped = data.quizStatus === "stopped";
  const isNaturalEnded = data.quizStatus === "running" && data.currentQuestionIndex >= totalQuestions;
  const isInProgress = data.quizStatus === "running" && data.currentQuestionIndex < totalQuestions;

  const currentQuestion =
    data.currentQuestionIndex >= 0 && data.currentQuestionIndex < totalQuestions
      ? allQuestions[data.currentQuestionIndex]
      : null;

  const leaderboardLive = useMemo(
    () => computeLeaderboard({ users: data.users, submissions: data.submissions }, totalQuestions, { includePenalty: false }),
    [data.users, data.submissions, totalQuestions]
  );

  const leaderboardFinal = useMemo(
    () => computeLeaderboard({ users: data.users, submissions: data.submissions }, totalQuestions, { includePenalty: true }),
    [data.users, data.submissions, totalQuestions]
  );

  const myFinalRow = useMemo(() => {
    if (!participantId) return null;
    return leaderboardFinal.find((r) => r.participantId === participantId) || null;
  }, [leaderboardFinal, participantId]);

  async function ensureStartTime(pid) {
    if (!pid) return;
    if (data.quizStatus !== "running") return;
    if (!currentQuestion) return;

    const qid = currentQuestion.id;
    const subKey = `${pid}_${qid}`;
    if (data.submissions?.[subKey]) return;

    const stKey = `${pid}_${qid}`;
    const stRef = ref(db, `/startTimes/${stKey}`);
    await runTransaction(stRef, (cur) => (cur === null ? now() : cur)).catch(() => {});
  }

  async function enterQuiz() {
    setParticipantScreen("quiz");
    await ensureStartTime(participantId);
  }

  async function reserveRecoveryCodeUnique() {
    for (let i = 0; i < 12; i++) {
      const code = generateRecoveryCode();
      const idxRef = ref(db, `/recoveryCodeIndex/${code}`);
      const tx = await runTransaction(idxRef, (cur) => {
        if (cur === null) return "__RESERVED__";
        return undefined;
      });
      if (tx.committed && tx.snapshot.val() === "__RESERVED__") return code;
    }
    throw new Error("reserve recovery code failed");
  }

  async function register(userNameRaw) {
    const name = normalizeName(userNameRaw);
    const key = normalizeNameKey(name);
    if (!name) return { ok: false, reason: "EMPTY", message: "请输入昵称 / Please enter a nickname." };

    const existingPid = data.userNameIndex?.[key];
    if (existingPid) {
      return {
        ok: false,
        reason: "NAME_EXISTS",
        message: `欢迎回来，${name} 已存在。你可以使用恢复码找回身份，或更换昵称重新参与。`,
      };
    }

    const pid = generateParticipantId();
    const createdAt = now();
    const did = getOrCreateDeviceId();

    const userNameIdxRef = ref(db, `/userNameIndex/${key}`);
    const tx = await runTransaction(userNameIdxRef, (cur) => (cur === null ? pid : undefined));
    if (!tx.committed) {
      return {
        ok: false,
        reason: "NAME_EXISTS",
        message: `欢迎回来，${name} 已存在。你可以使用恢复码找回身份，或更换昵称重新参与。`,
      };
    }

    let code;
    try {
      code = await reserveRecoveryCodeUnique();
    } catch (e) {
      await runTransaction(userNameIdxRef, (cur) => (cur === pid ? null : cur));
      return { ok: false, reason: "BUSY", message: "系统繁忙，请重试 / Please retry." };
    }

    const userObj = { userName: name, recoveryCode: code, createdAt };

    await update(ref(db, "/"), {
      [`users/${pid}`]: userObj,
      [`recoveryCodeIndex/${code}`]: pid,
      [`deviceIndex/${did}`]: pid,
    });

    localStorage.setItem(LS_PARTICIPANT_ID, pid);
    setParticipantId(pid);
    setUser({ participantId: pid, ...userObj });

    setRecoveryModal({ open: true, code });
    setParticipantScreen("entry");

    return { ok: true };
  }

  async function recoverByCode(codeRaw) {
    const code = normalizeRecoveryCode(codeRaw);
    if (!code) return { ok: false, message: "请输入恢复码 / Please enter recovery code." };

    const pid = data.recoveryCodeIndex?.[code];
    if (!pid) return { ok: false, message: "恢复码无效 / Invalid recovery code." };

    const u = data.users?.[pid];
    if (!u) return { ok: false, message: "用户不存在或已被重置 / User not found." };

    const did = getOrCreateDeviceId();
    await update(ref(db, "/"), {
      [`deviceIndex/${did}`]: pid,
    });

    localStorage.setItem(LS_PARTICIPANT_ID, pid);
    setParticipantId(pid);
    setUser({ participantId: pid, ...u });
    setParticipantScreen("entry");

    return { ok: true };
  }

  async function confirmDeviceEntry() {
    if (!deviceHit) return;
    const pid = deviceHit.participantId;
    const u = data.users?.[pid];
    if (!u) return;

    localStorage.setItem(LS_PARTICIPANT_ID, pid);
    setParticipantId(pid);
    setUser({ participantId: pid, ...u });
    setParticipantScreen("entry");
  }

  async function submitAnswer(answerId) {
    if (!participantId || !user) return { ok: false, message: "未登录 / Not logged in." };
    if (data.quizStatus !== "running") return { ok: false, message: "问卷已关闭 / Closed." };
    if (!currentQuestion) return { ok: false, message: "当前无题目 / No question." };

    const q = currentQuestion;
    const key = `${participantId}_${q.id}`;

    const stKey = `${participantId}_${q.id}`;
    const st = data.startTimes?.[stKey];
    const startTime = st ?? now();
    const submitTime = now();
    const duration = Math.max(0, submitTime - startTime);

    const submission = {
      participantId,
      userName: user.userName,
      questionId: q.id,
      answer: answerId,
      isCorrect: answerId === q.correctAnswer,
      startTime,
      submitTime,
      duration,
    };

    const subRef = ref(db, `/submissions/${key}`);
    const tx = await runTransaction(subRef, (cur) => (cur === null ? submission : undefined));

    if (!tx.committed) return { ok: false, message: "已提交过 / Already submitted." };
    return { ok: true };
  }

  async function doExitFinal() {
    const did = localStorage.getItem(LS_DEVICE_ID);

    localStorage.removeItem(LS_PARTICIPANT_ID);
    setParticipantId("");
    setUser(null);
    setParticipantScreen("entry");
    setMode("participant");

    if (exitClearDevice && did) {
      localStorage.removeItem(LS_DEVICE_ID);
      await update(ref(db, "/"), { [`deviceIndex/${did}`]: null });
    }

    setExitClearDevice(false);
    setExitStep2Open(false);
  }

  async function adminNext() {
    if (data.quizStatus !== "running") return;
    const next = Math.min(data.currentQuestionIndex + 1, totalQuestions);
    await update(ref(db, "/"), { currentQuestionIndex: next });
  }

  async function adminStop() {
    await update(ref(db, "/"), { quizStatus: "stopped", stoppedAt: now() });
  }

  async function adminReset() {
    if (!window.confirm("确认 Reset？会清空所有用户/提交/索引。")) return;
    await set(ref(db, "/"), buildInitialData(totalQuestions));
  }

  const participantView = useMemo(() => {
    if (mode !== "participant") return null;

    if (isStopped) return { type: "closed" };
    if (isNaturalEnded) return { type: "thanks" };

    if (!user || !participantId) {
      return { type: participantScreen === "auth" ? "auth" : "entry" };
    }

    return { type: participantScreen === "quiz" ? "quiz" : "entry" };
  }, [mode, isStopped, isNaturalEnded, user, participantId, participantScreen]);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <TopBar
        isConnected={isConnected}
        mode={mode}
        user={user}
        onOpenAdmin={() => setAdminLoginOpen(true)}
        onBackParticipant={() => setMode("participant")}
      />

      {adminLoginOpen && (
        <AdminLoginModal
          onClose={() => setAdminLoginOpen(false)}
          onSuccess={() => {
            setAdminLoginOpen(false);
            setMode("admin");
          }}
        />
      )}

      {recoveryModal.open && (
        <RecoveryCodeModal
          code={recoveryModal.code}
          onConfirm={async () => {
            setRecoveryModal({ open: false, code: "" });
            await enterQuiz();
          }}
        />
      )}

      {exitStep1Open && (
        <ConfirmModal
          title="确认退出？"
          description="退出将清除本设备参与者身份。跨设备/清缓存需用恢复码找回。"
          confirmText="继续退出"
          cancelText="取消"
          onCancel={() => setExitStep1Open(false)}
          onConfirm={() => {
            setExitStep1Open(false);
            setExitStep2Open(true);
          }}
        />
      )}

      {exitStep2Open && (
        <ExitFinalModal
          code={user?.recoveryCode || ""}
          clearDevice={exitClearDevice}
          onToggleClearDevice={() => setExitClearDevice((v) => !v)}
          onCancel={() => {
            setExitClearDevice(false);
            setExitStep2Open(false);
          }}
          onConfirm={doExitFinal}
        />
      )}

      {mode === "admin" ? (
        <AdminDashboard
          data={data}
          questions={allQuestions}
          leaderboardLive={leaderboardLive}
          leaderboardFinal={leaderboardFinal}
          isInProgress={isInProgress}
          onBack={() => setMode("participant")}
          onNext={adminNext}
          onStop={adminStop}
          onReset={adminReset}
        />
      ) : (
        <ParticipantRouter
          view={participantView}
          data={data}
          user={user}
          participantId={participantId}
          deviceHit={deviceHit}
          currentQuestion={currentQuestion}
          totalQuestions={totalQuestions}
          leaderboardFinal={leaderboardFinal}
          myFinalRow={myFinalRow}
          onStart={() => setParticipantScreen("auth")}
          onEnterQuiz={enterQuiz}
          onSwitchAccount={() => setParticipantScreen("auth")}
          onConfirmDeviceEntry={confirmDeviceEntry}
          onRegister={register}
          onRecover={recoverByCode}
          onSubmit={submitAnswer}
          onExit={() => setExitStep1Open(true)}
        />
      )}
    </div>
  );
}

/** ================= UI Components ================= */

function TopBar({ isConnected, mode, user, onOpenAdmin, onBackParticipant }) {
  return (
    <div className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="text-sm font-semibold">Realtime Quiz</div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className={`inline-block h-2 w-2 rounded-full ${isConnected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"}`} />
            {isConnected ? "Online" : "Connecting"}
          </div>
          {mode === "admin" && (
            <span className="ml-2 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-300">
              Admin
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {mode === "admin" ? (
            <button
              onClick={onBackParticipant}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              返回参与者端
            </button>
          ) : (
            <>
              {user ? <div className="hidden sm:block text-sm text-slate-300">{user.userName}</div> : null}
              <button
                onClick={onOpenAdmin}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
              >
                管理员
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ParticipantRouter({
  view,
  data,
  user,
  participantId,
  deviceHit,
  currentQuestion,
  totalQuestions,
  leaderboardFinal,
  myFinalRow,
  onStart,
  onEnterQuiz,
  onSwitchAccount,
  onConfirmDeviceEntry,
  onRegister,
  onRecover,
  onSubmit,
  onExit,
}) {
  if (!view) return null;

  if (view.type === "entry") {
    return (
      <EntryPage
        data={data}
        totalQuestions={totalQuestions}
        user={user}
        deviceHit={deviceHit}
        onStart={onStart}
        onEnterQuiz={onEnterQuiz}
        onSwitchAccount={onSwitchAccount}
        onConfirmDeviceEntry={onConfirmDeviceEntry}
        onExit={onExit}
      />
    );
  }

  if (view.type === "auth") {
    return <AuthPage onBack={() => onStart()} onRegister={onRegister} onRecover={onRecover} />;
  }

  if (view.type === "quiz") {
    return (
      <QuizPage
        data={data}
        participantId={participantId}
        user={user}
        currentQuestion={currentQuestion}
        totalQuestions={totalQuestions}
        onSubmit={onSubmit}
        onExit={onExit}
      />
    );
  }

  if (view.type === "thanks") {
    return <EndPage kind="thanks" leaderboard={leaderboardFinal} myRow={myFinalRow} totalQuestions={totalQuestions} onExit={onExit} />;
  }

  if (view.type === "closed") {
    return <EndPage kind="closed" leaderboard={leaderboardFinal} myRow={myFinalRow} totalQuestions={totalQuestions} onExit={onExit} />;
  }

  return null;
}

function EntryPage({ data, totalQuestions, user, deviceHit, onStart, onEnterQuiz, onSwitchAccount, onConfirmDeviceEntry, onExit }) {
  const statusText =
    data.quizStatus === "stopped"
      ? "问卷已关闭 / Closed"
      : data.currentQuestionIndex >= totalQuestions
      ? "已完成 / Finished"
      : "进行中 / Running";

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">参与答题</h1>
            <p className="mt-1 text-sm text-slate-400">状态：{statusText}</p>
          </div>
          {(user || deviceHit) ? (
            <button
              onClick={onExit}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              退出
            </button>
          ) : null}
        </div>

        <div className="mt-6 space-y-2 text-sm text-slate-300">
          <div>计时起点：进入答题页后才开始（新用户需先确认保存恢复码）。</div>
          <div>进行中榜单：仅累计已作答耗时；结束/Stop 后才加未答 120s/题惩罚。</div>
        </div>

        {user ? (
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm text-slate-200">
              欢迎回来：<span className="font-semibold">{user.userName}</span>
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={onEnterQuiz} className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 font-semibold hover:bg-indigo-500">
                继续进入
              </button>
              <button
                onClick={onSwitchAccount}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-semibold text-slate-200 hover:bg-slate-800"
              >
                切换账号
              </button>
            </div>
          </div>
        ) : deviceHit ? (
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm text-slate-200">
              检测到你可能是：<span className="font-semibold">{deviceHit.userName}</span>，直接进入？
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={onConfirmDeviceEntry}
                className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 font-semibold hover:bg-indigo-500"
              >
                继续进入
              </button>
              <button
                onClick={onStart}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-semibold text-slate-200 hover:bg-slate-800"
              >
                不是我（切换账号）
              </button>
            </div>
          </div>